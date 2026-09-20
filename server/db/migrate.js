import { MIGRATIONS } from './schema.js';
import { seedIfEmpty } from './seed.js';

const LOCK = 727001;
/* Every instance that boots at the same time waits here, so two cold starts cannot both decide a
   migration (or the demo seed) is missing and run it twice. PGlite is single-process: no lock. */
const takeLock = async (db, q) => { if (db.kind === 'pg') await q.query('SELECT pg_advisory_xact_lock($1)', [LOCK]); };

export async function migrate(db) {
  await db.tx(async (q) => {
    await takeLock(db, q);
    await q.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await q.query('SELECT version FROM schema_migrations')).map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await q.exec(m.sql);
      await q.query('INSERT INTO schema_migrations(version) VALUES ($1)', [m.version]);
    }
  });
}

/* The one call a process makes before serving: schema up to date, demo data present. */
export async function bootstrap(db, env) {
  await migrate(db);
  await db.tx(async (q) => {
    await takeLock(db, q);
    await seedIfEmpty(q, env);
  });
}
