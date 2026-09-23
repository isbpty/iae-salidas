# Desplegar en Vercel con Neon

1. **Neon**: crea un proyecto y una base `iae_salidas`. Copia la cadena de conexión **del endpoint *pooled*** (el que Neon muestra con `-pooler` en el host, p. ej. `ep-xxxx-pooler.…`), con `?sslmode=require`. Cada instancia de Vercel abre su propio pool de hasta 3 conexiones (`server/db/client.js`); con varias instancias concurrentes el endpoint directo se queda sin conexiones rápido, y el *pooler* de Neon (PgBouncer) las multiplexa. Crea el proyecto de Neon en la misma región que el *deployment* de Vercel (la del proyecto, en *Settings → Functions → Region*) para no pagar la ida y vuelta entre regiones en cada consulta.
2. **Vercel**: importa el repo `isbpty/iae-salidas` (rama `connected-pilot` o `main`). Framework: *Other*. Sin comando de build.
3. **Variables de entorno** (Production y Preview):
   - `DATABASE_URL` = cadena de Neon
   - `SESSION_SECRET` = 32+ caracteres aleatorios (`openssl rand -hex 32`)
   - `PILOT_PIN` = el PIN compartido del demo
   - `SUPER_KEY` = clave de `/super`, **24 caracteres o más** (con una más corta la app arranca igual, deja un aviso en el log y `/super` responde 503 `super_key_too_short` hasta que se cambie)
   - `DEMO_MODE=false` cuando haya datos reales (sin reinicio, sin carga de prueba, sin el teléfono del simulador)
   - Avisos push de `/super` (opcional): genera las claves una vez con `npx web-push generate-vapid-keys` y pon `VAPID_PUBLIC_KEY` (la "Public Key"), `VAPID_PRIVATE_KEY` (la "Private Key", secreta) y `VAPID_SUBJECT` = `mailto:tu-correo`. Sin las tres los avisos quedan apagados. Si cambias las claves, cada celular tiene que volver a pulsar "Activar avisos".
4. Deploy. La primera petición crea las tablas y siembra los datos.
5. Prueba: `https://<proyecto>.vercel.app/api/health` → `{"ok":true}` (con sesión añade `db` y `revision`) y abre la raíz para entrar. Si algo falla al arrancar, la respuesta es un 503 `service_unavailable` y el detalle queda en los logs de la función.

Notas
- `api/index.js` es la única función; `server/**` se incluye vía `vercel.json`. `public/` (`index.html` y `client/`) se sirve como estático (`outputDirectory`).
- `/super-sw.js`, `/super-manifest.webmanifest` e `/icons/*` salen de `public/`; `vercel.json` les pone `Service-Worker-Allowed: /`, `Cache-Control: no-cache` y el tipo del manifest. Para instalar `/super` en el celular y activar los avisos, ver el README ("Avisos en el celular").
- Los clientes en `*.vercel.app` sondean cada 3 s (no hay SSE en serverless).
- Para reiniciar los datos entra como Administración y pulsa "↺ Reiniciar" (solo en modo demo).
- Si cambias el PIN o el secreto, las sesiones abiertas expiran al recargar.
