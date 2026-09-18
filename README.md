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

## Usuarios del demo (PIN único: el de `PILOT_PIN`)

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
