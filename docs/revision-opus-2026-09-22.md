# Revisión técnica de IAE Salidas · 2026-09-22

Rama `connected-pilot`, commit `18eded0` (incluye el buscador de Escuela que entró durante la revisión). `npm test`: **87/87 pruebas pasan en ~26 s**.

Cómo se verificó: además de leer el código, se ejecutaron escenarios contra el código real con `makeTestApp()` (PGlite, mismo seed y reloj que las pruebas) desde un archivo fuera del repositorio. Los hallazgos marcados **[verificado]** se reprodujeron así; el resto sale de la lectura del código. Se pueden reproducir copiando el escenario a un `*.test.js` con `t.run(...)`.

---

## 1. Resumen ejecutivo

1. La arquitectura es sana: capas claras (dominio / comandos / proyecciones), una transacción por comando, SQL parametrizado, proyecciones acotadas por rol y buenas pruebas. Para un piloto con datos ficticios está en buen estado.
2. El mayor riesgo **antes de usar datos reales** es el modelo de acceso: cualquier PIN de probador abre cualquier usuario, incluido Administración (`auth/switch` no tiene restricciones). Además, `GET /api/auth/options` publica sin sesión la lista de todos los usuarios.
3. Hay errores de lógica que afectan la seguridad del retiro. No se valida quién retira ni la fecha de la salida (se auto-aprobó una salida del `2026-13-45` a las `29:99`). La elegibilidad se evalúa con la fecha de "hoy" y no con la de la salida. Con autorización de una sola vez gana la última respuesta, y un "NO" de un titular se anula con un "Sí" del otro.
4. En costo y rendimiento, el problema de fondo es que la revisión es **global**. Cualquier comando, incluso uno de solo lectura o el marcado automático de avisos leídos, obliga a todos los dispositivos a reconstruir su vista completa: la de Recepción pesa ~460 KB con 700 estudiantes y hace 21 consultas en serie. A eso se suman lecturas N+1 en `repo.js` (cada `getStudent` lee todas las tutelas) y un sondeo cada 3 s que sigue aunque la pestaña esté oculta.
5. Plan: 10 cambios, casi todos S/M y sin rehacer nada (sección 7). Los tres primeros (validar salidas, elegibilidad por fecha y confirmaciones) cierran los riesgos de entrega de estudiantes. Los dos siguientes (sesiones y revisión) cierran el acceso y reducen el costo.

---

## 2. Seguridad y privacidad

### S1 · Un PIN de probador abre cualquier rol, incluido Administración — **alta** (bloqueante antes de datos reales)
- `server/app.js:97-112`: `auth/login` acepta cualquier `userId` activo con cualquier PIN válido.
- `server/app.js:195-201`: `auth/switch` cambia a **cualquier** usuario, sin PIN y sin mirar el rol de origen. **[verificado]** Una sesión de padre (`u_p1`) pasó a `u_s1` (admin) con 200.
- Consecuencias en cadena:
  - `reset_demo` (`server/commands/admin.js:60-67`) borra todo para todos. El simulador lo hace para cualquier probador (`public/client/simulator.js:262-263`).
  - `whatsapp_inbound` con `chatKey` de otro padre (`server/commands/whatsapp.js:13-17`) permite a un admin responder "Sí, confirmo" a una entrega de una sola vez en nombre del titular. Eso anula el control que existe justamente para evitar entregas no reconocidas.
- **Por qué importa:** con datos reales, cada probador sería administrador de hecho. Hoy la separación por roles es solo visual.
- **Cambio:** antes de cargar datos reales, añadir a `testers` una lista `allowed_users` (o `allowed_roles`) y comprobarla en `auth/login` y `auth/switch`. Quitar el `chatKey` ajeno de `whatsapp_inbound` fuera del modo demo (una variable `DEMO_MODE`). Exigir `DEMO_MODE=true` para `reset_demo` y `seed_load`.

### S2 · Directorio de usuarios público y directorio de padres para cada padre — **alta** (privacidad)
- `server/app.js:83`: `GET /api/auth/options` no pide sesión y devuelve id, nombre y rol de todos los usuarios activos. **[verificado]** Responde 200 con 13 usuarios sin cookie.
- `server/projections/parent.js:41`: `accounts` entrega a cada padre el nombre y la relación de **todas** las personas con cuenta del colegio.
- **Por qué importa:** con 700 familias es la nómina completa de padres, accesible desde internet sin credenciales.
- **Cambio:** que `auth/options` exija sesión (lo usa `showSwitch`, ya autenticado). El paso 1 del login ya devuelve `options` junto al `pinToken`. En la vista del padre, cambiar `accounts` por una búsqueda exacta (cédula o teléfono completos) dentro de `add_authorization`.

