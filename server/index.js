import http from 'node:http';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { seedIfEmpty } from './db/seed.js';
import { createApp } from './app.js';
import { SimulatorTransport } from './transports/whatsapp.js';
import { SimulatedGps } from './transports/gps.js';

const config = loadConfig();
const db = await openDb(config);
await migrate(db);
await db.tx((q) => seedIfEmpty(q, { now: new Date(), tz: 'America/Panama' }));
const app = createApp({ db, config, transport: new SimulatorTransport(), gps: new SimulatedGps(), now: () => new Date() });
http.createServer(app.handler).listen(config.port, () => console.log(`IAE Salidas en http://localhost:${config.port} · base de datos: ${db.kind}`));
