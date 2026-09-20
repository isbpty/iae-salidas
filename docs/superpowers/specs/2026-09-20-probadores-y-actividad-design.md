# Probadores con PIN, registro de actividad y panel "Actividad" — diseño

Fecha: 2026-09-20 · Estado: aprobado por el usuario en chat (secciones 1–4).

## Objetivo

Que 10 personas reales ("probadores") prueben el piloto con un PIN propio, y que el super admin vea
qué hace cada una, por cuánto tiempo y dónde se atasca, con un registro técnico suficiente para
depurar "zonas calientes" después.

## 1 · Probadores y PINs

- Tabla `testers`: `id` (`t1`..`t10`), `name`, `pin_hash` (scrypt con sal, formato `scrypt$<sal hex>$<hash hex>`),
  `super` boolean, `active` boolean, `created_at`.
- PINs de 6 dígitos aleatorios. Se guardan solo como hash. Se devuelven en claro **una sola vez**: en la
  respuesta del comando que los crea o regenera.
- `t1` = "Super admin" con `super: true`. Es el único que ve la pestaña "Actividad" (y solo al entrar con un
  usuario de rol `admin`). No cambia permisos funcionales de ningún rol.
- Comandos (rol `admin`):
  - `create_testers`: crea `t1..t10` si la tabla está vacía y devuelve `[{ id, name, pin }]`. Permitido con
    sesión compartida solo mientras no exista ningún probador; después exige `super`.
  - `regenerate_tester_pin { testerId }`: exige `super`; devuelve `{ id, name, pin }`.
  - `rename_tester { testerId, name }`: exige `super`.
- Los probadores **sobreviven** a `reset_demo` y `seed_load` (no están en las tablas de movimiento).
- Login en dos pasos, misma pantalla:
  1. `POST /api/auth/pin { pin }` → identifica al probador (o al PIN compartido `PILOT_PIN`) y devuelve
     `{ tester: { id, name, super } | null, pinToken, options }`. `pinToken` es HMAC con vida de 10 min.
  2. `POST /api/auth/login { userId, pinToken }` → cookie `iae_session` con `{ userId, testerId, super, sid, exp }`.
     `sid` es un id aleatorio nuevo por login.
  - Compatibilidad: `POST /api/auth/login { userId, pin }` sigue funcionando en un paso (resuelve el
    probador a partir del PIN). Lo usa la prueba de carga.
  - `POST /api/auth/switch { userId }` con sesión válida: nueva cookie con el mismo `testerId`/`sid` y otro
    usuario. Evento `switch_user`.
  - PIN compartido: `PILOT_PIN` sigue vigente salvo `PILOT_PIN_SHARED=false`. Sesión con `testerId: null`;
    el panel lo muestra como "Compartido".
  - Bloqueo de intentos: paso 1 por IP; paso 2 y login de un paso por IP y por `userId` (como hoy).

## 2 · Registro de actividad

- Tabla `activity_events` (append-only): `id bigserial`, `at timestamptz`, `tester_id`, `user_id`, `role`,
  `sid`, `source` (`server`|`client`), `kind`, `name`, `screen`, `target`, `duration_ms integer`, `ok boolean`,
  `error text`, `status integer`, `revision integer`, `ip`, `ua`, `data jsonb`.
  Índices: `(tester_id, at)`, `(sid, at)`, `(kind, name, at)`.
- **Servidor**: un envoltorio en `app.js` cronometra cada petición `/api/*` y escribe un evento al terminar:
  `kind` ∈ `login | login_failed | logout | switch_user | view | command | attachment | telemetry | activity | error`,
  `name` = comando o ruta, `duration_ms`, `status`, `ok` (2xx/3xx), `error` (código de dominio o HTTP),
  `revision`, `data` = entrada del comando enmascarada (`cedula`, `phone`, `pin`, `pinToken` → `***`;
  `dataBase64`/`bytes` → longitud; strings > 200 chars truncadas). Las respuestas 304 del sondeo no se registran (un INSERT cada 3 s por dispositivo sin información nueva).
  La escritura va en `try/catch` propio: si falla, se pierde el evento, nunca la petición. Las peticiones
  de `telemetry` y `activity/*` no se registran (evitan ruido).
