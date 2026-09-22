# IAE Salidas

Plataforma de **salidas tempranas, excusas, autorizados, garita y bus escolar** para una escuela. Los padres piden por WhatsApp (simulado) o por la app; la escuela aprueba; la garita verifica identidad y marca el retiro; los dos titulares reciben el aviso.

Código: <https://github.com/isbpty/iae-salidas> · Diseño: [docs/superpowers/specs/2026-09-18-iae-salidas-relational-backend-design.md](docs/superpowers/specs/2026-09-18-iae-salidas-relational-backend-design.md)

## Correr en local

```bash
npm install
cp .env.example .env   # pon un SESSION_SECRET de 32+ caracteres y el PIN
npm run dev            # http://localhost:3000 · base de datos PGlite en data/pglite
npm test               # pruebas (node --test) sobre PGlite en memoria
npm run reset          # borra la base local; al arrancar se vuelve a sembrar
```

Sin `DATABASE_URL` el servidor usa PGlite (Postgres embebido). Con `DATABASE_URL` (Neon u otro Postgres) usa `pg`.

## Entrar: probadores con PIN propio

Cada persona real que prueba el piloto es un **probador** con su PIN de 6 dígitos (10 probadores, `t1` es el super admin). El login tiene dos pasos: primero el PIN (dice quién prueba), luego el usuario del demo con el que se quiere entrar. "Cambiar usuario" cambia de usuario sin volver a pedir el PIN. El PIN compartido de `PILOT_PIN` está apagado salvo que `PILOT_PIN_SHARED=true` (útil en local y para crear los probadores la primera vez con `POST /api/commands/create_testers` como Administración).

`/super` es una página aparte para el super admin: pide el PIN de `t1` **y** la clave `SUPER_KEY` (24 caracteres o más; vacía = la página no abre). Ahí se ve qué hace cada probador (pantallas, tiempo, acciones, errores, uso del simulador), se exporta CSV, se regeneran PINs y se elige con qué usuarios del demo puede entrar cada PIN (**👥 Usuarios**; vacío = todos).

Acceso y sesiones:

- **Usuarios permitidos** (`testers.allowed_users`): si un probador tiene lista, el paso 1 del login solo le ofrece esos usuarios y `auth/login` / `auth/switch` responden 403 `user_not_allowed` con cualquier otro; una sesión abierta con un usuario que se quita de la lista deja de valer. `null` = todos (el valor por defecto, para que el demo siga igual). El PIN compartido no tiene probador: abre todos.
- **Salir cierra todas las sesiones de ese PIN**, en todos los dispositivos (`testers.sessions_valid_after`). Lo mismo al regenerar el PIN o desactivar al probador. El "Salir" de `/super` también cierra las sesiones de `t1` en la app.
- **Intentos**: 10 fallos en 15 minutos bloquean esa dirección, con contadores separados para el PIN (`pin:`), el login (`login:`) y `/super` (`super:`). Acertar no reinicia el contador de la dirección, y reiniciar el demo tampoco. El contador por usuario solo bloquea direcciones que también fallan, así nadie puede bloquear la cuenta de otro desde fuera.
- El token del paso 1 sirve para **un** login. `GET /api/auth/options` pide sesión (lo usa "Cambiar usuario"); `/api/health` sin sesión responde solo `{ ok: true }`.
- **`DEMO_MODE`** (activo salvo `DEMO_MODE=false`): `reset_demo`, `seed_load` y escribir en el WhatsApp de otra persona (el teléfono del simulador) solo existen en modo demo; apagado responden 403 `demo_only`. Apágalo antes de cargar datos reales.

**PIN y migración `006_testers_access`.** Cada PIN se guarda como hash scrypt y además como `pin_lookup = HMAC-SHA256(SESSION_SECRET, pin)` con índice único: el login lo encuentra con una lectura y verifica una sola fila con scrypt asíncrono. Los probadores creados antes de esta migración (los 10 de producción) no tienen `pin_lookup` porque su PIN no se puede recuperar: siguen entrando por la ruta antigua (scrypt fila por fila, solo entre las que no tienen lookup) y **su primer login correcto escribe el lookup**. Crear o regenerar un PIN lo escribe siempre. No hace falta regenerar los PINs existentes. Si cambias `SESSION_SECRET`, ejecuta `UPDATE testers SET pin_lookup = NULL` para que vuelvan a la ruta antigua y se reescriban (y todas las sesiones se cierran, porque las cookies van firmadas con ese secreto).

El botón **▶ Simulador** recorre el guion del demo manejando la app de verdad, con explicación, foco, play/pausa, paso a paso y velocidad.

## Usuarios del demo

| Usuario | Rol | Qué ve |
|---|---|---|
| Carlos Rodríguez / Ana Pérez | Padres de Joseph (3°) y Sofía (Kínder) | App de padres y WhatsApp |
| Laura Gómez / Pedro Castillo | Padres de Mateo (3°) | Laura además es autorizada "una vez" para Joseph |
| Wei Chen | Padre de Emily (9°) | |
| Lic. Rosa Martínez | Administración | Todo, permisos, configuración, reinicio, vista dividida |
| Yadira Batista | Recepción | Aprueba salidas y excusas, autorizados, bitácora |
| Prof. Diana Ríos / Jorge Ávila / Mónica Salas | Docentes | Solo sus grados |
| Manuel Ortega | Garita | Salidas aprobadas de hoy, escaneo de código, foto del autorizado |
| Kenia Pérez / Lisbeth Moreno | Monitoras | Solo su ruta: abordó / bajó / no abordó, iniciar y finalizar viaje |

Cada dispositivo entra con su usuario; los cambios llegan a los demás en segundos.

## Reglas implementadas

- Un estudiante tiene hasta 2 titulares; una familia puede tener varios hijos.
- Autorizados `siempre`, `por tiempo` o `una vez (con confirmación)`; foto o cédula obligatoria para personas nuevas; la garita la ve al escanear el código.
- Auto-aprobación: titular + anticipación mínima + persona que retira titular o autorizada siempre/por tiempo + sin rechazos en 30 días. Lo demás pasa a Recepción.
- Una vez: la garita pide confirmación por WhatsApp a los titulares; sin confirmación no se entrega.
- Aviso proactivo con "Es correcto / NO" cuando retira una persona nueva, por tiempo o de una vez; con NO se cancela y se avisa a garita.
- Excusas (ausencia/tardanza) con adjunto opcional, aceptadas por Recepción, visibles para el docente.
- Bus: rutas, paradas, viajes del día, GPS simulado, "¿dónde está mi hijo?" según el estado real y "hoy no va en bus".
- Bitácora de todo y matriz de permisos editable.

## Qué es real y qué es simulado

Todo corre en el servidor sobre PostgreSQL con permisos por rol. **WhatsApp es un simulador**: el chat del navegador envía los mensajes al mismo bot que atendería un número real; el transporte real se conecta detrás de `server/transports/whatsapp.js`. El GPS es `server/transports/gps.js`, simulado con la forma de una API real.

## Despliegue

Ver [VERCEL-DEPLOY.md](VERCEL-DEPLOY.md). También hay un `Dockerfile` para correrlo en cualquier host.