### S3 · Un PIN válido anula el límite de intentos — **media**
- `server/app.js:92`, `:109` y `:127` llaman a `clearLoginFailures` con la clave `ip:` tras cualquier acierto. `auth/super` usa la **misma** clave `ip:`.
- **[verificado]** 9 fallos, 1 acierto y 9 fallos más siguen dando 401 en vez de 429. Un probador puede probar PINs ajenos (incluido el del super admin) y claves `SUPER_KEY` sin límite práctico.
- Además, `reset_demo` trunca `login_attempts` (`server/db/seed.js:6`), y la clave `user:<id>` (`app.js:100`) permite a un anónimo bloquear 15 min el login de `u_s1` con 10 intentos.
- **Cambio:**
  - No borrar el contador por IP al acertar; dejar que expire con la ventana, o borrar solo la clave `user:`.
  - Usar claves separadas por superficie: `pin:ip`, `super:ip`.
  - Quitar `login_attempts` de `MOVEMENT_TABLES`.
  - Para la clave `user:`, bloquear solo los intentos que vienen de IPs con fallos.

### S4 · Sesiones no revocables — **media**
- `server/app.js:113-117`: el logout solo pide al navegador que borre la cookie. **[verificado]** La misma cookie sigue dando 200 en `/api/me/view` después del logout (vive 8 h).
- `server/app.js:54-59`: `sessionUser` no mira `testers.active`. Regenerar un PIN o desactivar a un probador no corta sus sesiones abiertas. Pasa lo mismo con `iae_super` (1 h).
- **Cambio:** añadir `testers.sessions_valid_after timestamptz` y rechazar tokens con `iat` anterior. Regenerar el PIN, desactivar y hacer logout actualizan ese valor. Otra opción es una tabla `sessions(sid, revoked_at)`, consultada en la misma query que `getUser`.

### S5 · scrypt síncrono ×10 por intento en un endpoint anónimo — **media**
- `server/testers.js:46-50` recorre los 10 probadores con `scryptSync`: **~270 ms de CPU bloqueando el event loop por intento** (medido).
- En local congela a todos los usuarios; en Vercel se factura como CPU. `auth/pin`, `auth/login` y `auth/super` lo disparan antes del bloqueo efectivo, que además se puede anular (S3).
- **Cambio:** guardar además `pin_lookup = HMAC-SHA256(SESSION_SECRET, pin)` con índice único, buscar por ese valor (una consulta) y verificar solo esa fila con `crypto.scrypt` asíncrono. El HMAC funciona también como *pepper*: sin el secreto, un volcado de la tabla no se puede atacar por fuerza bruta.

### S6 · create_salida no valida quién retira: el código de retiro llega a terceros — **media**
- `server/commands/requests.js:19` y `server/domain/requests.js:38-41`: `pickupBy` puede ser **cualquier** persona. Queda `pickupKind: 'no_autorizado'` y pasa a Recepción.
- `approveRequest` (`domain/requests.js:90-92`) no revisa la elegibilidad y avisa a esa persona.
- **[verificado]** `u_p1` creó una salida de Joseph con `pickupBy: 'p7'` (Wei Chen, otra familia). Al aprobarla Recepción, Wei recibió: "Estás autorizado(a) para retirar a Joseph Rodríguez… Código: 8011".
- De paso, el padre aprende el nombre de cualquier id de persona (`describePickup` en los avisos y `briefPerson` en su vista, `parent.js:20`).
- **Cambio:** en `create_salida`, exigir que `pickupBy` esté en `pickupCandidates(ctx, studentId, fecha)`; si no, 400 `pickup_not_candidate`. En `approveRequest`, revalidar la elegibilidad y rechazar `no_autorizado`.

### S7 · Telemetría: el cliente elige `kind` libre y `data` no tiene tope — **media**
- `server/activity.js:53-66` acepta cualquier `kind` (`command`, `login`, `view`…). `summary` cuenta `kind='command'` sin filtrar `source` (`server/activity-queries.js:90-94`). **[verificado]** Un padre insertó un evento `kind: 'command'` con `ok: false`, que aparece como error del servidor en "Zonas calientes".
- `maskInput` limita la profundidad y el largo de cada string, pero no el número de claves. Un lote puede guardar ~1,5 MB (el límite de `readBody`), sin límite de frecuencia: crecimiento libre en Neon.
- **Cambio:**
  - Lista blanca de kinds del cliente (`screen_enter`, `screen_leave`, `modal_*`, `click`, `form_*`, `js_error`, `promise_rejection`, `visibility`, `session_*`, `simulator`).
  - Tope de 2 KB para `JSON.stringify(data)` por evento.
  - Máximo de ~30 lotes por minuto por `sid`.
  - En `summary`, filtrar `source='server'` donde corresponda.

### S8 · Exportación CSV sin neutralizar fórmulas — **media**
- `server/activity-queries.js:147`: `cell()` escapa las comillas, pero no las celdas que empiezan con `=`, `+`, `-`, `@`, tab o CR. **[verificado]** Se guardó `name: '=HYPERLINK("http://x")'` desde la telemetría de un padre, y la hoja la abre el super admin en Excel.
- **Cambio:** en `cell()`, anteponer `'` si `/^[=+\-@\t\r]/.test(s)`.

