/* One tiny adapter so domain code never knows whether it talks to Neon (pg) or PGlite. */
function wrap(conn, execFn) {
  return {
    query: async (sql, params = []) => (await conn.query(sql, params)).rows,
    exec: async (sql) => { await execFn(sql); },
  };
}

export async function openDb({ databaseUrl, dataDir } = {}) {
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const local = /localhost|127\.0\.0\.1/.test(databaseUrl);
    const pool = new pg.Pool({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: true }, max: 3 });
    return {
      kind: 'pg',
      ...wrap(pool, (sql) => pool.query(sql)),
      tx: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn(wrap(c, (sql) => c.query(sql)));
          await c.query('COMMIT');
          return r;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          throw e;
        } finally { c.release(); }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  await lite.waitReady;
  let chain = Promise.resolve();
  return {
    kind: 'pglite',
    ...wrap(lite, (sql) => lite.exec(sql)),
    tx: (fn) => {
      const run = chain.then(() => lite.transaction((t) => fn(wrap(t, (sql) => t.exec(sql)))));
      chain = run.catch(() => {});
      return run;
    },
    close: () => lite.close(),
  };
}
