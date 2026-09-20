# Desplegar en Vercel con Neon

1. **Neon**: crea un proyecto y una base `iae_salidas`. Copia la cadena de conexión con `?sslmode=require`.
2. **Vercel**: importa el repo `isbpty/iae-salidas` (rama `connected-pilot` o `main`). Framework: *Other*. Sin comando de build.
3. **Variables de entorno** (Production y Preview):
   - `DATABASE_URL` = cadena de Neon
   - `SESSION_SECRET` = 32+ caracteres aleatorios (`openssl rand -hex 32`)
   - `PILOT_PIN` = el PIN compartido del demo
4. Deploy. La primera petición crea las tablas y siembra los datos.
5. Prueba: `https://<proyecto>.vercel.app/api/health` → `{"ok":true,"db":"pg",...}` y abre la raíz para entrar.

Notas
- `api/index.js` es la única función; `server/**` se incluye vía `vercel.json`. `public/` (`index.html` y `client/`) se sirve como estático (`outputDirectory`).
- Los clientes en `*.vercel.app` sondean cada 3 s (no hay SSE en serverless).
- Para reiniciar los datos entra como Administración y pulsa "↺ Reiniciar".
- Si cambias el PIN o el secreto, las sesiones abiertas expiran al recargar.
