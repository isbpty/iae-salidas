import { MIGRATIONS } from './schema.js';

export async function migrate(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  await db.tx(async (q) => {
    if (db.kind === 'pg') await q.query('SELECT pg_advisory_xact_lock(727001)');
    const done = new Set((await q.query('SELECT version FROM schema_migrations')).map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await q.exec(m.sql);
      await q.query('INSERT INTO schema_migrations(version) VALUES ($1)', [m.version]);
    }
  });
}
