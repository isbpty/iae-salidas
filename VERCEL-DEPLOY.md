# Vercel + Neon demo

This deployment keeps the original WhatsApp-style screen and simulator. A parent types in the original chat, the browser parser responds in the chat, and the resulting requests/notifications are stored in Neon and polled by reception/gate clients every 3 seconds.

Real WhatsApp is an explicit placeholder at `/api/whatsapp/status`. The Vercel build contains no Chromium or QR runtime.

## Setup

1. Create a Neon Free Postgres project and copy its pooled connection string.
2. Import this GitHub repository into Vercel and deploy the `connected-pilot` branch.
3. Add environment variables to Production and Preview:
   - `DATABASE_URL`: Neon pooled connection string
   - `SESSION_SECRET`: long random value generated outside chat
   - `PILOT_PIN`: demo PIN entered through Vercel's secret field
   - `PGSSL=require`
4. Redeploy, then open `/api/health`; expect `mode: vercel-neon-demo` and `whatsapp: placeholder`.
5. Test the original WhatsApp screen in one browser, reception in another, and gate in a third. Updates appear within about 3 seconds.

## Limits

Vercel Functions are request-bound, so there is no event-stream or long-running process. Neon Free compute sleeps after inactivity and wakes on a query. This is for demonstration, not live school pickup operations.