### S9 · Adjuntos: permiso por dueño en vez de por entidad; subidas sin cuota — **baja**
- `server/projections/access.js:21-24`: garita puede abrir **cualquier** adjunto cuyo dueño retira hoy, incluidos los certificados médicos que esa persona subió como padre.
- `access.js:10`: un padre abre cualquier adjunto de un cotitular, incluso los de hijos de otra familia de ese cotitular. Los ids son aleatorios (40 bits), así que el riesgo práctico es bajo, pero la regla está mal planteada.
- `server/commands/attachments.js:13-24`: sin cuota por persona. Un padre puede llenar la base con blobs de 512 KB que nunca se borran (huérfanos).
- **Cambio:**
  - Garita solo ve `purpose IN ('cedula','foto')` y `att.id = persons.doc_attachment_id` de quien retira.
  - Para padres, comprobar por entidad: la `excusa` de un hijo propio o el documento de un autorizado propio.
  - Cuota de unas 20 subidas por persona al día y borrado de huérfanos de más de 24 h.
  - Revisar en Chrome si un PDF servido con `Content-Security-Policy: sandbox` (`app.js:220`) se muestra; si no, servir los PDF con `attachment`.

### S10 · Datos sensibles en claro en `audit_log` — **baja**
- `server/commands/run.js:7-11,20`: `sanitize` solo trunca, así que `add_authorization` guarda la `cedula` y el `phone` de personas nuevas en `audit_log.input`. La actividad sí los enmascara (`activity.js:5`).
- `activity_events` guarda `ip` y `ua` sin retención automática.
- **Cambio:** reutilizar `maskInput` en `runCommand` y definir una retención (ver R7).

### S11 · Cliente: sin CSP ni SRI; algunos campos sin `esc()` — **baja**
- No se encontró XSS explotable: todo el texto de usuario pasa por `esc()` (incluido el chat, `views.js:225`, que escapa antes de aplicar `*negritas*`).
- Algunos campos quedan sin escapar y dependen de invariantes del servidor: `k.emoji`/`st.emoji` (`public/client/views.js:180`, `:350`), `badge(status)` (`:102`) y `r.color` en atributos `style`/`fill` (`:524-561`). Hoy vienen del seed; si un día se editan desde la UI, son inyectables.
- `public/index.html:27` carga qrcodejs de cdnjs sin `integrity`. `vercel.json` no envía `Content-Security-Policy` ni `frame-ancestors`.
- **Cambio:**
  - Pasar esos campos por `esc()`.
  - Añadir `integrity` + `crossorigin` al script.
  - En `vercel.json`: `Content-Security-Policy: default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com 'sha256-…'` (para el script en línea de `super.html:9`), `img-src 'self' data:` y `frame-ancestors 'none'`.

### S12 · SQL con interpolación de identificadores — **baja** (endurecimiento)
- `server/db/repo.js:14-37` (`insertRow`, `insertRows`, `patchRow`) interpolan tabla y columnas a partir de las claves del objeto. Hoy todas las llamadas pasan objetos literales, así que no hay inyección. Pero basta que alguien pase `input` tal cual para abrirla.
- Los valores siempre van parametrizados. `activity-queries.js` interpola solo constantes (`SESSION_GAP_MIN`, `alias`).
- Bugs menores en ese mismo archivo:
  - `new Date(f.from).toISOString()` (líneas 16-17) lanza `RangeError` con fechas inválidas, y responde 500 en vez de 400.
  - `errorsOnly=false` activa el filtro (línea 25: cualquier string es verdadero).
- **Cambio:** en `insertRow`/`patchRow`, `assert(/^[a-z][a-zA-Z0-9]*$/.test(k))` y lista blanca de tablas; en `where()`, validar fechas y `errorsOnly === 'true'`.

### S13 · Fugas menores de información — **baja**
- `server/app.js:82`: `/api/health` es público y expone `revision` y el tipo de base de datos (la revisión permite medir la actividad).
- `api/index.js:22`: el 503 devuelve `e.message`, que con un error de `pg` puede incluir el host de Neon.
- `server/config.js:16`: `SUPER_KEY` no exige longitud mínima.
- `server/session.js:23`: el `pinToken` sirve para varios logins durante 10 min.
- **Cambio:** `health` público solo con `{ok}`; mensaje genérico en el 503 y el detalle al log; `SUPER_KEY` de al menos 24 caracteres en `loadConfig`; `pinToken` de un solo uso (su `jti` en `login_attempts` o en una tabla corta).

---

## 3. Lógica y casos borde

