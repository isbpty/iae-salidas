# Correcciones de la revisión Opus (2026-09-22) — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar todos los hallazgos de `docs/revision-opus-2026-09-22.md` (secciones 2–5) sin rehacer la arquitectura ni romper el demo (el simulador `public/client/simulator.js` debe seguir completando sus 12 pasos).

**Architecture:** Mismo diseño (dominio / comandos / proyecciones, una transacción por comando, PGlite en tests). Cada tarea toca un área acotada, añade pruebas de los escenarios que la revisión marcó como fallidos y deja `npm test` en verde.

**Tech Stack:** Node ≥20 ESM, `pg`/PGlite, `node:test`, cliente vanilla (scripts clásicos). Sin dependencias nuevas.

**Spec:** `docs/revision-opus-2026-09-22.md` es la especificación: cada tarea cita sus ítems (S = seguridad, L = lógica, R = rendimiento, C = calidad). Los ítems traen archivo:línea, el escenario que falla y el cambio propuesto; el implementador los lee en el documento.

## Global Constraints

- `npm test` en verde al final de cada tarea; cada escenario "[verificado]" que la tarea cierra tiene una prueba nueva que falla antes y pasa después.
- Sin dependencias nuevas ni frameworks. Sin cambiar la forma de las respuestas `{ ok, result, revision, view }` ni los nombres de comandos existentes (se pueden añadir).
- Los textos de la interfaz y de los avisos siguen en español (Panamá). Zona horaria de la escuela: `settings.timezone` (`America/Panama`).
- El guion del simulador (`SIM_SCRIPT` en `public/client/simulator.js`) debe seguir funcionando: los chips de WhatsApp, `create_salida` con titular/abuela/Laura (una vez), aprobación por Recepción, `request_confirmation` + "Sí, confirmo", `mark_exit` el mismo día, excusa, "¿Dónde está Sofía?", "hoy no va en el bus", escaneo de código.
- Los datos de demo (`server/db/seed.js`, `seed-load.js`) deben seguir cargando; si una validación nueva los rechaza, corregir el seed.
- Errores de dominio con código snake_case y HTTP 400/403/404/409; nunca un 500 por datos de entrada.
- Commit por tarea con mensaje en español, terminado en `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Validar salidas y quién retira

**Cierra:** S6, L1, L3, C3 (parcial: `requests.js:90`).
**Files:** Modify `server/commands/requests.js`, `server/domain/requests.js`, `server/domain/time.js` (helper `isValidDate(iso)`, `isValidTime(hhmm)`), `server/domain/errors.js` si hace falta; Test `server/commands/requests.test.js`.

- `create_salida` y `create_excusa`: `date` debe ser `YYYY-MM-DD` real (ida y vuelta por `Date`), `time` `HH:MM` con `0≤h≤23`, `0≤m≤59`; salida con fecha anterior a hoy (zona de la escuela) → 400 `date_in_past`; hoy con hora ya pasada → 400 `time_in_past`. Excusa: fecha válida, sin restricción de pasado.
- `pickupBy` obligatorio y debe estar en `pickupCandidates(ctx, studentId, date)` (titulares + autorizados vigentes para esa fecha); si no → 400 `pickup_not_candidate`. Nunca se crea con `pickupKind: 'no_autorizado'`.
- `approveRequest`: revalidar elegibilidad; si la persona ya no es candidata → 409 `pickup_no_longer_eligible`; `pk` nulo → 409 `pickup_person_missing` (nunca TypeError).
- Pruebas: `2026-13-45`/`29:99` → 400; fecha pasada → 400; `pickupBy: 'p7'` (otra familia) → 400 y Wei **no** recibe aviso; `pickupBy: 'nobody'` → 400; la app y el bot siguen creando salidas válidas (los chips del guion).
- El bot (`server/bot/conversation.js`) ya resuelve la persona entre candidatos; comprobar que un `pickup_not_candidate` del bot se responda con un mensaje claro y no con 500.

### Task 2: Elegibilidad por fecha, retiro solo hoy, código único

**Cierra:** L2, L4, L5, L6, L17.
**Files:** Modify `server/domain/eligibility.js` (`pickupEligibility(ctx, studentId, personId, date = hoy)`, `pickupCandidates(ctx, studentId, date)`), `server/domain/autoapprove.js`, `server/domain/requests.js`, `server/domain/authorizations.js`, `server/db/schema.js` (migración `004_requests_code_unique`: `CREATE UNIQUE INDEX IF NOT EXISTS requests_date_code ON requests(date, code) WHERE kind='salida' AND code IS NOT NULL`), `server/bot/conversation.js` y `public/client/model.js` (`pickupCandidates` con fecha); Tests `server/domain/eligibility.test.js`, `server/commands/gate.test.js`.

- La elegibilidad usa la fecha de la salida en creación, auto-aprobación, aprobación y candidatos del formulario/bot. Prueba: temporal 16–30 sept, salida del 15 oct → pendiente como `no_autorizado`… (con Task 1: 400 `pickup_not_candidate`); temporal que empieza mañana → salida de mañana auto-aprobable.
- `una_vez`: `valid_to` opcional (columna nueva en migración 004, `valid_to text`); por defecto 7 días desde `created_at`; vencida = inactiva. El seed y `seed-load` siguen válidos.
- `markExit` exige `req.date === hoy` → 409 `not_today`. Las `aprobada` con fecha pasada se muestran como `vencida` en las proyecciones (campo derivado `expired: true`), sin cambiar el estado en base.
- `requestConfirmation` y `markExit` usan la elegibilidad **actual** (`kind === 'una_vez'`) en vez de `req.pickupKind`; `approveRequest` recalcula y guarda `pickupKind`.
- `uniqueCode` con `crypto.randomInt` y reintento si choca con el índice único.

### Task 3: Confirmaciones y conversaciones seguras; cancelación por el personal

**Cierra:** L7, L8, L9, L15, C8 (TTL y validación de la solicitud referida).
**Files:** Modify `server/domain/requests.js`, `server/bot/conversation.js`, `server/commands/requests.js` (nuevo `staff_cancel_request`, capability `aprobar`), `server/db/repo.js` (`getConversation` ignora estados con `updated_at` de más de 2 h o de otro día); Tests `server/commands/gate.test.js`, `server/bot/conversation.test.js`, `server/commands/requests.test.js`.

- `confirm_pickup(true)` con una confirmación `negada` → 409 `pickup_denied`; solo un nuevo `request_confirmation` de garita reabre (queda en la historia). `confirm_pickup` exige confirmación `pendiente` y `pickupKind`/elegibilidad `una_vez`.
- `cancelRequest`, `rejectRequest`, `markExit` limpian `alert_pickup` y `confirm_pickup` de **todos** los titulares. En los pasos `confirm_pickup`/`alert_pickup`, si la solicitud ya no está `aprobada`, limpiar y explicar ("esa salida ya fue cancelada/retirada").
- Avisos proactivos: no pisar un borrador en curso (`draft` se conserva; el aviso se guarda como lista `alerts: [{requestId}]`); "NO" cancela **esa** solicitud; texto no reconocido repite la pregunta; "NO" tardío tras el retiro → "ya salió a las X con Y; llama a recepción al …" y aviso a Recepción.
- `staff_cancel_request { requestId, reason }` para `pendiente`/`aprobada`: avisa a titulares y al autorizado con cuenta que ya recibió el código; garita recibe aviso si estaba aprobada.
- Rechazar una segunda salida `pendiente`/`aprobada` del mismo estudiante y fecha → 409 `duplicate_salida`.
- Pruebas para cada escenario [verificado] de L7, L8, L9 y para `staff_cancel_request` y duplicados.

### Task 4: Acceso y sesiones

**Cierra:** S1, S2, S3, S4, S5, S13.
**Files:** Modify `server/app.js`, `server/auth.js`, `server/session.js`, `server/testers.js`, `server/config.js` (`demoMode: env.DEMO_MODE !== 'false'`, `superKey` ≥ 24 chars), `server/db/schema.js` (migración `005_testers_access`: `testers.allowed_users jsonb`, `testers.sessions_valid_after timestamptz`, `testers.pin_lookup text UNIQUE`), `server/db/seed.js` (`login_attempts` fuera de `MOVEMENT_TABLES`), `server/commands/admin.js`, `server/commands/whatsapp.js`, `server/projections/parent.js`, `api/index.js`, `public/client/state.js`/`api.js` (login usa `options` del paso 1; `showSwitch` con sesión), `public/client/super.js` + rutas `super/allowed` para editar `allowed_users`; Tests `server/testers-auth.test.js`, `server/super.test.js`, `server/app.test.js`.

- `allowed_users` (lista de ids de usuario o `null` = todos): se comprueba en `auth/login` y `auth/switch` → 403 `user_not_allowed`. `/super` permite editarla (`POST /api/super/allowed { testerId, userIds|null }`).
- `DEMO_MODE` (por defecto activo): `reset_demo`, `seed_load` y `whatsapp_inbound` con `chatKey` ajeno solo en modo demo → 403 `demo_only` si está apagado.
- `GET /api/auth/options` exige sesión; el paso 1 del login ya devuelve `options`.
- Vista del padre: `accounts` desaparece; `add_authorization` con `mode: 'cuenta'` busca por cédula o teléfono **exactos** (`lookup_person { cedula|phone }` → solo `{ id, name, relation }` si existe).
- Intentos: no borrar `ip:` al acertar (solo `user:`); claves por superficie `pin:ip`, `login:ip`, `super:ip`; `user:<id>` bloquea solo si la IP también tiene fallos (o se elimina).
- Sesiones: tokens con `iat`; `sessions_valid_after` por probador se actualiza al regenerar PIN, desactivar y en logout (`auth/logout` y `auth/super/logout`); `sessionUser` y `superSession` rechazan tokens anteriores y probadores inactivos (una sola consulta extra o unida a `getUser`).
- PIN: `pin_lookup = HMAC-SHA256(SESSION_SECRET, pin)` con índice único; `findTesterByPin` busca por lookup y verifica **una** fila con `crypto.scrypt` asíncrono. Migración: rellenar `pin_lookup` es imposible sin el PIN → los probadores existentes se regeneran al primer arranque sin lookup **no**; en su lugar: mientras `pin_lookup` sea nulo se usa la ruta antigua para esa fila, y regenerar/crear PIN escribe el lookup. Documentar en README.
- `pinToken` de un solo uso (`jti` guardado en `login_attempts` con clave `jti:<id>` o tabla corta); `/api/health` público solo `{ ok: true }` (revisión y `db` solo con sesión); 503 de `api/index.js` con mensaje genérico y detalle en `console.error`.

### Task 5: Revisión solo cuando cambia algo; sondeo inteligente; caché de estáticos

**Cierra:** R1, R4, R6, R8.
**Files:** Modify `server/commands/index.js`/`run.js` (`bump: false` por comando), comandos `where_is`, `day_summary`, `mark_notifications_read`, `scan_code`, `send_day_summary` (sí bump: crea aviso), `server/app.js` (304: solo HMAC + revisión; `getUser` solo cuando cambia), `public/client/api.js` (`subscribe`: pausa con `document.hidden`, 3 s garita/recepción/admin, 10 s padres/profesores/monitoras, *backoff* hasta 30 s tras 10 × 304 seguidos, reinicio al volver a primer plano o tras un comando), `vercel.json` (`no-store` solo `/api/(.*)`; `/client/*` e `index.html` con `no-cache`), `server/app.js` `serveStatic` con ETag débil; Tests `server/commands/admin.test.js` (revisión no sube en comandos de lectura), `server/app.test.js`.

- El sondeo de vista con 304 **no** registra actividad (ya) y no hace `getUser` (verificar por contador de consultas en test con un `db` envuelto).

### Task 6: Quitar N+1 y aligerar el arranque

**Cierra:** R2, R5.
**Files:** Modify `server/db/repo.js` (`withTitulares` con `student_id = ANY($1)`, `getRoute` por id, `listRequests(..., { hydrate: false })`, `hydrateRequests` en dos consultas por lote), `server/domain/context.js` (`ctx.staffList` perezoso con caché por comando), `server/domain/notifications.js`, `server/domain/eligibility.js`, `server/projections/access.js` (`canSeeAttachment` con una consulta `EXISTS` por rol), `server/db/migrate.js` (`bootstrap`: `SELECT max(version)` sin lock; migrar bajo lock solo si falta alguna), `server/db/client.js` (`idleTimeoutMillis: 10000`; documentar `-pooler` en README); Test nuevo `server/db/repo.test.js` con contador de consultas: `create_salida` ≤ 20 consultas; vista de Recepción con 700 estudiantes ≤ 12 consultas.

### Task 7: Recortar las vistas de Recepción y Administración

**Cierra:** R3.
**Files:** Modify `server/projections/staff.js`, `server/projections/parent.js`, `server/db/repo.js` (`listRequests` con `since`, `listNotifications` con `limit`, `listChatSummaries`), nuevo comando `search_requests { q, from, to, status, kind }` (roles escuela con `ver_solicitudes`, máx. 200) y `get_chat { chatKey }` (admin) en `server/commands/requests.js`/`whatsapp.js`; cliente `public/client/views.js` (la búsqueda de "Salidas" con más de 14 días llama a `search_requests`; los chats de admin cargan bajo demanda al elegir teléfono), `public/client/model.js`; Tests `server/projections/views.test.js`, `server/db/seed-load.test.js` (vista de Recepción con 700 estudiantes < 150 KB).

- Solicitudes: hoy + pendientes + últimos 14 días. Avisos: últimos 100. Chats de admin: resumen por `chat_key` (último mensaje, cuántos, no leídos) y chat completo bajo demanda. Personas: solo las referenciadas por los estudiantes visibles (titulares, autorizados); cédula y teléfono ya se filtran por rol.
- El simulador y el buscador siguen funcionando (el buscador de Salidas avisa "buscando en el histórico…" cuando usa el comando).

### Task 8: Avisos de rol leídos por usuario

**Cierra:** L10.
**Files:** Migración `006_notification_reads` (`notification_reads(notification_id, user_id, read_at, PRIMARY KEY(notification_id, user_id))`), `server/db/repo.js` (`listNotifications` marca `read` según el usuario; `markNotificationsRead` inserta filas para avisos de rol), `server/commands/admin.js`, proyecciones; cliente: `state.js` llama a `mark_notifications_read` solo tras 5 s con la pestaña visible y solo si hay no leídos; Tests `server/commands/admin.test.js` (dos recepcionistas: leer uno no apaga el otro; los toasts del segundo aparecen).

### Task 9: Telemetría, actividad, CSV, auditoría y SQL endurecido

**Cierra:** S7, S8, S10, S12, R7.
**Files:** Modify `server/activity.js` (lista blanca de `kind` del cliente; tope 2 KB por `data`; máximo 30 lotes/min por `sid` → 429 `too_many_batches`; `ua` solo en el primer evento del `sid`), `server/activity-queries.js` (`source='server'` en acciones/errores del servidor; `where()` valida fechas → 400 `invalid_range`, `errorsOnly === 'true'|'1'`; `cell()` neutraliza `=+-@\t\r`; una consulta por bloque con `FILTER`; índice `activity_events(at)` en migración `007_activity_index`), `server/commands/run.js` (`maskInput` en `audit_log.input`; no auditar `mark_notifications_read`), `server/app.js` (borrado automático de actividad > 30 días al entrar a `/super`, 1 vez por hora como máximo, y de `audit_log` > 180 días), `server/db/repo.js` (`insertRow`/`patchRow`/`insertRows`: claves `^[a-z][a-zA-Z0-9]*$` y lista blanca de tablas); Tests `server/activity.test.js`, `server/activity-queries.test.js`, `server/db/repo.test.js`.

### Task 10: Bot NLP y bus

**Cierra:** L11, L12, L13, L14.
**Files:** Modify `server/bot/nlp.js`, `server/bot/conversation.js`, `server/domain/bus.js`, `server/commands/bus.js` (`mark_no_bus { date }`, `undo_no_bus`, máquina de estados de viajes, validación de parada, aviso a titulares en `no_abordo`); Tests `server/bot/nlp.test.js` (cada frase de L14 con su resultado esperado), `server/commands/bus.test.js`, `server/domain/bus.test.js`.

- L14 completo: año en fechas, `dd/mm` validado y año siguiente si ya pasó, "hoy en la mañana", "y media/y cuarto/mediodía", intents `busca`/`recoge` → salida, falta/ausencia + permiso → excusa, `resolvePickup` por puntaje (nombre+apellido > apellido) y pregunta si hay empate.
- L11: "¿Dónde está?" con excusa de hoy (`ausencia` → "no asistió hoy", `tardanza` → "llega tarde"); fines de semana → "hoy no hay clases".
- L12: ruta sin monitora → aviso a Recepción (nunca 500); opt-out con fecha (hoy/mañana) y sin repetir avisos; `undo_no_bus`.
- L13: `no_abordo` avisa a titulares; transiciones `programado→en_ruta→finalizado` (409 `invalid_transition`); `markBoarding` valida parada de la ruta y rechaza si hay opt-out o el estudiante ya está `retirado`.

### Task 11: Cliente: zona horaria de la escuela, escapes, CSP/SRI, adjuntos, candado del simulador

**Cierra:** L16, S11, S9, L18.
**Files:** Modify `public/client/format.js` (formatos con `Intl.DateTimeFormat('es-PA', { timeZone: V.settings.timezone })`, `nowHHMM` con `serverNow()`), `public/client/views.js` (`esc()` en `emoji`, `badge(status)`, `r.color` validado `^#[0-9a-f]{6}$`), `public/index.html` (`integrity` + `crossorigin` en qrcodejs), `vercel.json` (CSP: `default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com 'sha256-<hash del script en línea de super.html>'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`) y `server/app.js` con la misma cabecera en local; `server/projections/access.js` (garita solo `cedula`/`foto` del `doc_attachment_id` de quien retira; padres por entidad: excusa de hijo propio o documento de autorizado propio), `server/commands/attachments.js` (cuota 20 subidas/persona/día → 429 `upload_quota`; borrado de huérfanos > 24 h en `purge`), PDF con `Content-Disposition: attachment`; simulador: candado en servidor (`app_meta` `sim_lock` con vencimiento de 15 min: comando `sim_lock { acquire|release }`; el simulador no reinicia si otro corre y lo dice); Tests `server/projections/views.test.js` (acceso a adjuntos), `server/commands/attachments.test.js`, `server/commands/admin.test.js` (candado).

### Task 12: Integridad del esquema, constantes y documentación

**Cierra:** C2, C7, C10 (y deja C3 completo con `mustGet`).
**Files:** Migración `008_integrity` (CHECK de `date`/`time` con expresión regular y `date::date`, FKs `requests.requested_by/pickup_by → persons`, `decided_by → staff`, `notifications.person_id/staff_id`, `trip_boardings.student_id`, con `NOT VALID` + `VALIDATE` para no romper datos existentes), `server/domain/constants.js` (roles, estados, capacidades) usado por `projections/index.js` y `commands/admin.js`, `public/client/format.js` con el reflejo de constantes, helper `mustGet(q, table, id, code)` en `server/db/repo.js` aplicado en `requests.js:90`, `bus.js:45/62`, `conversation.js:125/158/165`; `VERCEL-DEPLOY.md` y `README.md` con `SUPER_KEY`, `PILOT_PIN_SHARED`, `DEMO_MODE`, `-pooler`; corregir la contradicción de la spec de probadores (línea 103); Tests `server/db/migrate.test.js`, `server/db/seed-load.test.js` (el seed cumple las FKs).

### Task 13: Partir `views.js` y `app.js` sin cambiar comportamiento

**Cierra:** C5, C6, C9 (renombres locales: `st` de conversación → `conv`, `loadSalida` → `loadRequest`, `currentLeg` → `gpsPosition`).
**Files:** `public/client/views.js` → `views-core.js` (arranque, render, tabs, modales comunes), `views-parent.js`, `views-school.js`, `views-gate.js` (garita + TV), `views-bus.js`, `modals.js`, `actions.js` (ACTIONS/FORMS/eventos); `public/index.html` con el nuevo orden; `server/app.js` → `server/routes/auth.js`, `server/routes/super.js`, `server/routes/app.js` con firma `(req, res, ctx)` y `app.js` como router + estáticos + registro de actividad; Tests: la suite completa y una prueba de humo del cliente con `node --check` de cada archivo y una comprobación de que `index.html` referencia todos los scripts.

- Solo movimientos y renombres; ningún cambio de comportamiento. El simulador debe completar los 12 pasos después (verificación manual del controlador en el navegador).

### Task 14: Correo al super admin cuando entra un probador

**Pedido por el usuario el 2026-09-22.** Isaac quiere un correo cada vez que un probador inicia sesión, para abrir `/super` y observar.
**Files:** Create `server/transports/email.js` (interfaz `send({ to, subject, text, html })`; implementación `ResendEmail` con `fetch('https://api.resend.com/emails')` y `RESEND_API_KEY`, `NullEmail` cuando falta la clave, `MemoryEmail` para tests), Modify `server/config.js` (`alertEmail: env.ALERT_EMAIL || ''`, `emailFrom: env.ALERT_FROM || 'IAE Salidas <onboarding@resend.dev>'`, `resendApiKey`), `server/index.js` y `api/index.js` (inyectar `email` en deps), `server/app.js` (tras un `auth/login` exitoso con `testerId` no nulo: enviar aviso, sin bloquear la respuesta más de 3 s, fallos solo a `console.error`; **no** en `auth/switch`; cooldown de 30 min por probador guardado en `app_meta` (`email_alert_<testerId>`) para no inundar), `server/activity.js` (registrar `kind: 'email'` con `ok` y el error si falla), `public/client/super.js` (bloque "Avisos por correo": estado configurado/no configurado y último envío); `README.md`/`VERCEL-DEPLOY.md` (pasos: cuenta en Resend con el mismo correo, `RESEND_API_KEY`, `ALERT_EMAIL`, opcional `ALERT_FROM` con dominio verificado); Tests `server/email.test.js` (login de probador envía 1 correo con probador, usuario, rol, hora Panamá y enlace `/super`; segundo login del mismo probador dentro de 30 min no envía; `switch` no envía; sin `RESEND_API_KEY` no envía y no falla; el envío que falla no afecta al login).
