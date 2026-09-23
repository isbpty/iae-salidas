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
/* A 1x1 transparent PNG: the smallest upload the mime allowlist accepts. */
export const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
export const CONFIG = { secret: 's'.repeat(32), pin: '4321', sharedPin: true, superKey: 'clave-super-test-de-24-caracteres', databaseUrl: null, dataDir: null, port: 0, serverless: false, secure: false };
/* Friday 2026-09-18 10:30 in Panama: school hours, bus not on the road unless simulateBus. */
export const NOW = new Date('2026-09-18T15:30:00Z');

/* `push`: a MemoryPush (transports/push.js) to see the notices; none by default (push off). */
export async function makeTestApp({ now = NOW, config = {}, push = null } = {}) {
  const db = await openDb({});
  await migrate(db);
  await db.tx((q) => seedDemo(q, { now, tz: TZ }));
  /* The clock advances one second per request so rows created by successive commands sort deterministically.
     Tests may set `clock.now` directly to jump in time. */
  const clock = { now };
  const tick = () => { clock.now = new Date(clock.now.getTime() + 1000); return clock.now; };
  const deps = { db, config: { ...CONFIG, ...config }, transport: new SimulatorTransport(), gps: new SimulatedGps(), push, now: tick };
  const app = createApp(deps);
  return {
    db, deps, app, clock,
    run: (name, userId, input = {}) => runCommand(deps, { userId, name, input }),
    view: (userId) => db.tx((q) => buildView(q, userId, { now: clock.now, transport: deps.transport, gps: deps.gps, serverless: false })),
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

/* The /super page: super admin PIN + SUPER_KEY → its own cookie. */
export async function loginSuper(base, pin, key = CONFIG.superKey) {
  const r = await call(base, '/api/auth/super', { method: 'POST', body: { pin, key } });
  if (r.status !== 200) throw new Error('super login failed: ' + r.status + ' ' + (r.json && r.json.error));
  return r.headers.get('set-cookie').split(';')[0];
}
