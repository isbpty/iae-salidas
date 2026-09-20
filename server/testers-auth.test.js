import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, call } from './test-helpers.js';
import { verifySession } from './session.js';

const post = (base, path, body, cookie) => call(base, path, { method: 'POST', body, cookie });
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];
const decode = (t, res) => verifySession(cookieOf(res).split('=')[1], t.deps.config.secret);

test('two-step login: the PIN names the tester, the second step picks the demo user', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  assert.equal((await post(base, '/api/auth/pin', { pin: '0000' })).status, 401);
  const shared = (await post(base, '/api/auth/pin', { pin: '4321' })).json;
  assert.equal(shared.tester, null); assert.ok(shared.pinToken); assert.ok(shared.options.some((u) => u.id === 'u_s1'));

  const { result: made } = await t.run('create_testers', 'u_s1');
  assert.equal(made.length, 10);
  const step1 = (await post(base, '/api/auth/pin', { pin: made[1].pin })).json;
  assert.deepEqual(step1.tester, { id: 't2', name: 'Probador 2', super: false });
  const login = await post(base, '/api/auth/login', { userId: 'u_p1', pinToken: step1.pinToken });
  assert.equal(login.status, 200);
  assert.equal(login.json.tester.id, 't2');
  const session = decode(t, login);
  assert.equal(session.userId, 'u_p1'); assert.equal(session.testerId, 't2'); assert.equal(session.super, false); assert.match(session.sid, /^[0-9a-f]{16}$/);
  const cookie = cookieOf(login);
  const view = (await call(base, '/api/me/view', { cookie })).json.view;
  assert.equal(view.user.super, undefined, 'the app never learns who is super'); assert.deepEqual(view.tester, { id: 't2', name: 'Probador 2', super: false });

  /* tampered or foreign token */
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_p1', pinToken: step1.pinToken + 'x' })).status, 401);
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_p1', pinToken: cookie.split('=')[1] })).status, 401, 'a session cookie is not a PIN proof');

  /* super admin */
  const sup = (await post(base, '/api/auth/pin', { pin: made[0].pin })).json;
  assert.equal(sup.tester.super, true);
  const supLogin = await post(base, '/api/auth/login', { userId: 'u_s1', pinToken: sup.pinToken });
  const supView = (await call(base, '/api/me/view', { cookie: cookieOf(supLogin) })).json.view;
  assert.equal(supView.tester.name, 'Super admin');
  assert.equal((await call(base, '/api/activity/summary', { cookie: cookieOf(supLogin) })).status, 401, 'an app session, even the super tester, cannot read the panel');

  /* switch keeps tester and sid */
  const sw = await post(base, '/api/auth/switch', { userId: 'u_s2' }, cookie);
  assert.equal(sw.status, 200); assert.equal(sw.json.user.id, 'u_s2');
  const s2 = decode(t, sw);
  assert.equal(s2.sid, session.sid); assert.equal(s2.testerId, 't2'); assert.equal(s2.userId, 'u_s2');
  assert.equal((await post(base, '/api/auth/switch', { userId: 'nope' }, cookie)).status, 404);
  assert.equal((await post(base, '/api/auth/switch', { userId: 'u_s2' })).status, 401);
  await close(); await t.close();
});

test('one-step login accepts a tester PIN or the shared PIN; shared can be disabled', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const { result: made } = await t.run('create_testers', 'u_s1');
  const one = await post(base, '/api/auth/login', { userId: 'u_p5', pin: made[2].pin });
  assert.equal(one.status, 200); assert.equal(decode(t, one).testerId, 't3');
  const sharedLogin = await post(base, '/api/auth/login', { userId: 'u_p5', pin: '4321' });
  assert.equal(sharedLogin.status, 200); assert.equal(decode(t, sharedLogin).testerId, null);
  const shared = (await call(base, '/api/me/view', { cookie: cookieOf(sharedLogin) })).json.view;
  assert.equal(shared.tester.name, 'Compartido');
  await close(); await t.close();

  const t2 = await makeTestApp({ config: { sharedPin: false } }); const s2 = await t2.listen();
  assert.equal((await post(s2.base, '/api/auth/login', { userId: 'u_p5', pin: '4321' })).status, 401);
  assert.equal((await post(s2.base, '/api/auth/pin', { pin: '4321' })).status, 401);
  for (let i = 0; i < 10; i++) await post(s2.base, '/api/auth/pin', { pin: 'no' });
  assert.equal((await post(s2.base, '/api/auth/pin', { pin: '4321' })).status, 429, 'step one is rate limited per IP');
  await s2.close(); await t2.close();
});

test('create_testers runs once from the shared PIN and never again', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('create_testers', 'u_s2'), /forbidden_role/);
  const { result: made } = await t.run('create_testers', 'u_s1');
  assert.equal(made.length, 10);
  await assert.rejects(t.run('create_testers', 'u_s1'), /testers_exist/);
  const audit = await t.db.query("SELECT summary FROM audit_log WHERE summary LIKE '%probadores%'");
  assert.equal(audit.length, 1);
  await t.close();
});
