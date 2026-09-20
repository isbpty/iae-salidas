# IAE Salidas · Diseño del backend relacional y demo 100 % funcional

Fecha: 2026-09-18 · Estado: aprobado por el dueño del producto (secciones 1–5) · Rama: `connected-pilot`

## 1. Objetivo

Convertir el prototipo de IAE Salidas (salidas tempranas, excusas, autorizados, garita, bus escolar y bot de WhatsApp) en un sistema **completamente funcional en varios dispositivos a la vez**, con el servidor como única fuente de verdad, permisos reales por rol y datos en PostgreSQL. La interfaz visual actual se conserva. WhatsApp queda **simulado** detrás de una interfaz de transporte; todo lo demás es real.

Decisiones ya tomadas por el dueño del producto:

| Tema | Decisión |
|---|---|
| Presentación | Varios dispositivos en vivo, cada uno con un usuario distinto |
| Hosting | Vercel (serverless) + Neon (PostgreSQL) |
| Autenticación | Un PIN único compartido (`PILOT_PIN`) más selección de usuario |
| Reinicio de datos | Manual, solo Administración, desde su pantalla |
| Enfoque | Backend relacional desde cero (opción B), no endurecer el puente actual |

### No objetivos

- Integración real con WhatsApp (Meta Cloud API, Twilio o whatsapp-web.js). Solo se deja la interfaz `Transport`.
- GPS real. Solo un proveedor simulado con la forma de una API real.
- Multi-escuela, facturación, notificaciones push nativas, cuentas con contraseña individual.
- Migrar datos del piloto anterior (`data/pilot.json`, tabla `app_state`). Se parte de un seed limpio.

## 2. Arquitectura

Un solo servicio Node ≥ 20, ESM, sin framework web. El mismo router atiende en local (`node server/index.js`) y en Vercel (`api/index.js` reexporta el handler). PostgreSQL real; en local y en pruebas se usa **PGlite** (Postgres en WASM) para no instalar nada. El SQL es idéntico en ambos.

Dependencias de producción: `pg`, `@electric-sql/pglite`. Nada más.

```
server/
  index.js                arranque local (http.createServer) + SSE
  app.js                  router: rutas → comandos / proyecciones / auth / estáticos
  config.js               lee y valida SESSION_SECRET, PILOT_PIN, DATABASE_URL, TZ
  db/
    client.js             abre pg (DATABASE_URL) o PGlite (sin URL o en pruebas); withTx(fn)
    migrate.js            aplica migrations/*.sql en orden con pg_advisory_lock
    migrations/001_schema.sql, 002_seed_static.sql …
    seed.js               siembra datos de demo con fechas relativas a hoy
    repo/*.js             consultas por tabla (students, requests, notifications, …)
  domain/
    time.js               hoy/ahora en la zona horaria de la escuela (America/Panama)
    eligibility.js        titular / autorizado vigente / candidatos de retiro
    autoapprove.js        regla de auto-aprobación
    requests.js           transiciones de solicitud y sus efectos (avisos, historial, bitácora)
    authorizations.js     alta, revocación, uso de una_vez
    bus.js                viajes, abordajes, opt-out, posición, "¿dónde está?"
    notifications.js      notifyPerson / notifyRole / notifyTeachers (escriben en tablas)
    audit.js              audit_log + revisión
  bot/
    nlp.js                normalize, parseTime, parseDate, matchKid, extractPickupHint, detectIntent
    conversation.js       máquina de pasos (chatState) y respuestas del bot
  commands/
    index.js              registro { nombre → { roles, handler } }
    <un archivo por comando>
  projections/
    parent.js staff.js gate.js monitor.js admin.js index.js
  transports/
    whatsapp.js           interfaz Transport + SimulatorTransport
    gps.js                interfaz Gps + SimulatedGps
  session.js              cookie HMAC (se conserva)
client/
  index.html  styles.css  api.js  state.js  views.js  qr.js
api/index.js              handler Vercel → server/app.js
```

Reglas de dependencia: `domain/` y `bot/` no conocen HTTP ni el cliente; `commands/` orquesta dominio + repositorios dentro de una transacción; `projections/` solo lee; el cliente solo pinta y envía comandos.

