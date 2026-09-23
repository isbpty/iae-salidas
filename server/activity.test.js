import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, call, loginAs, loginSuper, CONFIG } from './test-helpers.js';
import { maskInput, classify, clientInfo, sanitizeFingerprint } from './activity.js';

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

  /* a successful command records its revision and masked input (logout revoked the old cookie: log in again) */
  const again = await loginAs(base, 'u_p1', made[4].pin);
  const okCmd = await post(base, '/api/commands/mark_notifications_read', { pin: '1' }, again);
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

test('clientInfo: geolocation only behind Vercel; the IP only trusts x-forwarded-for there', () => {
  const headers = {
    'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'UA/1',
    'x-vercel-ip-country': 'PA', 'x-vercel-ip-country-region': '8', 'x-vercel-ip-city': encodeURIComponent('Ciudad de Panamá'),
    'x-vercel-ip-latitude': '8.98', 'x-vercel-ip-longitude': '-79.52', 'x-vercel-ip-timezone': 'America/Panama',
  };
  const req = { socket: { remoteAddress: '10.0.0.5' }, headers };
  const local = clientInfo(req, false);
  assert.equal(local.ip, '10.0.0.5', 'a direct listener never trusts a forwarded header (S: IP spoofing)');
  assert.equal(local.geo, null, 'no Vercel edge, no geo');
  const remote = clientInfo(req, true);
  assert.equal(remote.ip, '203.0.113.9');
  assert.deepEqual(remote.geo, { country: 'PA', region: '8', city: 'Ciudad de Panamá', lat: 8.98, lng: -79.52, tz: 'America/Panama' });
  assert.equal(clientInfo({ socket: {}, headers: {} }, true).geo, null, 'serverless but no Vercel headers: still null');
});

test('sanitizeFingerprint keeps only the whitelisted device-fingerprint keys', () => {
  assert.deepEqual(sanitizeFingerprint({ platform: 'Win32', fp: 'abc123', evil: 'drop table', cookie: 'steal-me' }), { platform: 'Win32', fp: 'abc123' });
  assert.equal(sanitizeFingerprint({ evil: 1 }), null, 'nothing left of the whitelist: null, not an empty object');
  assert.equal(sanitizeFingerprint(null), null);
  assert.equal(sanitizeFingerprint('nope'), null);
});

test('login/pin/switch/super_login events carry the IP geolocation when the request is serverless', async () => {
  const t = await makeTestApp({ config: { serverless: true } }); const { base, close } = await t.listen();
  const { result: made } = await t.run('create_testers', 'u_s1');
  const geoHeaders = {
    'x-forwarded-for': '198.51.100.7', 'x-vercel-ip-country': 'PA', 'x-vercel-ip-country-region': '4',
    'x-vercel-ip-city': 'David', 'x-vercel-ip-latitude': '8.43', 'x-vercel-ip-longitude': '-82.43', 'x-vercel-ip-timezone': 'America/Panama',
  };
  const geo = { country: 'PA', region: '4', city: 'David', lat: 8.43, lng: -82.43, tz: 'America/Panama' };
  const call2 = (path, body, cookie) => call(base, path, { method: 'POST', body, cookie, headers: geoHeaders });

  await call2('/api/auth/pin', { pin: made[0].pin });
  const login = await call2('/api/auth/login', { userId: 'u_p1', pin: made[4].pin });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await call2('/api/auth/switch', { userId: 'u_p2' }, cookie);
  const sup = await call2('/api/auth/super', { pin: made[0].pin, key: CONFIG.superKey });
  assert.equal(sup.status, 200);

  const ev = await rows(t);
  const byKind = Object.fromEntries(ev.map((e) => [e.kind, e]));
  assert.deepEqual(byKind.pin.data, { geo }); assert.equal(byKind.pin.ip, '198.51.100.7');
  assert.deepEqual(byKind.login.data, { geo });
  assert.deepEqual(byKind.switch_user.data, { geo });
  assert.deepEqual(byKind.super_login.data, { geo });
  /* geo never leaks into events that are not the entry points listed in the brief */
  assert.equal(ev.find((e) => e.kind === 'view'), undefined, 'no view yet in this test, but just in case: never geo-tagged');
  await close(); await t.close();
});

