import http from 'node:http';
import { openDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { seedDemo } from './db/seed.js';
import { createApp } from './app.js';
import { SimulatorTransport } from './transports/whatsapp.js';
import { SimulatedGps } from './transports/gps.js';
import { runCommand } from './commands/run.js';
import { buildView } from './projections/index.js';

export const TZ = 'America/Panama';
export const CONFIG = { secret: 's'.repeat(32), pin: '4321', databaseUrl: null, dataDir: null, port: 0, serverless: false, secure: false };
/* Friday 2026-09-18 10:30 in Panama: school hours, bus not on the road unless simulateBus. */
export const NOW = new Date('2026-09-18T15:30:00Z');

export async function makeTestApp({ now = NOW } = {}) {
  const db = await openDb({});
  await migrate(db);
  await db.tx((q) => seedDemo(q, { now, tz: TZ }));
  /* The clock advances one second per request so rows created by successive commands sort deterministically.
     Tests may set `clock.now` directly to jump in time. */
  const clock = { now };
  const tick = () => { clock.now = new Date(clock.now.getTime() + 1000); return clock.now; };
  const deps = { db, config: CONFIG, transport: new SimulatorTransport(), gps: new SimulatedGps(), now: tick };
  const app = createApp(deps);
  return {
    db, deps, app, clock,
    run: (name, userId, input = {}) => runCommand(deps, { userId, name, input }),
    view: (userId) => db.tx((q) => buildView(q, userId, { now: clock.now, transport: deps.transport, gps: deps.gps })),
    listen: async () => {
      const server = http.createServer(app.handler);
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
    },
    close: () => db.close(),
  };
}

/* HTTP helpers shared by the router tests. */
export async function call(base, path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
export async function loginAs(base, userId, pin = '4321') {
  const r = await call(base, '/api/auth/login', { method: 'POST', body: { userId, pin } });
  return r.headers.get('set-cookie').split(';')[0];
}