## 3. Modelo de datos

Todas las tablas tienen `id text primary key` (ids legibles del seed como `e1`, `p1`, o `crypto.randomUUID()` en runtime) y `created_at timestamptz default now()`.

| Tabla | Columnas principales | Restricciones |
|---|---|---|
| `settings` | `id='school'`, `data jsonb` (autoApprove, minAnticipationMin, defaultPickupPoint, maxTitulares, schoolStart, schoolEnd, simulateBus, busProgress, newAuthDays, pickupPoints, school{name,short,phone}, timezone) | una fila |
| `levels` | `name`, `grades text[]` | |
| `staff` | `name`, `role` (admin, recepcion, profesor, garita, monitora), `title`, `grades text[]`, `route_id` | CHECK role |
| `role_permissions` | `role`, `capability`, `allowed bool` | PK (role, capability) |
| `persons` | `name`, `phone`, `cedula`, `relation`, `has_account bool`, `doc_attachment_id` | |
| `students` | `name`, `grade`, `level_id`, `emoji`, `family_id`, `route_id`, `stop_id`, `bus_legs text[]` | |
| `guardianships` | `student_id`, `person_id` | PK (student, person); trigger: máximo `settings.maxTitulares` por estudiante |
| `users` | `kind` (person, staff), `ref_id`, `name`, `role` (parent o rol de staff), `active bool` | UNIQUE (kind, ref_id) |
| `attachments` | `owner_person_id`, `purpose` (cedula, foto, certificado), `mime`, `bytes bytea`, `size int` | tamaño ≤ 512 KB |
| `authorizations` | `student_id`, `person_id`, `type` (siempre, temporal, una_vez), `valid_from date`, `valid_to date`, `used_at`, `revoked_at`, `created_by` | CHECK type; un titular no puede ser autorizado del mismo estudiante (trigger) |
| `requests` | `kind` (salida, excusa), `student_id`, `requested_by`, `pickup_by`, `pickup_kind`, `date date`, `time time`, `reason`, `excusa_type`, `channel` (whatsapp, web), `status`, `pickup_point`, `code`, `decided_by`, `decided_at`, `auto_approved`, `reject_reason`, `exit_at`, `exit_by`, `attachment_id`, `attachment_name` | CHECK status ∈ pendiente, aprobada, rechazada, retirado, cancelada, aceptada |
| `request_events` | `request_id`, `at`, `text` | historial visible |
| `pickup_confirmations` | `request_id` PK, `status` (pendiente, confirmada, negada), `requested_by_staff`, `requested_at`, `answered_by_person`, `answered_at` | |
| `notifications` | `person_id` \| `staff_id` \| `role` (exactamente uno), `text`, `kind`, `buttons jsonb`, `read_at` | |
| `chat_messages` | `chat_key` (person_id o `unknown`), `direction` (in, out), `text`, `buttons jsonb`, `location jsonb`, `pending_until timestamptz` | |
| `conversation_state` | `chat_key` PK, `step`, `request_id`, `draft jsonb`, `updated_at` | |
| `routes` | `name`, `plate`, `driver`, `monitor_staff_id`, `color`, `schedule jsonb` | |
| `stops` | `route_id`, `position int`, `name`, `lat`, `lng` | |
| `trips` | `date`, `route_id`, `leg` (ida, vuelta), `status` (programado, en_ruta, finalizado), `started_at`, `ended_at` | UNIQUE (date, route_id, leg) |
| `trip_boardings` | `trip_id`, `student_id`, `status` (abordo, bajo, no_abordo), `stop_id`, `by_staff_id`, `at` | PK (trip, student) |
| `bus_opt_outs` | `trip_id`, `student_id`, `by_person_id`, `at` | PK (trip, student) |
| `audit_log` | `at`, `actor_user_id`, `actor_role`, `command`, `entity`, `entity_id`, `before jsonb`, `after jsonb`, `channel`, `summary`, `actor_name` | reemplaza `S.log`; `summary` y `actor_name` alimentan la bitácora visible |
| `app_meta` | `id='revision'`, `value bigint` | sube +1 en cada comando que escribe |
| `login_attempts` | `key` (ip o user), `count`, `window_start` | límite de intentos |

