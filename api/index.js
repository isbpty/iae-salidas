import { loadConfig } from '../server/config.js';
import { openDb } from '../server/db/client.js';
import { bootstrap } from '../server/db/migrate.js';
import { createApp } from '../server/app.js';
import { SimulatorTransport } from '../server/transports/whatsapp.js';
import { SimulatedGps } from '../server/transports/gps.js';
import { createPushSender } from '../server/transports/push.js';

let appPromise;
function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const config = loadConfig();
      const db = await openDb(config);
      await bootstrap(db, { now: new Date(), tz: 'America/Panama' });
      return createApp({ db, config, transport: new SimulatorTransport(), gps: new SimulatedGps(), push: createPushSender(config), now: () => new Date() });
    })().catch((e) => { appPromise = null; throw e; });
  }
  return appPromise;
}
export default async function handler(req, res) {
  try { const app = await getApp(); return await app.handler(req, res); }
  catch (e) {
    /* The detail (a pg error may name the Neon host) goes to the log, never to the client. */
    console.error('api/index: app unavailable', e);
    res.statusCode = 503; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'service_unavailable' }));
  }
}
