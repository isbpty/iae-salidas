import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, call, loginAs, loginSuper, CONFIG } from './test-helpers.js';

const post = (base, path, body, cookie) => call(base, path, { method: 'POST', body, cookie });

test('/super has its own access: super admin PIN plus SUPER_KEY, cookie apart from the app', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const { result: made } = await t.run('create_testers', 'u_s1');
  assert.equal((await post(base, '/api/auth/super', { pin: '4321', key: CONFIG.superKey })).status, 401, 'shared PIN is not super');
  assert.equal((await post(base, '/api/auth/super', { pin: made[1].pin, key: CONFIG.superKey })).status, 401, 'a normal tester is not super');
  assert.equal((await post(base, '/api/auth/super', { pin: made[0].pin, key: 'wrong' })).status, 401, 'the super PIN alone is not enough');
  assert.equal((await post(base, '/api/auth/super', { pin: made[0].pin })).status, 401);

  const sup = await loginSuper(base, made[0].pin);
  assert.ok(sup.startsWith('iae_super='));
  assert.equal((await call(base, '/api/me/view', { cookie: sup })).status, 401, 'the super cookie is not an app session');
  assert.equal((await call(base, '/api/activity/me', { cookie: sup })).json.tester.id, 't1');

  const app = await loginAs(base, 'u_s1', made[0].pin);
  assert.equal((await call(base, '/api/activity/summary', { cookie: app })).status, 401, 'the app session of the super tester cannot read the panel');
  assert.equal((await post(base, '/api/super/regenerate', { testerId: 't2' }, app)).status, 401);
  assert.equal((await post(base, '/api/commands/regenerate_tester_pin', { testerId: 't2' }, app)).json.error, 'unknown_command', 'no super command lives in the app');

  const re = (await post(base, '/api/super/regenerate', { testerId: 't2' }, sup)).json;
  assert.match(re.pin, /^\d{6}$/); assert.notEqual(re.pin, made[1].pin);
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_p1', pin: made[1].pin })).status, 401, 'old PIN dead');
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_p1', pin: re.pin })).status, 200);
  assert.equal((await post(base, '/api/super/regenerate', { testerId: 'zz' }, sup)).status, 404);
  assert.equal((await post(base, '/api/super/rename', { testerId: 't2', name: '  Ana  ' }, sup)).json.name, 'Ana');
  assert.equal((await post(base, '/api/super/rename', { testerId: 't2', name: '' }, sup)).status, 400);
  assert.equal((await post(base, '/api/super/purge', { beforeDays: 0 }, sup)).json.deleted, 0);
  const audit = await t.db.query("SELECT actor_name, summary FROM audit_log WHERE actor_role = 'super' ORDER BY id");
  assert.equal(audit.length, 3); assert.equal(audit[0].actor_name, 'Super admin (Super admin)'); assert.match(audit[0].summary, /Regeneró el PIN/);

  const ev = await t.db.query("SELECT kind, ok, tester_id, name FROM activity_events WHERE kind LIKE 'super%' ORDER BY id");
  assert.deepEqual(ev.filter((e) => e.kind === 'super_login').map((e) => e.ok), [false, false, false, false, true]);
  const actions = ev.filter((e) => e.kind === 'super_action');
  assert.equal(actions.length, 6, 'five calls with the super cookie plus the rejected attempt from the app session');
  assert.equal(actions.filter((e) => !e.ok).length, 3, '401 without cookie, 404 unknown tester, 400 empty name');
  assert.ok(actions.filter((e) => e.ok).every((e) => e.tester_id === 't1'));

  await post(base, '/api/auth/super/logout', {}, sup);
  assert.equal((await call(base, '/api/activity/me', { cookie: sup })).status, 401, 'logout revokes the super cookie on the server, not only in the browser');
  for (let i = 0; i < 10; i++) await post(base, '/api/auth/super', { pin: 'no', key: 'no' });
  assert.equal((await post(base, '/api/auth/super', { pin: made[0].pin, key: CONFIG.superKey })).status, 429, 'rate limited per IP');
  await close(); await t.close();
});

test('without SUPER_KEY nobody can open /super, and /super is served as a page', async () => {
  const t = await makeTestApp({ config: { superKey: '' } }); const { base, close } = await t.listen();
  const { result: made } = await t.run('create_testers', 'u_s1');
  assert.equal((await post(base, '/api/auth/super', { pin: made[0].pin, key: '' })).status, 401);
  const page = await call(base, '/super');
  assert.equal(page.status, 200); assert.ok(page.text.includes('client/super.js'));
  assert.equal((await call(base, '/super.html')).status, 200);
  await close(); await t.close();
});