| # | Archivo:línea | Escenario que falla | Cambio |
|---|---|---|---|
| L1 | `server/domain/requests.js:33`, `:36` | **[verificado]** `create_salida` con `date: '2026-13-45'` y `time: '29:99'` sale **aprobada automáticamente**: `localToMs` desborda a 2028 y cumple la anticipación. Una salida del 1 de septiembre (pasada) queda pendiente y Recepción puede aprobarla: `approveRequest` no mira la fecha. | Validar con ida y vuelta: `new Date(date+'T00:00Z')` debe devolver la misma fecha, y `0≤h≤23`, `0≤m≤59`. Rechazar fechas anteriores a hoy (en la zona de la escuela) y, para hoy, horas pasadas. En `approveRequest`, rechazar si `req.date < hoy`. |
| L2 | `server/domain/eligibility.js:17`; `autoapprove.js:11`; `requests.js:40` | La elegibilidad usa **hoy** y no la fecha de la salida. **[verificado]** El tío `p4` tiene una temporal del 16 al 30 de septiembre, y una salida del **15 de octubre** se auto-aprobó como `temporal`. Ese día la garita la bloqueará con 409. Al revés, una temporal que empieza mañana hace que la salida de mañana llegue a Recepción como "no autorizada". | Pasar a `pickupEligibility(ctx, studentId, personId, date = hoy)` el `req.date` en la creación, la auto-aprobación y la aprobación, y en `pickupCandidates` del formulario y del bot. |
| L3 | `server/domain/requests.js:90` | **[verificado]** Con `pickupBy: 'nobody'` la salida se crea, y al aprobarla `pk.hasAccount` lanza `TypeError`: 500 y la solicitud queda atascada. | Resuelto por la validación de S6. Además, un `if (!pk) conflict('pickup_person_missing')`. |
| L4 | `requests.js:41`, `:86`, `:154` vs `:193-197` | `pickupKind` se congela al crear la salida, pero `markExit` usa la elegibilidad actual. **[verificado]** Salida con la abuela "siempre". El padre revoca y Recepción la re-autoriza "una vez". `request_confirmation` da 409 `confirmation_not_needed` y `mark_exit` da 409 `confirmation_required`: **nadie puede entregar** al estudiante. | En `requestConfirmation` usar `pickupEligibility(...).kind === 'una_vez'` en vez de `req.pickupKind`, y recalcular `pickupKind` al aprobar. |
| L5 | `requests.js:187-199` | **[verificado]** Garita marcó `retirado` el 18 una salida del **25**: `mark_exit` no exige la fecha de hoy (`scan_code` sí). Las salidas `aprobada` de días pasados no vencen nunca y dejan sin consumir la autorización de una vez. | En `markExit`, exigir `req.date === todayOf(ctx)`. Al leer, tratar `aprobada` con fecha pasada como "vencida" (o con un cierre diario). |
| L6 | `eligibility.js:10` | Una autorización `una_vez` no tiene fecha: la dada en enero sigue vigente en junio. | Añadir `valid_to` opcional a `una_vez` (por defecto 7 días) o fecha obligatoria. |
| L7 | `requests.js:168-176` | **[verificado]** Garita pide confirmación. Ana responde **NO** y luego Carlos responde **Sí**: `confirmada` y el estudiante sale. Gana la última respuesta. Además, `confirm_pickup` no exige que se haya pedido confirmación ni que sea de una vez. | Si ya hay `negada`, `confirm_pickup(true)` responde 409 `pickup_denied`, y hace falta un nuevo `request_confirmation` de garita (queda en la historia). Exigir `status='pendiente'` en `pickup_confirmations`. |
| L8 | `requests.js:137-148`; `bot/conversation.js:163-168` | **[verificado]** Tras `request_confirmation`, Carlos cancela desde la app. Ana sigue en `confirm_pickup`: su "Sí" da 409 y el rollback **borra su mensaje**, y "hola" responde "Responde SÍ para confirmar…". Queda atrapada hasta escribir "cancelar". `conversation_state.updated_at` nunca se usa, así que un borrador de ayer sigue vivo hoy. | En `cancelRequest`, `rejectRequest` y `markExit`, limpiar `alert_pickup` y `confirm_pickup` de todos los titulares. En `handleIncoming`, descartar los estados con más de 2 h o de otro día. En los pasos `confirm_pickup` y `alert_pickup`, si la solicitud ya no está `aprobada`, limpiar y explicar. |
| L9 | `requests.js:101-104`; `conversation.js:138-161` | El aviso proactivo **sobrescribe** la conversación en curso: se pierde un borrador de salida a medias. Con dos salidas aprobadas seguidas, "NO" cancela solo la última. Cualquier otro texto (por ejemplo "¿quién es?") borra el aviso sin respuesta (`:160-161`). **[verificado]** Tras el retiro, un "NO" tardío recibe "No te entendí". | Guardar los avisos pendientes como lista `{requestId}` y no pisar `draft`. Ante texto no reconocido, repetir la pregunta. Si la solicitud ya está `retirado`, responder "ya salió a las X con Y; llama a recepción al …" y avisar a Recepción. |
| L10 | `server/commands/admin.js:96`; `server/db/repo.js:129-132`; `public/client/views.js:319`; `public/client/state.js:49-53` | `mark_notifications_read` marca leídos los avisos **de rol para todo el rol**, y el cliente lo llama solo 800 ms después de abrir "Inicio". Con dos recepcionistas (o garita con TV y móvil), el primero que abre la app apaga los avisos del otro. Los toasts (`state.js:24-27`, solo los no leídos) no llegan a aparecer. | Tabla `notification_reads(notification_id, user_id)` para los avisos de rol; los personales siguen con `read_at`. |
| L11 | `server/domain/bus.js:67-72` | **[verificado]** Emily tiene una excusa de **ausencia aceptada** para hoy, y "¿Dónde está?" responde "está en el plantel". Tampoco mira fines de semana ni feriados. | Antes del caso "en el plantel", buscar excusas `aceptada`/`pendiente` de hoy (`ausencia` → "no asistió hoy"; `tardanza` → "llega tarde"). Comprobar el día de la semana. |
| L12 | `bus.js:106`, `:110`; `conversation.js:114` | **[verificado]** Con una ruta sin monitora, `mark_no_bus` viola el CHECK de `notifications` y da 500. "Joseph **mañana** no va en el bus" registra el opt-out de **hoy** en la ida ("manana" se lee como la mañana). Un opt-out repetido vuelve a notificar. No hay forma de deshacerlo. | Si `monitorId` es nulo, avisar a `recepcion`. Aceptar fecha (hoy/mañana) en `mark_no_bus` y en el bot. Notificar solo si hubo `INSERT`. Añadir el comando `undo_no_bus`. |
| L13 | `bus.js:85`, `:88-99` | Los padres **no** reciben aviso de `no_abordo` (solo Recepción). `set_trip_status` no tiene máquina de estados: `finalizado` puede volver a `programado`, y dos `en_ruta` seguidos reescriben `startedAt`. `markBoarding` no valida que `stopId` sea de la ruta ni el opt-out o retiro previo. | Avisar a los titulares en `no_abordo`. Transiciones permitidas: `programado→en_ruta→finalizado`. Validar la parada y rechazar abordaje si el estudiante tiene opt-out o está `retirado`. |
| L14 | `server/bot/nlp.js:14`, `:25-30`, `:75`; `conversation.js:22-24` | **[verificado]** Casos que fallan:<br>• "el 25/09/2026 a las 2 pm" da **20:26** (toma el año como hora).<br>• "el 15/30" da `2026-30-15`.<br>• "hoy en la mañana" da **mañana**.<br>• "a las 3 y media" da 15:00.<br>• "hoy la busca su tía Marta" da intent `desconocido`.<br>• "Joseph faltará mañana, pido permiso" da `salida`.<br>• "al mediodía" se toma como nombre de quien retira.<br>• "el 5/1" (en septiembre) da enero (pasado).<br>• `resolvePickup` elige al primer candidato que comparta **cualquier** palabra: "la retira Carmen Gómez" puede escoger a Laura Gómez, titular con el mismo apellido. | En `parseTime`: ignorar números de 4 dígitos pegados a `/`, y aceptar "y media", "y cuarto", "mediodía". En `parseDate`: reemplazar "(hoy\|en) la manana" antes de buscar "manana"; validar día y mes; si dd/mm ya pasó, usar el año siguiente. Añadir `busca` y `recoge` al intent `salida`. Si hay palabras de falta (`falt`, `ausen`), priorizar `excusa`. En `resolvePickup`, puntuar por coincidencias (nombre y apellido > apellido) y preguntar si hay empate. |
| L15 | `requests.js:137-148` | La máquina de estados tiene huecos: el personal no puede cancelar una salida `aprobada`; se permiten salidas duplicadas del mismo estudiante el mismo día; `cancelRequest` no avisa al otro titular ni al autorizado con cuenta que **ya recibió el código**. | Comando `staff_cancel_request` (capability `aprobar`). Rechazar una segunda salida `pendiente`/`aprobada` del mismo estudiante y fecha. Al cancelar, avisar a los titulares y al autorizado con cuenta. |
| L16 | `public/client/format.js:16`, `:27-28`; `views.js:29`, `:247`, `:397`, `:582`; `state.js:30` | El "hoy" viene del servidor, pero las horas (`fmtClock`, `fmtTs`, `nowHHMM`, el reloj y "pronto" en la TV de garita) usan la **zona y la hora del navegador**. Un móvil con otra zona o con la hora desfasada muestra horas equivocadas en avisos y abordajes, y la TV resalta mal. `SKEW` se calcula y no se usa. | Formatear con `Intl.DateTimeFormat('es-PA', { timeZone: V.settings.timezone })` y usar `serverNow()` en `nowHHMM`. |
| L17 | `requests.js:15-18` | `uniqueCode` usa `Math.random` y no hay restricción única: dos `create_salida` concurrentes pueden repetir código (probabilidad baja), y `scan_code` tomaría el primero. | `CREATE UNIQUE INDEX ON requests(date, code) WHERE kind='salida'` + reintento; `crypto.randomInt`. |
| L18 | `public/client/simulator.js:251-264` | La "instancia única" del simulador es por pestaña. Dos probadores que lo arrancan a la vez ejecutan `reset_demo` sobre la base compartida y se borran los datos mutuamente (y los de quien esté probando a mano). | Guardar un candado en el servidor (`app_meta` `sim_lock` con vencimiento) y rechazar un `reset_demo` del simulador mientras otro corre, o en local no reiniciar. |

