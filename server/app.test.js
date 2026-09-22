import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, call, loginAs } from './test-helpers.js';

test('health, options and login lifecycle', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  assert.deepEqual((await call(base, '/api/health')).json, { ok: true }, 'public health says nothing about the database or its activity');
  assert.equal((await call(base, '/api/auth/options')).status, 401, 'the user directory needs a session');
  assert.equal((await call(base, '/api/auth/login', { method: 'POST', body: { userId: 'u_p1', pin: '0000' } })).status, 401);
  assert.equal((await call(base, '/api/me/view')).status, 401);
  const cookie = await loginAs(base, 'u_p1');
  assert.match(cookie, /^iae_session=/);
  const options = (await call(base, '/api/auth/options', { cookie })).json;
  assert.ok(options.find((u) => u.id === 'u_p1' && u.role === 'parent'));
  const health = (await call(base, '/api/health', { cookie })).json;
  assert.equal(health.ok, true); assert.equal(health.db, 'pglite'); assert.equal(typeof health.revision, 'number', 'with a session, health adds revision and db');
  const view = await call(base, '/api/me/view', { cookie });
  assert.equal(view.status, 200);
  assert.equal(view.json.view.user.id, 'u_p1');
  assert.equal(view.json.revision, 1);
  const etag = view.headers.get('etag');
  assert.equal((await call(base, '/api/me/view', { cookie, headers: { 'if-none-match': etag } })).status, 304);
  const out = await call(base, '/api/auth/logout', { method: 'POST', cookie });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  await close(); await t.close();
});

test('ten wrong PINs lock the user out', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  for (let i = 0; i < 10; i++) await call(base, '/api/auth/login', { method: 'POST', body: { userId: 'u_s2', pin: 'no' } });
  assert.equal((await call(base, '/api/auth/login', { method: 'POST', body: { userId: 'u_s2', pin: '4321' } })).status, 429);
  await close(); await t.close();
});

test('unknown commands are 404 and commands need a session', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  assert.equal((await call(base, '/api/commands/nope', { method: 'POST', body: {} })).status, 401);
  const cookie = await loginAs(base, 'u_p1');
  assert.equal((await call(base, '/api/commands/nope', { method: 'POST', body: {}, cookie })).status, 404);
  await close(); await t.close();
});

test('static serving is limited to index.html and client/', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  assert.equal((await call(base, '/')).status, 200);
  assert.equal((await call(base, '/client/api.js')).status, 200);
  for (const p of ['/server/app.js', '/data/pglite', '/.env', '/package.json', '/client/../package.json', '/client/.hidden', '/docs/x.md']) {
    assert.equal((await call(base, p)).status, 404, p);
  }
  await close(); await t.close();
});

test('a spoofed X-Forwarded-For cannot walk around the login limit', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const attempt = (userId, ip, pin = 'no') => call(base, '/api/auth/login', { method: 'POST', body: { userId, pin }, headers: { 'x-forwarded-for': ip } });
  for (let i = 0; i < 10; i++) assert.equal((await attempt('u_s2', '10.0.0.' + i)).status, 401);
  assert.equal((await attempt('u_s2', '10.0.0.200', '4321')).status, 429, 'ten wrong PINs still lock the user');
  await close(); await t.close();
});

test('the per-IP limit counts the real socket, not the header', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const attempt = (userId, ip, pin = 'no') => call(base, '/api/auth/login', { method: 'POST', body: { userId, pin }, headers: { 'x-forwarded-for': ip } });
  /* Ten failures spread over ten different users, each claiming a different address: no single
     user key reaches the limit, so only the IP key can be what blocks the eleventh try. */
  const ids = ['u_p1', 'u_p2', 'u_p5', 'u_p6', 'u_p7', 'u_s1', 'u_s2', 'u_s3', 'u_s4', 'u_s5'];
  for (const [i, userId] of ids.entries()) assert.equal((await attempt(userId, '10.0.0.' + (i + 1))).status, 401, userId);
  assert.equal((await attempt('u_s6', '10.0.0.99', '4321')).status, 429);
  await close(); await t.close();
});

test('a body with multi-byte characters survives being read in chunks', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const cookie = await loginAs(base, 'u_p1');
  const reason = 'Señorita Muñoz 🎒🏫 '.repeat(4000).trim();
  assert.ok(Buffer.byteLength(reason, 'utf8') > 70000, 'big enough to span several chunks');
  const r = await call(base, '/api/commands/create_salida', { method: 'POST', cookie, body: { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason } });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.reason, reason, 'no character was cut in half at a chunk boundary');
  assert.equal(r.json.view.requests.find((x) => x.id === r.json.result.id).reason, reason);
  await close(); await t.close();
});

test('with DEMO_MODE off, demo-only commands answer 403 demo_only', async () => {
  const t = await makeTestApp({ config: { demoMode: false } });
  await assert.rejects(t.run('reset_demo', 'u_s1', {}), /demo_only/);
  await assert.rejects(t.run('seed_load', 'u_s1', { students: 50 }), /demo_only/);
  await assert.rejects(t.run('whatsapp_inbound', 'u_s1', { text: 'Sí, confirmo', chatKey: 'p1' }), /demo_only/);
  await assert.rejects(t.run('whatsapp_inbound', 'u_s1', { text: 'hola', chatKey: 'unknown' }), /demo_only/);
  const own = await t.run('whatsapp_inbound', 'u_p1', { text: 'hola', chatKey: 'p1' });
  assert.equal(own.result.chatKey, 'p1', 'a parent still writes on their own chat');
  const err = await t.run('reset_demo', 'u_s1', {}).catch((e) => e);
  assert.equal(err.status, 403);
  await t.close();
  const demo = await makeTestApp();
  assert.ok((await demo.run('reset_demo', 'u_s1', {})).revision, 'demo mode is on by default');
  assert.equal((await demo.run('whatsapp_inbound', 'u_s1', { text: 'hola', chatKey: 'p1' })).result.chatKey, 'p1');
  await demo.close();
});

test('the Vercel entry answers 503 with a generic message and logs the detail', async () => {
  const prev = process.env.SESSION_SECRET;
  const logged = [];
  const origError = console.error;
  console.error = (...a) => logged.push(a);
  try {
    process.env.SESSION_SECRET = '';
    const { default: handler } = await import('../api/index.js?fail=' + Date.now());
    const res = { headers: {}, statusCode: 0, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    await handler({ url: '/api/health', method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(JSON.parse(res.body), { error: 'service_unavailable' });
    assert.ok(logged.some((a) => String(a[a.length - 1] && a[a.length - 1].message).includes('SESSION_SECRET')), 'the real reason goes to the log');
  } finally {
    console.error = origError;
    if (prev === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prev;
  }
});