test('regenerating a PIN cuts the open sessions of that tester; regenerating your own keeps the /super page open', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const { result: made } = await t.run('create_testers', 'u_s1');
  const app = await loginAs(base, 'u_p1', made[1].pin);
  const other = await loginAs(base, 'u_p2', made[2].pin);
  const sup = await loginSuper(base, made[0].pin);
  assert.equal((await call(base, '/api/me/view', { cookie: app })).status, 200);
  await post(base, '/api/super/regenerate', { testerId: 't2' }, sup);
  assert.equal((await call(base, '/api/me/view', { cookie: app })).status, 401, 'the old session of t2 dies with its PIN');
  assert.equal((await call(base, '/api/me/view', { cookie: other })).status, 200, 'other testers keep their sessions');

  const own = await post(base, '/api/super/regenerate', { testerId: 't1' }, sup);
  assert.equal(own.status, 200); assert.match(own.json.pin, /^\d{6}$/);
  assert.equal((await call(base, '/api/activity/me', { cookie: sup })).status, 401, 'the previous super cookie is revoked');
  const fresh = own.headers.get('set-cookie').split(';')[0];
  assert.equal((await call(base, '/api/activity/me', { cookie: fresh })).status, 200, 'the page that regenerated its own PIN gets a fresh cookie');
  await close(); await t.close();
});

test('/super edits which demo users a tester may open (null = all)', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const { result: made } = await t.run('create_testers', 'u_s1');
  const sup = await loginSuper(base, made[0].pin);
  const app = await loginAs(base, 'u_p1', made[1].pin);
  assert.equal((await post(base, '/api/super/allowed', { testerId: 't2', userIds: ['u_p1', 'u_s2'] }, app)).status, 401, 'only with the super cookie');
  const set = await post(base, '/api/super/allowed', { testerId: 't2', userIds: ['u_p1', 'u_s2', 'u_p1'] }, sup);
  assert.equal(set.status, 200); assert.deepEqual(set.json.allowedUsers, ['u_p1', 'u_s2']);
  assert.equal((await post(base, '/api/super/allowed', { testerId: 't2', userIds: ['nope'] }, sup)).json.error, 'unknown_user');
  assert.equal((await post(base, '/api/super/allowed', { testerId: 't2', userIds: 'u_p1' }, sup)).json.error, 'invalid_user_ids');
  assert.equal((await post(base, '/api/super/allowed', { testerId: 'zz', userIds: null }, sup)).status, 404);
  const listed = (await call(base, '/api/activity/testers', { cookie: sup })).json.find((x) => x.id === 't2');
  assert.deepEqual(listed.allowedUsers, ['u_p1', 'u_s2']); assert.equal(listed.pinHash, undefined); assert.equal(listed.pinLookup, undefined);
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_s1', pin: made[1].pin })).status, 403);
  assert.equal((await post(base, '/api/super/allowed', { testerId: 't2', userIds: null }, sup)).json.allowedUsers, null);
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_s1', pin: made[1].pin })).status, 200, 'null opens every user again');
  const audit = await t.db.query("SELECT summary FROM audit_log WHERE command = 'super/allowed' ORDER BY id");
  assert.equal(audit.length, 2);
  await close(); await t.close();
});

test('super key attempts have their own counter: failing /super does not lock the app login, and vice versa', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const { result: made } = await t.run('create_testers', 'u_s1');
  for (let i = 0; i < 10; i++) await post(base, '/api/auth/pin', { pin: 'no' });
  assert.equal((await post(base, '/api/auth/pin', { pin: made[1].pin })).status, 429);
  assert.equal((await post(base, '/api/auth/super', { pin: made[0].pin, key: CONFIG.superKey })).status, 200, 'PIN failures do not count against /super');
  for (let i = 0; i < 10; i++) await post(base, '/api/auth/super', { pin: made[0].pin, key: 'wrong-key' });
  assert.equal((await post(base, '/api/auth/super', { pin: made[0].pin, key: CONFIG.superKey })).status, 429);
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_p1', pin: made[1].pin })).status, 200, 'the app login has its own counter');
  await close(); await t.close();
});