---

## 4. Rendimiento y costo (Vercel + Neon)

Medido en PGlite tras `seed_load` con 700 estudiantes (704 estudiantes, 700 personas, 1 285 tutelas, 593 autorizaciones, solo 88 solicitudes):

| Vista | Consultas en serie | JSON |
|---|---|---|
| Recepción (`u_s2`) | 21 | **462 KB** |
| Admin (`u_s1`) | 24 | 466 KB |
| Profesor (`u_s3`) | 20 | 53 KB |
| Garita (`u_s6`) | 19 | 4 KB |
| Padre (`u_p1`) | 20 | 5 KB |
| `create_salida` (comando) | **55** | — |

**R1 · Revisión global como ETag: cada comando invalida todas las pantallas — alto**
- `server/commands/run.js:21` sube `app_meta.revision` en **todo** comando, y `app.js:203-208` la usa como ETag de todos los usuarios.
- **[verificado]** Los comandos de solo lectura `where_is`, `day_summary` y `mark_notifications_read` subieron la revisión (2 → 3 → 4).
- El ciclo típico: un aviso nuevo llega a un padre, su cliente llama a `mark_notifications_read` y la revisión vuelve a subir. Cada dispositivo abierto pide entonces la vista completa: Recepción, 460 KB y 21 consultas.
- Con N dispositivos y B cambios por minuto hay N×B reconstrucciones por minuto. Además, cada 200 deja una fila en `activity_events`.
- **Cambio:** marcar los comandos con `bump: false` en `register` (`where_is`, `day_summary`, `mark_notifications_read`, `scan_code`). Quien los ejecuta ya recibe su vista en la respuesta (`app.js:232`). A medio plazo, ETag por usuario (hash de la vista, o revisión por "ámbito": familia, garita, recepción).