Los códigos de retiro son 4 dígitos aleatorios como hoy, únicos entre las salidas del mismo día (reintento si choca).

## 4. Comandos

`POST /api/commands/<nombre>` con cuerpo JSON. El router: autentica, busca el comando, verifica que el rol de la sesión esté en `roles`, abre una transacción, ejecuta el handler con `{ db, actor, input, now, transport, gps }`, escribe `audit_log`, sube `app_meta.revision`, confirma y publica el evento SSE. Cualquier error del handler revierte todo. Errores: 400 validación, 403 rol o alcance, 404 entidad, 409 estado no permitido.

El **alcance** se calcula siempre desde la sesión: un padre solo actúa sobre estudiantes donde es titular (`guardianships`); un profesor sobre sus `grades`; una monitora sobre su `route_id`; garita, recepción y admin según `role_permissions`.

| Comando | Roles | Efectos (equivalentes al prototipo) |
|---|---|---|
| `create_salida` {studentId, date, time, pickupBy, reason, channel} | parent | valida titular y candidato de retiro; crea `requests` + evento; avisa al otro titular; evalúa auto-aprobación y, si procede, ejecuta la aprobación automática; si no, avisa a recepción y docentes |
| `create_excusa` {studentId, date, excusaType, reason, attachment?} | parent | crea excusa; avisa a solicitante, otro titular, recepción y docentes |
| `cancel_request` {requestId} | parent (titular) | solo desde pendiente o aprobada; avisa a recepción y garita |
| `approve_request` {requestId, pickupPoint} | recepcion, admin (capability `aprobar`) | aprueba; avisa a titulares (con código y punto), al autorizado con cuenta, a garita y docentes; si el que retira es temporal, una_vez o nuevo (< `newAuthDays`) crea el aviso proactivo con botones "Es correcto / NO" y pone `conversation_state.step='alert_pickup'` a cada titular |
| `reject_request` {requestId, reason} | recepcion, admin | rechaza y avisa a titulares |
| `accept_excusa` {requestId} | recepcion, admin (capability `decidir_excusas`) | acepta; avisa a titulares y docentes |
| `request_confirmation` {requestId} | garita, admin (capability `marcar_salida`) | solo para pickup_kind una_vez y estado aprobada; crea `pickup_confirmations` pendiente; avisa a titulares con "Sí, confirmo / No" y `step='confirm_pickup'` |
| `confirm_pickup` {requestId, confirmed} | parent (titular) | responde la confirmación; avisa a garita y al otro titular; limpia estados de conversación |
| `mark_exit` {requestId} | garita, admin (capability `marcar_salida`) | exige aprobada, autorización vigente y, si una_vez, confirmación confirmada; marca retirado, consume la una_vez, avisa a titulares (hora y oficial), al autorizado con cuenta y docentes |
| `add_authorization` {studentIds[], personId? \| newPerson{name,relation,phone,cedula}, type, from?, to?, attachmentId} | parent (titular de todos los studentIds), recepcion, admin | foto o cédula obligatoria para persona nueva; crea persona si hace falta; una autorización por estudiante; avisa a otros titulares, al autorizado con cuenta y a recepción |
| `revoke_authorization` {authorizationId} | parent (titular), recepcion, admin | marca `revoked_at`; avisa a otros titulares |
| `upload_attachment` (multipart o JSON base64 ≤ 512 KB) | parent, recepcion, admin | guarda en `attachments`; devuelve id. Se llama antes de `add_authorization` o `create_excusa` |
| `mark_boarding` {routeId, leg, studentId, status, stopId?} | monitora (su ruta), admin | crea o actualiza `trips` del día y `trip_boardings`; `no_abordo` avisa a recepción |
| `set_trip_status` {routeId, leg, status} | monitora (su ruta), admin | programado → en_ruta → finalizado |
| `mark_no_bus` {studentId, legs[]} | parent (titular) | inserta `bus_opt_outs`; avisa a la monitora de la ruta y al otro titular |
| `whatsapp_inbound` {text, chatKey?} | parent (usa su person_id como chat_key), admin (puede indicar `chatKey`, incluido `unknown`, para demostrar el número desconocido) | inserta mensaje entrante y ejecuta el bot (sección 6); el bot invoca los comandos anteriores con el mismo actor |
| `mark_notifications_read` {ids[]?} | todos | marca las propias |
| `update_settings` {data} | admin (capability `config`) | reemplaza `settings.data` validado |
| `set_permission` {role, capability, allowed} | admin (capability `personal`) | edita la matriz |
| `reset_demo` | admin | trunca tablas de movimiento y vuelve a sembrar (sección 9) |