test('geolocation stays null without the Vercel headers, even when serverless; spoofed Vercel headers are ignored outside serverless', async () => {
  const t1 = await makeTestApp({ config: { serverless: true } }); const s1 = await t1.listen();
  const { result: made1 } = await t1.run('create_testers', 'u_s1');
  await post(s1.base, '/api/auth/login', { userId: 'u_p1', pin: made1[4].pin });
  assert.equal((await rows(t1))[0].data, null, 'serverless, but no x-vercel-ip-* headers at all: no geo key');
  await s1.close(); await t1.close();

  const t2 = await makeTestApp({ config: { serverless: false } }); const s2 = await t2.listen();
  const { result: made2 } = await t2.run('create_testers', 'u_s1');
  await call(s2.base, '/api/auth/login', {
    method: 'POST', body: { userId: 'u_p1', pin: made2[4].pin },
    headers: { 'x-vercel-ip-country': 'PA', 'x-vercel-ip-city': 'Panamá' },
  });
  const row = (await rows(t2))[0];
  assert.equal(row.data, null, 'not serverless: Vercel-looking headers from an untrusted caller are never trusted');
  await s2.close(); await t2.close();
});

test('session_start events keep only the whitelisted fingerprint keys and copy fp to its own column', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const cookie = await loginAs(base, 'u_p1');
  const events = [{
    kind: 'session_start', name: 'app', data: {
      width: 1280, height: 800, lang: 'es-PA', screenWidth: 1512, screenHeight: 982, devicePixelRatio: 2, colorDepth: 24,
      languages: ['es-PA', 'es'], platform: 'MacIntel', hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
      tz: 'America/Panama', connection: '4g', uaData: { brands: ['Chrome 128'], mobile: false, platform: 'macOS' }, standalone: false,
      fp: 'abc123def456fp01', evil: 'drop table activity_events', cookie: 'steal-me',
    },
  }];
  const r = await post(base, '/api/telemetry', { events }, cookie);
  assert.equal(r.json.stored, 1);
  const [ev] = await t.db.query("SELECT * FROM activity_events WHERE kind='session_start' ORDER BY id DESC LIMIT 1");
  assert.equal(ev.fp, 'abc123def456fp01');
  assert.equal(ev.data.evil, undefined, 'unknown keys are dropped, not just unmasked');
  assert.equal(ev.data.cookie, undefined);
  assert.equal(ev.data.platform, 'MacIntel'); assert.equal(ev.data.tz, 'America/Panama');
  assert.deepEqual(ev.data.uaData, { brands: ['Chrome 128'], mobile: false, platform: 'macOS' });
  assert.equal(ev.data.width, 1280, 'width/height keep their usual (viewport) meaning');

  /* a non-session_start event never writes the fp column, even if it happens to carry an `fp` key */
  const other = await post(base, '/api/telemetry', { events: [{ kind: 'click', name: 'x', data: { fp: 'nope', note: 'ok' } }] }, cookie);
  assert.equal(other.json.stored, 1);
  const [clickEv] = await t.db.query("SELECT * FROM activity_events WHERE kind='click' ORDER BY id DESC LIMIT 1");
  assert.equal(clickEv.fp, null); assert.deepEqual(clickEv.data, { fp: 'nope', note: 'ok' });
  await close(); await t.close();
});

test('POST /api/super/fp records the super admin\'s own device fingerprint (needs the super cookie, not the app session)', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const { result: made } = await t.run('create_testers', 'u_s1');
  assert.equal((await post(base, '/api/super/fp', { fp: { platform: 'Win32', fp: 'superfp01' } })).status, 401, 'no cookie at all');
  const app = await loginAs(base, 'u_s1', made[0].pin);
  assert.equal((await post(base, '/api/super/fp', { fp: { platform: 'Win32', fp: 'superfp01' } }, app)).status, 401, 'an app session is not a super session');

  const sup = await loginSuper(base, made[0].pin);
  const r = await post(base, '/api/super/fp', { fp: { platform: 'Win32', evil: 'drop table', fp: 'superfp01' } }, sup);
  assert.deepEqual(r.json, { ok: true });
  const [ev] = await t.db.query("SELECT * FROM activity_events WHERE kind='session_start' AND role='super' ORDER BY id DESC LIMIT 1");
  assert.equal(ev.tester_id, 't1'); assert.equal(ev.fp, 'superfp01'); assert.equal(ev.data.platform, 'Win32'); assert.equal(ev.data.evil, undefined);
  /* classify() ignores this path: recordRequest never adds a second, redundant 'super_action' row for it */
  assert.equal((await t.db.query("SELECT count(*)::int AS c FROM activity_events WHERE name = 'super/fp'"))[0].c, 0);
  await close(); await t.close();
});