**R2 · N+1 y lecturas de más en `repo.js` — alto**
- `server/db/repo.js:66-73`: `withTitulares` lee **todas** las tutelas (1 285 filas) en cada `getStudent` y `studentsOfPerson`. Un `create_salida` llama a `getStudent` unas 8 veces (guard, creación, elegibilidad ×2, auto-aprobación, docentes…): ~10 000 filas leídas para crear una solicitud.
- `repo.js:170`: `getRoute` carga todas las rutas y paradas para devolver una.
- `repo.js:79-88`: `hydrateRequests` siempre trae eventos y confirmaciones, incluso para `uniqueCode` (`requests.js:16`) y la auto-aprobación (`autoapprove.js:15`), que solo necesitan `code` o `status`.
- `domain/notifications.js:18-21`: `notifyTeachers` hace `listStaff` completo por aviso. `eligibility.js:26`, `:28` y `:37` resuelven persona o estudiante uno por uno.
- `projections/access.js:22-28`: por **cada imagen** que pide garita (la TV muestra una por salida) se vuelve a hacer `listRequests` del día hidratado. Para profesor, se cargan **todas** las excusas del colegio y se hace un `getStudent` por cada una.
- **Cambio:** `WHERE student_id = ANY($1)` en `withTitulares`; `getRoute` con `WHERE id=$1`; `listRequests(..., { hydrate: false })`; `listStaff` una vez por comando (en `ctx`); `canSeeAttachment` con una sola consulta `EXISTS (…)` por rol.

**R3 · Vistas de Recepción y Admin sin límite temporal — alto**
- `server/projections/staff.js:25`: todo el historial de solicitudes (con eventos).
- `staff.js:31`: todas las personas con cédula y teléfono.
- `staff.js:52`: **todos** los avisos de rol desde siempre.
- `staff.js:69` / `repo.js:138-142`: `listAllChats` carga **todos los mensajes de WhatsApp de todas las familias**, y cada `notifyPerson` con teléfono copia el aviso al chat (`notifications.js:10`).
- La vista del padre crece igual: `parent.js:16` (solicitudes), `:36` (avisos) y `:46` (chat).
- Con meses de uso son varios MB por reconstrucción, y el cliente repinta toda la página con `innerHTML`.
- **Cambio:**
  - Solicitudes: hoy, pendientes y los últimos 14 días, con un comando `search_requests` para el resto.
  - Avisos: los últimos 100.
  - Chats en admin: solo el resumen por `chat_key` (último mensaje y cuántos hay), y el chat completo bajo demanda.
  - Personas: solo las referenciadas por los estudiantes visibles, con cédula y teléfono bajo demanda.

**R4 · Sondeo cada 3 s, también con la pestaña oculta — medio**
- `public/client/api.js:45` hace `setInterval(onChange, 3000)` sin mirar `document.hidden`.
- Cada sondeo es una invocación de la función, dos consultas (`getUser` y `getRevision`, `app.js:57`, `:203`) y la verificación HMAC.
- Orden de magnitud: un dispositivo son **1 200 invocaciones por hora**; 20 pantallas abiertas 10 h son ~240 000 al día. Además, Neon nunca llega a suspender el cómputo por inactividad mientras quede una pestaña abierta.
- **Cambio:** pausar con `visibilitychange`; 3 s solo para garita y recepción en primer plano, 10–15 s para padres, y *backoff* hasta 30 s tras varios 304 seguidos. Para el 304, validar solo el HMAC y la revisión (una consulta); `getUser` solo cuando cambia la revisión.

**R5 · Arranque en frío — medio**
- `api/index.js:14` ejecuta `bootstrap` en cada instancia nueva: dos transacciones con `pg_advisory_xact_lock`, DDL `CREATE TABLE IF NOT EXISTS schema_migrations`, `SELECT` de versiones y comprobación de seed. Todo eso va después del handshake TLS con Neon y, si el cómputo de Neon estaba suspendido, después de despertarlo.
- `server/db/client.js:13` crea un `Pool` con `max: 3` por instancia. Con muchas instancias concurrentes conviene el endpoint *pooled* de Neon (`-pooler`) e `idleTimeoutMillis` corto.
- **Cambio:** migrar en el despliegue (`npm run migrate` en el build o una llamada manual), y en runtime hacer solo un `SELECT max(version)` sin lock. Usar `DATABASE_URL` del *pooler* y comprobar que Vercel y Neon estén en la misma región.