Botones de chat ("Sí", "NO", "Es correcto", nombres de hijos) se envían como `whatsapp_inbound` con el texto del botón, igual que hoy.

## 5. Proyecciones (lectura)

`GET /api/me/view` devuelve `{ revision, user, view }`. Cabecera `ETag: "<revision>"`; con `If-None-Match` igual responde **304** sin cuerpo. Todo lo que el cliente pinta viene de aquí; nunca recibe tablas completas de otras familias.

| Rol | Contenido de `view` |
|---|---|
| parent | `me` (persona), `students` (donde es titular, con ruta y parada), `persons` vinculados (titulares y autorizados de sus hijos, con `docAttachmentId`), `authorizations` de sus hijos, `authorizedFor` (hijos ajenos donde él es autorizado vigente), `requests` de sus hijos con eventos y confirmación, `notifications` propias, `chat` (mensajes de su chat_key), `chatState`, `bus` (estado por hijo según sección 7), `settings` públicas (puntos de retiro, teléfono de la escuela), `unread` |
| profesor | `students` de sus grados, `requests` de esos estudiantes, `notifications` (a su staff_id y a su rol), `levels` |
| recepcion | todos los estudiantes, personas, autorizaciones, solicitudes, notificaciones de rol, bitácora, rutas y viajes de hoy |
| garita | salidas del día en estado aprobada o retirado con persona que retira (nombre, relación, cédula, `docAttachmentId`), `pickupKind`, código, punto, confirmación; notificaciones de rol |
| monitora | su ruta con paradas, viajes de hoy con abordajes y opt-outs, estudiantes de su ruta, notificaciones a su staff_id |
| admin | todo lo anterior más `staff`, `permissions`, `settings` completas, `audit` (últimos 500) y la lista de usuarios para el modo "vista dividida" |

Cada proyección agrega `capabilities` (matriz efectiva del rol) para que el cliente muestre u oculte pestañas; la autoridad sigue siendo el servidor.

`GET /api/attachments/:id` sirve la imagen solo si el actor puede verla: titulares del estudiante vinculado, quien la subió, recepción, admin y garita (solo para personas con salida aprobada hoy).

## 6. Bot de WhatsApp (en servidor)

Se porta tal cual la comprensión actual de `app.js`: intents `saludo`, `estado`, `cancelar`, `nobus`, `donde`, `salida`, `excusa`, `desconocido`; pasos `ask_child`, `ask_time`, `ask_pickup`, `confirm`, `alert_pickup`, `confirm_pickup`. Los borradores viven en `conversation_state.draft`. Cuando el paso `confirm` recibe "Sí", el bot llama a `create_salida` o `create_excusa` con el mismo actor y dentro de la misma transacción. Número desconocido (`chatKey='unknown'`) recibe el mensaje de "no registrado".

Las respuestas salientes pasan por `Transport.send(chatKey, message)`. `SimulatorTransport` inserta en `chat_messages` con `pending_until = now + 700 ms + 400 ms × mensajes pendientes` para conservar el efecto "escribiendo…". Las notificaciones a personas con teléfono también se copian al chat, como hoy en `notifyPerson`.

Interfaz, para el reemplazo futuro:

```js
export class Transport {
  async send(chatKey, { text, buttons, location }) {}   // salida
  onInbound(handler) {}                                  // entrada: handler({ chatKey, text })
}
```

## 7. Bus y GPS

