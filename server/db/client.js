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
    /* R5: a serverless instance can sit idle between requests for a while before it's recycled --
       without `idleTimeoutMillis` a pooled connection can outlive that idle stretch and hand back a
       connection Neon (or the OS) already closed on its end, surfacing as a random query failure on
       the next request instead of a clean reconnect. 10 s keeps a connection around across a quick
       burst of requests but lets it go well before that. */
    const pool = new pg.Pool({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: true }, max: 3, idleTimeoutMillis: 10000 });
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