**R6 · Estáticos con `no-store` — bajo**
- `vercel.json:9-15` aplica `Cache-Control: no-store` a `/(.*)`, incluidos `views.js`, `styles.css`, etc. Cada carga de página los descarga completos.
- **Cambio:** `no-store` solo para `/api/(.*)`; `no-cache` (revalidar con ETag) para `/client/*` e `index.html`.

**R7 · Crecimiento de `activity_events` y `audit_log` — medio**
- `activity_events` recibe una fila por petición no 304 (`app.js:263-279`) más los lotes del cliente (clics, pantallas, visibilidad). Cada fila repite `ua` (hasta 200 caracteres), `ip` y `data`. Con 10 probadores activos se esperan decenas de MB por semana, y el plan gratuito de Neon es de 0,5 GB.
- Solo se borra a mano (`/api/super/purge`).
- Los índices (`schema.js:84-86`) no incluyen `at` sola, pero `summary` filtra por rango de fechas y ejecuta **9 consultas** que recorren la tabla (`activity-queries.js:54-128`), cada 10 s mientras `/super` está abierto.
- `audit_log` recibe una fila por **cada** comando (`run.js:20`), incluido cada `mark_notifications_read`.
- **Cambio:** índice `(at)` (o BRIN); borrado automático de más de 30 días, barato, al entrar a `/super` o en 1 de cada 100 peticiones; `ua` una vez por `sid`; no auditar `mark_notifications_read`; en `summary`, una consulta por bloque con `FILTER` en vez de 9 recorridos.

**R8 · El registro de actividad espera antes de terminar la petición — bajo**
- `app.js:296`: `await recordRequest(...)` en el `finally` suma un INSERT a la duración facturada de cada petición, aunque la respuesta ya salió.
- **Cambio:** no registrar las vistas 200 del sondeo (solo las de carga inicial) o agruparlas.

---

## 5. Calidad de código y mantenibilidad (priorizado)

1. **Reglas de negocio duplicadas en cliente y servidor.** `public/client/model.js` repite `isAuthActive`, `pickupEligibility`, `pickupCandidates` y `busPosition` de `server/domain/eligibility.js` y `bus.js`. `public/client/format.js:1` dice ser "copia de server/domain/text.js". Ya divergen (por ejemplo, `fmtClock` usa la zona del navegador). Conviene un módulo puro compartido, servido como `/client/shared.js` e importado por ambos lados.
2. **Esquema sin integridad:** fechas y horas como `text` (`server/db/schema.js:30`, `:34`), por lo que L1 no se detecta en la base. Faltan FKs en `requests.requested_by`, `pickup_by` y `decided_by`, `notifications.person_id` y `staff_id`, y `trip_boardings.student_id`. Tampoco hay `UNIQUE(date, code)`. Una migración `004` con `CHECK (date ~ '^\d{4}-\d{2}-\d{2}$' AND date::date IS NOT NULL)` o columnas `date`/`time` reales.
3. **Accesos sin comprobar nulos que terminan en 500:** `requests.js:90` (`pk.hasAccount`), `bus.js:45` (`off.name`), `bus.js:62` (`monBy.name`), `conversation.js:125` (`mon.name`), `conversation.js:158` y `:165` (`req` nulo tras un reinicio). Un helper `mustGet(q, table, id, code)` que lance un 404 o 409 con código.
4. **Faltan pruebas de lo que falla en este informe:** validación de fecha, hora y `pickupBy`; respuestas contradictorias en una_vez; estados de conversación tras cancelar; lectura de avisos de rol con dos usuarios; `kind` falso en la telemetría; CSV con `=`; límite de intentos con un acierto en medio; NLP con año, "y media" y "en la mañana". El cliente (`views.js`, `state.js`, `simulator.js`) no tiene **ninguna** prueba.
5. **`public/client/views.js` (831 líneas)** concentra padres, escuela, garita, TV, bus, modales y formularios en HTML armado con strings. Se puede partir en archivos por área (`views-parent.js`, `views-school.js`, `views-gate.js`, `views-bus.js`, `modals.js`) sin cambiar de técnica.
6. **`server/app.js` (300 líneas)** mezcla el router, login, `/super`, estáticos, adjuntos y el registro de actividad en una sola cadena de `if`. Extraer `routes/auth.js`, `routes/super.js` y `routes/app.js` con la misma firma `(req, res, ctx)`.
7. **Constantes repetidas:** las capacidades están en `server/projections/index.js:6` (`ALL_CAPS`) y en `server/commands/admin.js:11` (`CAPS`). Roles y estados aparecen como literales en decenas de sitios. Un `server/domain/constants.js` y su reflejo en el cliente.
8. **Máquina de estados del bot implícita:** `handleStep` (`conversation.js:128-204`) es una cadena de `if` sobre `st.step`, sin TTL ni validación de la solicitud referida (origen de L8 y L9). Una tabla `{ step: { onYes, onNo, onOther, expiresMin } }` la haría explícita y fácil de probar.
9. **Nombres ambiguos:** `st` es estudiante en el dominio y estado de conversación en `conversation.js:50-51` y `:128`; `loadSalida` también carga excusas; `currentLeg` devuelve la posición GPS; `hist`, `pk` y `el` obligan a leer el contexto. Hay mezcla de inglés (comandos) y español (estados).
10. **Documentación desalineada:**
    - `VERCEL-DEPLOY.md:3-6` no menciona `SUPER_KEY` ni `PILOT_PIN_SHARED`.
    - `docs/superpowers/specs/2026-09-20-probadores-y-actividad-design.md` se contradice: la línea 64 dice que `reset_demo` y `seed_load` **no** tocan la actividad, y la línea 103 (pruebas) dice que la vacían.
    - La spec base (§4) dice que `create_salida` "valida candidato de retiro", y el código no lo hace (S6).

