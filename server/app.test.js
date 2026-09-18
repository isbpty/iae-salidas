import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, call, loginAs } from './test-helpers.js';

test('health, options and login lifecycle', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  assert.equal((await call(base, '/api/health')).json.ok, true);
  const options = (await call(base, '/api/auth/options')).json;
  assert.ok(options.find((u) => u.id === 'u_p1' && u.role === 'parent'));
  assert.equal((await call(base, '/api/auth/login', { method: 'POST', body: { userId: 'u_p1', pin: '0000' } })).status, 401);
  assert.equal((await call(base, '/api/me/view')).status, 401);
  const cookie = await loginAs(base, 'u_p1');
  assert.match(cookie, /^iae_session=/);
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
  for (const p of ['/server/app.js', '/data/pglite', '/.env', '/package.json', '/client/../package.json', '/client/.hidden', '/docs/x.md']) {
    assert.equal((await call(base, p)).status, 404, p);
  }
  await close(); await t.close();
});
