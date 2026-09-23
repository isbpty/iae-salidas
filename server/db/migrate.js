import { MIGRATIONS } from './schema.js';
import { seedIfEmpty, isEmpty } from './seed.js';

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

/* R5: on a warm instance (the common case -- Vercel reuses a lambda, or the demo just restarts),
   `bootstrap` used to open two transactions with `pg_advisory_xact_lock` on *every single request*
   -- DDL, a `SELECT` of every applied version, and a seed check -- all after the TLS handshake with
   Neon and, if its compute had suspended, after waking it up. The lock only exists to stop two cold
   starts from racing to migrate/seed at once; a warm start doesn't need it. This checks "is there
   work to do" with one un-locked `SELECT` first, and only takes the lock (and re-runs `migrate`,
   which re-checks under the lock -- another instance may have finished first) when a migration is
   actually missing or the demo seed is actually empty. */
async function needsWork(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query('SELECT version FROM schema_migrations')).map((r) => r.version));
  if (MIGRATIONS.some((m) => !done.has(m.version))) return true;
  return isEmpty(db);
}

/* The one call a process makes before serving: schema up to date, demo data present. */
export async function bootstrap(db, env) {
  if (!(await needsWork(db))) return;
  await migrate(db);
  await db.tx(async (q) => {
    await takeLock(db, q);
    await seedIfEmpty(q, env);
  });
}
