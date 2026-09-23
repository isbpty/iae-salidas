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

/* R5: `bootstrap` runs once per cold instance (api/index.js memoizes it for the life of the lambda,
   server/index.js calls it once at startup) -- but every cold start used to open two transactions
   with `pg_advisory_xact_lock` unconditionally -- DDL, a `SELECT` of every applied version, and a
   seed check -- all after the TLS handshake with Neon and, if its compute had suspended, after
   waking it up. The lock only exists to stop two *concurrent* cold starts from racing to
   migrate/seed at once; an instance whose schema is already current and whose seed already exists
   doesn't need it. This checks "is there work to do" with un-locked `SELECT`s first, and only takes
   the lock (and re-runs `migrate`, which re-checks under the lock -- another instance may have
   finished first) when a migration is actually missing or the demo seed is actually empty.
   No DDL runs on this unlocked path: `to_regclass` is a read-only catalog lookup, never a
   `CREATE TABLE IF NOT EXISTS`. That distinction matters on a genuinely fresh database -- two
   sessions racing an unlocked `CREATE TABLE IF NOT EXISTS` can both decide the table is missing and
   both try to create it; Postgres's own catalog (pg_type et al.) isn't protected by the table's own
   "IF NOT EXISTS", so the loser gets a 23505 instead of silently no-op'ing. A missing table here is
   just "needs work": fall through to `migrate()`, which creates it *inside* the locked transaction,
   where only one instance can be racing at a time. */
async function needsWork(db) {
  const r = await db.query("SELECT to_regclass('schema_migrations') AS t");
  if (!r[0] || !r[0].t) return true;
  const done = new Set((await db.query('SELECT version FROM schema_migrations')).map((row) => row.version));
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
