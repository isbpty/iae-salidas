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
  for (let i = 0; i < 27; i++) await post(s2.base, '/api/auth/pin', { pin: 'no' });
  assert.equal((await post(s2.base, '/api/auth/pin', { pin: '4321' })).status, 401, '30 guesses per address: the two failures above count too');
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

test('allowed_users limits which demo users a tester may open: login, switch, options and live sessions', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const { result: made } = await t.run('create_testers', 'u_s1');
  await t.db.query(`UPDATE testers SET allowed_users = '["u_p1","u_s2"]' WHERE id = 't2'`);
  const step1 = (await post(base, '/api/auth/pin', { pin: made[1].pin })).json;
  assert.deepEqual(step1.options.map((u) => u.id).sort(), ['u_p1', 'u_s2'], 'step one only offers the allowed users');
  const denied = await post(base, '/api/auth/login', { userId: 'u_s1', pinToken: step1.pinToken });
  assert.equal(denied.status, 403); assert.equal(denied.json.error, 'user_not_allowed');
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_s1', pin: made[1].pin })).json.error, 'user_not_allowed', 'one-step login too');
  const login = await post(base, '/api/auth/login', { userId: 'u_p1', pinToken: step1.pinToken });
  assert.equal(login.status, 200, 'a refused user does not spend the PIN token');
  const cookie = cookieOf(login);
  const options = await call(base, '/api/auth/options', { cookie });
  assert.deepEqual(options.json.map((u) => u.id).sort(), ['u_p1', 'u_s2']);
  const sw = await post(base, '/api/auth/switch', { userId: 'u_s1' }, cookie);
  assert.equal(sw.status, 403); assert.equal(sw.json.error, 'user_not_allowed');
  const ok = await post(base, '/api/auth/switch', { userId: 'u_s2' }, cookie);
  assert.equal(ok.status, 200);
  await t.db.query(`UPDATE testers SET allowed_users = '["u_p1"]' WHERE id = 't2'`);
  assert.equal((await call(base, '/api/me/view', { cookie: cookieOf(ok) })).status, 401, 'a session on a user that is no longer allowed stops working');
  assert.equal((await call(base, '/api/me/view', { cookie })).status, 200);
  /* The shared PIN has no tester: every user stays open. */
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_s1', pin: '4321' })).status, 200);
  await close(); await t.close();
});

test('GET /api/auth/options needs a session', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const anon = await call(base, '/api/auth/options');
  assert.equal(anon.status, 401);
  const cookie = cookieOf(await post(base, '/api/auth/login', { userId: 'u_p1', pin: '4321' }));
  const r = await call(base, '/api/auth/options', { cookie });
  assert.equal(r.status, 200); assert.ok(r.json.some((u) => u.id === 'u_s1'));
  await close(); await t.close();
});

test('a PIN token logs in once', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const { result: made } = await t.run('create_testers', 'u_s1');
  const step1 = (await post(base, '/api/auth/pin', { pin: made[1].pin })).json;
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_p1', pinToken: step1.pinToken })).status, 200);
  const again = await post(base, '/api/auth/login', { userId: 'u_p2', pinToken: step1.pinToken });
  assert.equal(again.status, 401); assert.equal(again.json.error, 'invalid_credentials');
  const shared = (await post(base, '/api/auth/pin', { pin: '4321' })).json;
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_p1', pinToken: shared.pinToken })).status, 200);
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_p1', pinToken: shared.pinToken })).status, 401, 'shared PIN tokens are single-use too');
  await close(); await t.close();
});

