import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, call, loginAs } from './test-helpers.js';
import { maskInput, classify } from './activity.js';

const post = (base, path, body, cookie) => call(base, path, { method: 'POST', body, cookie });
const rows = (t, where = '', params = []) => t.db.query('SELECT * FROM activity_events ' + where + ' ORDER BY id', params);

test('maskInput hides secrets, shortens bulk fields and truncates long strings', () => {
  const m = maskInput({ pin: '1234', pinToken: 'abc', cedula: '8-1-1', phone: '6000', dataBase64: 'x'.repeat(500), note: 'y'.repeat(300), nested: { cedula: '9', ok: 1 }, list: [{ phone: '1' }], empty: '' });
  assert.equal(m.pin, '***'); assert.equal(m.pinToken, '***'); assert.equal(m.cedula, '***'); assert.equal(m.phone, '***');
  assert.equal(m.dataBase64, '<500 bytes>');
  assert.equal(m.note.length, 201); assert.ok(m.note.endsWith('…'));
  assert.equal(m.nested.cedula, '***'); assert.equal(m.nested.ok, 1); assert.equal(m.list[0].phone, '***');
  assert.equal(m.empty, '');
  assert.equal(classify('health', 'GET'), null); assert.equal(classify('telemetry', 'POST'), null); assert.equal(classify('activity/summary', 'GET'), null);
  assert.deepEqual(classify('commands/create_salida', 'POST'), { kind: 'command', name: 'create_salida' });
});

test('every API request leaves a server event with who, what, duration and outcome', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const { result: made } = await t.run('create_testers', 'u_s1');
  await call(base, '/api/health'); await call(base, '/api/auth/options'); await call(base, '/api/me/view');
  assert.equal((await rows(t)).length, 0, 'health, options and anonymous polls are not recorded');

  assert.equal((await post(base, '/api/auth/login', { userId: 'u_p1', pin: 'wrong' })).status, 401);
  const login = await post(base, '/api/auth/login', { userId: 'u_p1', pin: made[4].pin });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  let ev = await rows(t);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].kind, 'login_failed'); assert.equal(ev[0].ok, false); assert.equal(ev[0].error, 'invalid_credentials'); assert.equal(ev[0].status, 401);
  assert.equal(ev[1].kind, 'login'); assert.equal(ev[1].ok, true); assert.equal(ev[1].tester_id, 't5'); assert.equal(ev[1].user_id, 'u_p1'); assert.equal(ev[1].role, 'parent');
  assert.match(ev[1].sid, /^[0-9a-f]{16}$/); assert.ok(ev[1].duration_ms >= 0); assert.equal(ev[1].ip, '127.0.0.1');

  const v = await call(base, '/api/me/view', { cookie });
  await call(base, '/api/me/view', { cookie, headers: { 'if-none-match': v.headers.get('etag') } });
  await call(base, '/api/attachments/att_p1', { cookie });
  const bad = await post(base, '/api/commands/approve_request', { requestId: 'x', pin: '9', cedula: '8-1', note: 'z'.repeat(300) }, cookie);
  assert.equal(bad.status, 403);
  await post(base, '/api/commands/nope', {}, cookie);
  await post(base, '/api/auth/switch', { userId: 'u_p2' }, cookie);
  await post(base, '/api/auth/logout', {}, cookie);
  ev = (await rows(t)).slice(2);
  const byName = Object.fromEntries(ev.map((e) => [e.name, e]));
  assert.equal(byName.view.kind, 'view'); assert.equal(byName.view.status, 200); assert.equal(byName.view.revision, v.json.revision); assert.equal(byName.view.sid, (await rows(t))[1].sid);
  assert.equal(byName.view_304, undefined, '304 polls are not recorded');
  assert.equal(byName.att_p1.kind, 'attachment'); assert.equal(byName.att_p1.status, 200);
  assert.equal(byName.approve_request.kind, 'command'); assert.equal(byName.approve_request.ok, false); assert.equal(byName.approve_request.error, 'forbidden_role'); assert.equal(byName.approve_request.status, 403);
  assert.deepEqual(byName.approve_request.data, { requestId: 'x', pin: '***', cedula: '***', note: 'z'.repeat(200) + '…' });
  assert.equal(byName.nope.error, 'unknown_command'); assert.equal(byName.nope.status, 404);
  assert.equal(byName['auth/switch'].kind, 'switch_user'); assert.equal(byName['auth/switch'].user_id, 'u_p2'); assert.equal(byName['auth/switch'].sid, byName.view.sid);
  assert.equal(byName['auth/logout'].kind, 'logout');
  assert.ok(ev.every((e) => e.source === 'server' && e.tester_id === 't5'));

  /* a successful command records its revision and masked input */
  const okCmd = await post(base, '/api/commands/mark_notifications_read', { pin: '1' }, cookie);
  const last = (await rows(t)).pop();
  assert.equal(last.ok, true); assert.equal(last.revision, okCmd.json.revision); assert.deepEqual(last.data, { pin: '***' });
  await close(); await t.close();
});

test('telemetry stores client events under the cookie identity only', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  assert.equal((await post(base, '/api/telemetry', { events: [{ kind: 'click' }] })).status, 401);
  const cookie = await loginAs(base, 'u_p1');
  const now = t.clock.now.getTime();
  const events = [
    { kind: 'screen_leave', name: 'parent:inicio', screen: 'parent:inicio', durationMs: 4200, at: now - 5000, testerId: 't9', userId: 'u_s1', sid: 'forged', data: { phone: '6', note: 'ok' } },
    { kind: 'js_error', error: 'TypeError: x is not a function', at: now - 4000 },
    { kind: 'click', name: 'openModal', target: 'newSalida', at: now + 10 * 86400000 },
    { nope: true }, 'junk', null,
  ];
  const r = await post(base, '/api/telemetry', { events }, cookie);
  assert.equal(r.status, 200); assert.equal(r.json.stored, 3);
  const ev = await t.db.query("SELECT * FROM activity_events WHERE source='client' ORDER BY id");
  assert.equal(ev.length, 3);
  assert.equal(ev[0].user_id, 'u_p1'); assert.equal(ev[0].tester_id, null); assert.equal(ev[0].role, 'parent'); assert.notEqual(ev[0].sid, 'forged');
  assert.equal(ev[0].duration_ms, 4200); assert.equal(new Date(ev[0].at).getTime(), now - 5000); assert.deepEqual(ev[0].data, { phone: '***', note: 'ok' });
  assert.equal(ev[1].error, 'TypeError: x is not a function');
  assert.equal(new Date(ev[2].at).getTime(), now + 1000, 'an implausible client clock falls back to the server clock');
  assert.equal((await t.db.query("SELECT count(*)::int AS c FROM activity_events WHERE source='server' AND name='POST telemetry'"))[0].c, 0);

  const big = await post(base, '/api/telemetry', { events: Array.from({ length: 150 }, (_, i) => ({ kind: 'click', name: 'n' + i })) }, cookie);
  assert.equal(big.json.stored, 100, 'batches are capped');
  assert.equal((await post(base, '/api/telemetry', {}, cookie)).json.stored, 0);
  await close(); await t.close();
});