`Gps.position(routeId, now)` devuelve `{ leg, progress, simulated }` o `null`. `SimulatedGps` reproduce la lógica actual: si `settings.simulateBus`, el tramo de vuelta va con `busProgress`; si no, se interpola por el horario del tramo. `domain/bus.js` calcula posición, próxima parada, ETA y la respuesta de "¿dónde está?" en este orden: retirado hoy por garita → en bus (abordó, bajó, no abordó, sin marcar) → en el plantel en horario → fuera de horario. Solo titulares pueden preguntar por un estudiante.

## 8. Autenticación, seguridad y tiempo real

- **Login**: `GET /api/auth/options` lista usuarios activos (id, nombre, rol); `POST /api/auth/login {userId, pin}` compara con `PILOT_PIN` en tiempo constante y emite la cookie `iae_session` (HMAC, 8 h, HttpOnly, SameSite=Strict, Secure en producción). Límite: 10 intentos fallidos por IP o usuario cada 15 min (`login_attempts`).
- **Secretos obligatorios**: sin `SESSION_SECRET` (≥ 32 caracteres) o `PILOT_PIN` el servidor no arranca; sin `DATABASE_URL` usa PGlite en `data/pglite/` (solo desarrollo) y lo dice en el log. Vercel responde 503 si falta cualquiera de los tres.
- **TLS a Neon**: `ssl: { rejectUnauthorized: true }` con `sslmode=require`.
- **Estáticos**: solo `client/*` e `index.html`. Nada de `data/`, `.env`, `.git`, `server/`.
- **Tiempo real**: en local, `GET /api/events` (SSE) emite `{type:'changed', revision}`; el cliente entonces pide la vista. En Vercel el cliente sondea `GET /api/me/view` cada 3 s con `If-None-Match`; un 304 no cuesta render ni transferencia relevante.
- **Zona horaria**: `settings.data.timezone = 'America/Panama'`; "hoy", "ahora" y los cortes de horario se calculan con ella en el servidor, nunca con la hora del navegador.

## 9. Seed y reinicio

`server/db/seed.js` siembra los mismos datos que `seed.js` actual (escuela, niveles, personal s1–s8, permisos, personas p1–p7, estudiantes e1–e4, autorizaciones a1–a4, historial r_h1–r_h3, rutas r1/r2, viaje de vuelta de r1 en ruta con e1 y e2 a bordo), con fechas relativas al día actual en la zona de la escuela. Las fotos o cédulas de ejemplo se siembran como `attachments` pequeños generados (SVG con el nombre) para que garita siempre tenga algo que mostrar. Los usuarios se derivan: uno por persona con cuenta y uno por miembro del personal.

`reset_demo` (admin) borra requests, request_events, pickup_confirmations, notifications, chat_messages, conversation_state, trips, trip_boardings, bus_opt_outs, audit_log, authorizations y attachments no de seed, y vuelve a sembrar. La revisión sube para que todos los dispositivos se refresquen.

## 10. Cliente

- Se conserva `styles.css` y la estructura visual; `index.html` pasa a `client/index.html` (el router lo sirve en `/`).
- `client/api.js`: `login`, `logout`, `view(etag)`, `command(name, input)`, `upload(file)`, `subscribe(onChange)` (SSE o sondeo según `window.__IAE_SERVERLESS__`).
- `client/state.js`: guarda `view` y `revision`; expone `apply(name, input, optimistic)`: aplica un cambio optimista mínimo (por ejemplo, estado de la solicitud), envía el comando, y al recibir respuesta o la siguiente vista reemplaza todo. Si el comando falla, vuelve a la última vista confirmada y muestra el toast de error.
- `client/views.js`: mismas funciones de render que hoy, leyendo de `view` en lugar de `S`, y con las acciones `data-action` / `data-form` llamando a `apply`. Los selectores "persona activa", "teléfono" y "personal" desaparecen; los sustituye el login. Para admin se conservan "Vista dividida" y "Guion", y su vista dividida usa `view.users` para abrir otra sesión en una segunda pestaña, no para suplantar en la misma.
- Botón "Reiniciar" visible solo para admin y llama a `reset_demo` con confirmación.
- QR: `client/qr.js` usa `qrcodejs` desde cdnjs como hoy, con el código que trae la proyección.
- El simulador de WhatsApp muestra `view.chat`, respeta `pendingUntil` para "escribiendo…", y envía con `whatsapp_inbound`. El admin puede elegir el `chatKey` (persona o desconocido) para demostraciones.
- Helpers puros (`fmtTime`, `fmtDate`, `esc`, etc.) van a `client/format.js`.