test('logout revokes every session of that tester; shared-PIN sessions are untouched', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const { result: made } = await t.run('create_testers', 'u_s1');
  const phone = cookieOf(await post(base, '/api/auth/login', { userId: 'u_p1', pin: made[1].pin }));
  const laptop = cookieOf(await post(base, '/api/auth/login', { userId: 'u_s2', pin: made[1].pin }));
  const otherTester = cookieOf(await post(base, '/api/auth/login', { userId: 'u_p2', pin: made[2].pin }));
  const shared = cookieOf(await post(base, '/api/auth/login', { userId: 'u_p5', pin: '4321' }));
  assert.equal((await post(base, '/api/auth/logout', {}, phone)).status, 200);
  assert.equal((await call(base, '/api/me/view', { cookie: phone })).status, 401, 'the old cookie no longer works after logout');
  assert.equal((await call(base, '/api/me/view', { cookie: laptop })).status, 401, 'logout closes the tester on every device');
  assert.equal((await call(base, '/api/me/view', { cookie: otherTester })).status, 200);
  assert.equal((await call(base, '/api/me/view', { cookie: shared })).status, 200);
  await post(base, '/api/auth/logout', {}, shared);
  assert.equal((await call(base, '/api/me/view', { cookie: otherTester })).status, 200, 'a shared-PIN logout revokes nobody');
  const again = cookieOf(await post(base, '/api/auth/login', { userId: 'u_p1', pin: made[1].pin }));
  assert.equal((await call(base, '/api/me/view', { cookie: again })).status, 200, 'logging in again right after works');
  await t.db.query("UPDATE testers SET active = false WHERE id = 't3'");
  assert.equal((await call(base, '/api/me/view', { cookie: otherTester })).status, 401, 'an inactive tester has no sessions');
  await close(); await t.close();
});

test('a correct PIN does not reset the per-IP counter, shared by step one and the one-step login', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const { result: made } = await t.run('create_testers', 'u_s1');
  /* Guesses on either surface fill the same `pinguess:` counter (30 in 15 minutes). */
  for (let i = 0; i < 15; i++) assert.equal((await post(base, '/api/auth/pin', { pin: 'no' })).status, 401);
  const users = ['u_p1', 'u_p2', 'u_p5', 'u_p6', 'u_p7'];
  for (let i = 0; i < 14; i++) assert.equal((await post(base, '/api/auth/login', { userId: users[i % 5], pin: 'no' })).status, 401);
  assert.equal((await post(base, '/api/auth/pin', { pin: made[1].pin })).status, 200);
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_p1', pin: made[1].pin })).status, 200);
  assert.equal((await post(base, '/api/auth/pin', { pin: 'no' })).status, 401, 'the thirtieth failure still answers');
  assert.equal((await post(base, '/api/auth/pin', { pin: made[1].pin })).status, 429, 'and then the IP is blocked');
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_p2', pin: made[1].pin })).status, 429, 'for the one-step login too');
  const rows = await t.db.query("SELECT key FROM login_attempts WHERE key LIKE 'pin:%' OR key LIKE 'login:%'");
  assert.equal(rows.length, 0, 'no separate pin:/login: counters for typed PINs');
  await t.run('reset_demo', 'u_s1', {});
  assert.equal((await post(base, '/api/auth/pin', { pin: made[1].pin })).status, 429, 'a demo reset does not wipe the counters');
  await close(); await t.close();
});

test('the per-user counter only blocks addresses that are failing too: nobody can lock an account from afar', async () => {
  const t = await makeTestApp({ config: { serverless: true } }); const { base, close } = await t.listen();
  const attempt = (ip, pin = 'no') => call(base, '/api/auth/login', { method: 'POST', body: { userId: 'u_s1', pin }, headers: { 'x-forwarded-for': ip } });
  for (let i = 0; i < 2; i++) assert.equal((await attempt('10.0.0.50')).status, 401);
  for (let i = 1; i <= 8; i++) assert.equal((await attempt('10.0.0.' + i)).status, 401);
  assert.equal((await attempt('10.0.0.50')).status, 401, 'eleven failures on u_s1, three from .50');
  assert.equal((await attempt('10.0.0.50', '4321')).status, 429, 'an address with failures is blocked for that user');
  assert.equal((await attempt('10.0.0.99', '4321')).status, 200, 'the real owner from a clean address still gets in');
  await close(); await t.close();
});
