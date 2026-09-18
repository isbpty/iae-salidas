import { loadConfig } from '../server/config.js';
import { openDb } from '../server/db/client.js';
import { migrate } from '../server/db/migrate.js';
import { seedIfEmpty } from '../server/db/seed.js';
import { createApp } from '../server/app.js';
import { SimulatorTransport } from '../server/transports/whatsapp.js';
import { SimulatedGps } from '../server/transports/gps.js';

let appPromise;
function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const config = loadConfig();
      const db = await openDb(config);
      await migrate(db);
      await db.tx((q) => seedIfEmpty(q, { now: new Date(), tz: 'America/Panama' }));
      return createApp({ db, config, transport: new SimulatorTransport(), gps: new SimulatedGps(), now: () => new Date() });
    })().catch((e) => { appPromise = null; throw e; });
  }
  return appPromise;
}
export default async function handler(req, res) {
  try { const app = await getApp(); return await app.handler(req, res); }
  catch (e) { res.statusCode = 503; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: e.message })); }
}