---

## 6. Lo que está bien

- Capas limpias: `domain/` y `bot/` no conocen HTTP; los comandos corren en **una transacción** con auditoría y revisión; las proyecciones solo leen.
- `SELECT … FOR UPDATE` en las transiciones de solicitudes (`requests.js:22`), lo que evita dobles retiros concurrentes.
- SQL de valores 100 % parametrizado; `listRequests` y `hydrate` con marcadores generados.
- Sesión HMAC con `timingSafeEqual`, `HttpOnly` y `SameSite=Strict` (evita CSRF sin tokens), `Secure` en producción. `X-Forwarded-For` solo se confía en serverless.
- PINs con scrypt y sal, mostrados una sola vez. `/super` con cookie propia, `Path=/api` y segundo factor.
- Adjuntos bien servidos: lista blanca de MIME sin SVG en las subidas, `nosniff`, `CSP sandbox` y nombre de archivo saneado.
- Aislamiento por rol en las proyecciones, con pruebas específicas: padre sin datos de otra familia, garita solo con las salidas de hoy, profesor solo con sus grados.
- En el cliente, `esc()` se aplica de forma consistente: no se encontró XSS explotable.
- ETag/304 y registro de actividad que no guarda los 304 y enmascara cédula, teléfono y PIN.
- Pruebas rápidas y deterministas (PGlite en memoria, reloj controlado): 87 pruebas en ~26 s. Solo dos dependencias de producción.

---

## 7. Plan recomendado (impacto / esfuerzo)

| # | Cambio | Resuelve | Esfuerzo |
|---|---|---|---|
| 1 | **Validar salidas:** fecha y hora reales y no pasadas; `pickupBy ∈ pickupCandidates(fecha)`; `approveRequest` revalida y no acepta `no_autorizado` ni persona nula. Con pruebas. | L1, L3, S6 | **S** (½ día) |
| 2 | **Elegibilidad por fecha de la salida** + `mark_exit` solo para hoy + `pickupKind` recalculado al aprobar y al pedir confirmación. | L2, L4, L5 | **S** (½ día) |
| 3 | **Confirmaciones y bot seguros:** un NO bloquea hasta nueva solicitud de garita; limpiar `alert_pickup`/`confirm_pickup` al cancelar, rechazar o retirar; TTL de 2 h en `conversation_state`; respuesta correcta a un "NO" después del retiro. | L7, L8, L9 | **S–M** (1 día) |
| 4 | **Acceso y sesiones:** `auth/options` con sesión; no borrar el contador de IP al acertar y claves por superficie; `login_attempts` fuera del reset; `sessions_valid_after` por probador; `allowed_users` por probador y `DEMO_MODE` para `reset_demo` y el `chatKey` ajeno. | S1–S4, S13 | **M** (1–2 días) |
| 5 | **Revisión solo cuando cambia algo:** `bump: false` para comandos de lectura y `mark_notifications_read`; sondeo en pausa con la pestaña oculta y con *backoff*; `no-store` solo en `/api`. | R1, R4, R6 | **S** (½ día) |
| 6 | **Quitar N+1 en `repo.js`:** tutelas filtradas, `getRoute` directo, `hydrate: false`, `canSeeAttachment` con una sola consulta, `listStaff` en `ctx`. | R2 | **S–M** (1 día) |
| 7 | **Recortar las vistas de Recepción y Admin:** ventana de 14 días + pendientes, últimos 100 avisos, chats de admin como resumen, personas bajo demanda. | R3 | **M** (1–2 días) |
| 8 | **Avisos de rol con lectura por usuario** (`notification_reads`). | L10 | **M** (1 día) |
| 9 | **Telemetría y actividad:** lista blanca de kinds, tope de 2 KB en `data`, límite por `sid`, CSV sin fórmulas, índice `(at)`, retención de 30 días, `maskInput` en `audit_log`. | S7, S8, S10, R7 | **S** (½ día) |
| 10 | **Bot NLP + pruebas:** año en fechas, "y media", "en la mañana", validar dd/mm, "busca", falta + permiso → excusa, `mark_no_bus` con fecha, `resolvePickup` por puntaje con desempate. | L12, L14 | **M** (1–2 días) |

Después: la integridad del esquema (calidad #2), el cliente con zona de la escuela (L16), el módulo compartido cliente/servidor (calidad #1) y partir `views.js` y `app.js` (calidad #5 y #6).