- **Cliente**: `public/client/telemetry.js` (se carga antes de `state.js`). Registra:
  - `screen_enter` / `screen_leave` (con `duration_ms`) para `parent:<tab>`, `school:<tab>`, `whatsapp`, `log`;
  - `modal_open` / `modal_close` (con `duration_ms` y `data.abandoned`);
  - `click` sobre `[data-action]` con `name = data-action` y `data = data-*`;
  - `form_submit` / `form_abandon` (modal de formulario cerrado con campos escritos y sin enviar);
  - `js_error` / `promise_rejection` (mensaje + primeras líneas del stack);
  - `visibility` (`hidden`/`visible`); mientras está oculto el reloj de pantalla se pausa;
  - `session_end` al cerrar la pestaña (`sendBeacon`).
  - Lotes: cada 5 s o al llegar a 20 eventos → `POST /api/telemetry { events }` (máximo 100 por lote;
    `fetch` con `keepalive`). El servidor sella `tester_id`, `user_id`, `role`, `sid`, `ip`, `ua` desde la cookie
    e ignora cualquiera de esos campos que venga del cliente. Sin sesión: 401 y el cliente vacía la cola.
- **Sesiones derivadas**: una sesión es un `sid`; si entre dos eventos pasan más de 10 min, se parte en
  segmentos. Duración activa = suma de segmentos (último − primero).
- Retención: comando `purge_activity { beforeDays }` (admin + `super`); `reset_demo` y `seed_load` vacían la
  tabla. `audit_log` no cambia.

## 3 · Panel "Actividad" (solo super)

- API (todas exigen `super` en la cookie; 403 si no):
  - `GET /api/activity/summary?from&to&testerId&userId&role&errorsOnly` →
    `{ testers: [{ id, name, lastAt, sessions, activeMs, actions, errors, online }], screens: [{ screen, visits, totalMs }],
       actions: [{ name, count, p50, p95, errors }], errors: [{ error, name, count, lastAt, testers: [name] }],
       abandons: [{ name, count }], totals: { events, sessions, activeMs } }`.
    `online` = evento en los últimos 2 min.
  - `GET /api/activity/events?from&to&testerId&userId&sid&kind&q&before&limit` → `{ events, nextBefore }`
    (orden `id DESC`, `limit` ≤ 200, `q` busca en `name`, `screen`, `error` y `data::text`).
  - `GET /api/activity/export.csv?…` mismos filtros que `events`, sin paginar (máximo 20 000 filas).
  - `GET /api/activity/testers` → probadores con `id`, `name`, `super`, `active`, `createdAt` (sin hash).
- UI (`public/client/activity.js`): pestaña "📊 Actividad" en el menú lateral de escuela cuando `V.user.super`.
  Cabecera con filtros (hoy / 7 días / 30 días / personalizado, probador, usuario, rol, solo errores).
  Bloques: Probadores (tarjetas con semáforo), Zonas calientes (pantallas, acciones con p50/p95, errores,
  abandonos), Línea de tiempo (por probador o sesión, buscador, botón "Copiar JSON"), Exportar CSV,
  y gestión de probadores (renombrar, regenerar PIN mostrando el nuevo una sola vez).
  Refresco cada 10 s solo mientras la pestaña está abierta. Sin librerías externas: barras CSS y tablas.
- `buildView` no cambia; `app.js` añade a la vista `user.super` y `tester: { id, name }` a partir de la cookie.

## 4 · Pruebas y despliegue

- Tests (`node:test`): hash/verificación de PIN; `create_testers` (una vez con compartido, luego exige super);
  `regenerate_tester_pin`; login en dos pasos, un paso y `switch`; bloqueo por intentos en paso 1;
  el envoltorio registra login, comando con error de dominio, vista 304 y adjunto con `duration_ms`;
  `/api/telemetry` ignora `testerId`/`userId` del cliente, limita a 100 y devuelve 401 sin sesión;
  `summary` corta sesiones a 10 min y agrega por pantalla/acción/error; `/api/activity/*` da 403 sin super;
  `seed_load`/`reset_demo` vacían la actividad pero conservan probadores.
- Migración `003_testers_activity` embebida en `schema.js`.
- Despliegue: push a `connected-pilot`; en producción ejecutar `create_testers` como `u_s1` con el PIN
  compartido y entregar los 10 PINs al usuario.

## Fuera de alcance

Login por teléfono, cambio de permisos por probador, gráficas con librerías, alertas en tiempo real.
