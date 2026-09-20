/* Carga datos de prueba a escala en la base configurada (PGlite local o DATABASE_URL).
   Uso: npm run seed:load -- --students 700 --seed 7 */
import { loadConfig } from '../config.js';
import { openDb } from './client.js';
import { migrate } from './migrate.js';
import { resetAll, seedDemo } from './seed.js';
import { seedLoad } from './seed-load.js';

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > -1 ? Number(process.argv[i + 1]) : dflt; };
const config = loadConfig();
const db = await openDb(config);
await migrate(db);
const started = Date.now();
const counts = await db.tx(async (q) => {
  await resetAll(q);
  await seedDemo(q, { now: new Date(), tz: 'America/Panama' });
  return seedLoad(q, { students: arg('students', 700), seed: arg('seed', 7), now: new Date(), tz: 'America/Panama' });
});
console.log(JSON.stringify({ db: db.kind, ms: Date.now() - started, ...counts }, null, 2));
await db.close();