## 11. Pruebas y CI

`node --test` con PGlite en memoria; cada archivo crea una base limpia con migraciones y seed.

- `server/domain/*.test.js`: elegibilidad, auto-aprobación (cada motivo de rechazo), transiciones.
- `server/commands/*.test.js`: por comando, caso feliz + rol denegado + fuera de alcance (padre de f2 sobre e1) + estado inválido. Flujos completos: salida auto-aprobada; salida pendiente aprobada por recepción y retirada en garita; una_vez con confirmación pedida, negada y luego confirmada; aviso proactivo respondido con NO que cancela y avisa a garita; hoy no va en bus; abordajes y "¿dónde está?" en cada estado.
- `server/bot/*.test.js`: parseo de horas y fechas, detección de intents, conversaciones de varios pasos, número desconocido.
- `server/projections/*.test.js`: cada rol recibe solo lo suyo; un padre no ve otra familia; garita no ve excusas; profesor no ve otros grados.
- `server/app.test.js`: router en proceso (http en puerto efímero): login con PIN incorrecto, límite de intentos, 401 sin cookie, 304 por ETag, 403 en comando de otro rol, estáticos prohibidos (`/data/x`, `/.env`, `/server/app.js` → 404).
- GitHub Actions `.github/workflows/ci.yml`: `npm ci` y `npm test` en push y pull request.

## 12. Despliegue

- **Vercel**: `api/index.js` importa `server/app.js`; `vercel.json` reescribe `/api/(.*)` al handler y sirve `client/` como estáticos. Variables: `DATABASE_URL`, `SESSION_SECRET`, `PILOT_PIN`. Migraciones al primer arranque de cada instancia con `pg_advisory_lock`. Sin memorización de estado entre peticiones: cada petición consulta la base.
- **Neon**: base `iae_salidas`, `sslmode=require`.
- **Local**: `npm start` con PGlite (sin variables) o con `DATABASE_URL`. `npm run reset` borra `data/pglite/`.
- **Docker**: `Dockerfile` mínimo (node:20-alpine, `npm ci --omit=dev`, `node server/index.js`).
- `VERCEL-DEPLOY.md` y `README.md` se reescriben; `ARCHITECTURE.md` se actualiza a este diseño.

## 13. Limpieza

Se eliminan: `pilot.html`, `pilot.js`, `connected-app.js`, `demo.html`, `connected-bridge.js`, `app.js`, `seed.js` y `views.js` de la raíz (reemplazados por `client/` y `server/`), `server/domain.js`, `server/simulator.js`, `server/delivery.js`, `server/qr-worker.js`, `server/whatsapp-bridge.js`, `server/prototype-policy.js`, `server/prototype-commands.js`, `server/store.js`, `server/postgres-store.js`, `server/seed.js`, sus pruebas, `deploy.example.yaml`, `compose.yaml`, `migrations.md`, `.dockerignore` si queda sin uso, y la dependencia opcional `whatsapp-web.js`.

## 14. Orden de construcción sugerido

1. Base: `config`, `db/client` (pg + PGlite), migraciones, seed, `app_meta`, pruebas de arranque.
2. Sesión y router mínimo: login, logout, options, límite de intentos, estáticos restringidos, `GET /api/me/view` vacío con ETag.
3. Dominio y comandos de solicitudes y autorizaciones, con notificaciones y auditoría; pruebas.
4. Garita: confirmación una_vez, retiro, adjuntos.
5. Bus: viajes, abordajes, opt-out, GPS simulado, "¿dónde está?".
6. Bot y transporte simulado; `whatsapp_inbound`.
7. Proyecciones por rol y pruebas de aislamiento.
8. Cliente: `api.js`, `state.js`, adaptación de `views.js`, login, sondeo o SSE.
9. `reset_demo`, `update_settings`, `set_permission`.
10. Vercel handler, CI, documentación, limpieza de archivos, verificación E2E en navegador con dos sesiones.
