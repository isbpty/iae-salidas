# Arquitectura

El diseño completo está en `docs/superpowers/specs/2026-09-18-iae-salidas-relational-backend-design.md`. Resumen:

- **Un servicio Node (ESM, sin framework)**: `server/app.js` enruta; `server/commands/*` ejecuta cada acción en una transacción con validación de rol y alcance; `server/domain/*` y `server/bot/*` contienen las reglas puras; `server/projections/*` arma lo que cada rol puede ver.
- **PostgreSQL**: `server/db/schema.js` (migraciones embebidas), `server/db/repo.js` (SQL), `server/db/seed.js` (datos del demo). Neon en producción; PGlite en local y pruebas.
- **Cliente**: `index.html` + `client/*.js`. Solo pinta la proyección y envía comandos; sin lógica de negocio.
- **Tiempo real**: SSE en local; en Vercel sondeo cada 3 s con `If-None-Match` (304 si nada cambió).
- **Seguridad**: cookie HMAC, PIN con límite de intentos, secretos obligatorios, estáticos restringidos a `index.html` y `client/`, adjuntos servidos solo a quien puede verlos.
- **Adaptadores**: `server/transports/whatsapp.js` (simulador; interfaz `send`) y `server/transports/gps.js` (simulado; interfaz `position`).

Flujo de una acción: navegador → `POST /api/commands/<nombre>` → `runCommand` → handler (dominio + repositorio + notificaciones + bitácora) → `COMMIT` → revisión +1 → respuesta con la proyección fresca → los demás clientes reciben `changed` (SSE) o ven cambiar el ETag.
