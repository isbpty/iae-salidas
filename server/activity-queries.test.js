import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, call, loginAs, loginSuper } from './test-helpers.js';
import { insertRows } from './db/repo.js';
import { summary, events, exportCsv } from './activity-queries.js';

const T0 = new Date('2026-09-20T13:00:00Z').getTime();
const M = 60000;
const ev = (o) => ({ at: new Date(T0 + (o.min || 0) * M), testerId: o.t === undefined ? 't2' : o.t, userId: o.u || 'u_p1', role: o.r || 'parent', sid: o.sid || 'sA', source: o.source || 'server',
  kind: o.kind || 'command', name: o.name || 'create_salida', screen: o.screen || null, target: null, durationMs: o.ms == null ? 100 : o.ms, ok: o.ok == null ? true : o.ok,
  error: o.error || null, status: o.status || 200, revision: null, ip: '1', ua: 'ua', data: o.data || null });

async function seed(t) {
  await t.run('create_testers', 'u_s1');
  await insertRows(t.db, 'activity_events', [
    ev({ min: 0, kind: 'login', name: 'auth/login', ms: 50 }),
    ev({ min: 1, ms: 200 }), ev({ min: 2, ms: 400 }), ev({ min: 3, ms: 800, ok: false, error: 'forbidden_person', status: 403 }),
    ev({ min: 4, source: 'client', kind: 'screen_leave', screen: 'parent:inicio', name: 'parent:inicio', ms: 30000, status: null }),
    ev({ min: 5, source: 'client', kind: 'form_abandon', name: 'newSalida', ms: null, status: null }),
    ev({ min: 6, source: 'client', kind: 'click', name: 'openModal', ms: null, status: null }),
    /* 15 minutes of silence: same sid, second session segment */
    ev({ min: 21, kind: 'view', name: 'view', ms: 90 }), ev({ min: 23, source: 'client', kind: 'js_error', name: 'js', error: 'TypeError: boom', ms: null, status: null }),
    ev({ min: 24, source: 'client', kind: 'screen_leave', screen: 'parent:inicio', name: 'parent:inicio', ms: 10000, status: null }),
    /* another tester on the shared PIN, another session */
    ev({ min: 2, t: null, u: 'u_s2', r: 'recepcion', sid: 'sB', name: 'approve_request', ms: 600 }),
    ev({ min: 3, t: null, u: 'u_s2', r: 'recepcion', sid: 'sB', name: 'approve_request', ms: 1400 }),
  ]);
}

test('summary derives sessions with a 10 minute gap and aggregates hot spots', async () => {
  const t = await makeTestApp();
  await seed(t);
  const s = await summary(t.db, {}, new Date(T0 + 25 * M));
  assert.equal(s.totals.events, 12);
  assert.equal(s.totals.sessions, 3, 'sA splits in two, sB is one');
  assert.equal(s.totals.activeMs, 6 * M + 3 * M + 1 * M);
  const t2 = s.testers.find((x) => x.id === 't2');
  assert.equal(t2.sessions, 2); assert.equal(t2.activeMs, 9 * M); assert.equal(t2.actions, 2); assert.equal(t2.errors, 2); assert.equal(t2.online, true);
  assert.equal(t2.lastAt, new Date(T0 + 24 * M).toISOString());
  const shared = s.testers.find((x) => x.id === 'shared');
  assert.equal(shared.name, 'Compartido'); assert.equal(shared.sessions, 1); assert.equal(shared.online, false);
  assert.ok(s.testers.find((x) => x.id === 't7').sessions === 0, 'idle testers still listed');
  assert.deepEqual(s.screens, [{ screen: 'parent:inicio', visits: 2, totalMs: 40000 }]);
  const cs = s.actions.find((a) => a.name === 'create_salida');
  assert.equal(cs.count, 3); assert.equal(cs.p50, 400); assert.equal(cs.p95, 760); assert.equal(cs.max, 800); assert.equal(cs.errors, 1);
  assert.equal(s.actions.find((a) => a.name === 'approve_request').p50, 1000);
  assert.deepEqual(s.clicks, [{ name: 'openModal', count: 1 }]);
  assert.deepEqual(s.abandons, [{ name: 'newSalida', count: 1 }]);
  assert.equal(s.errors.length, 2);
  assert.deepEqual(s.errors.map((e) => e.error).sort(), ['TypeError: boom', 'forbidden_person']);
  assert.deepEqual(s.errors[0].testers, ['Probador 2']);
  assert.equal(s.sessions[0].sid, 'sA'); assert.deepEqual(s.sessions[0].users, ['u_p1']);

  /* filters */
  const only = await summary(t.db, { testerId: 'shared' }, new Date(T0 + 25 * M));
  assert.equal(only.totals.events, 2); assert.equal(only.testers.find((x) => x.id === 'shared').sessions, 1);
  const win = await summary(t.db, { from: new Date(T0 + 20 * M).toISOString() }, new Date(T0 + 25 * M));
  assert.equal(win.totals.events, 3);
  const errs = await summary(t.db, { errorsOnly: '1' }, new Date(T0 + 25 * M));
  assert.equal(errs.totals.events, 2);

  const page = await events(t.db, { limit: 5 });
  assert.equal(page.events.length, 5); assert.ok(page.nextBefore); assert.ok(page.events[0].id > page.events[4].id);
  const page2 = await events(t.db, { limit: 5, before: page.nextBefore });
  assert.ok(page2.events.every((e) => e.id < page.nextBefore));
  const found = await events(t.db, { q: 'boom' });
  assert.equal(found.events.length, 1); assert.equal(found.events[0].kind, 'js_error');
  assert.equal((await events(t.db, { kind: 'command', userId: 'u_s2' })).events.length, 2);

  const csv = await exportCsv(t.db, { sid: 'sB' });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3); assert.ok(lines[0].startsWith('id,at,testerId,userId')); assert.ok(lines[1].includes(',u_s2,recepcion,sB,server,command,approve_request,'));
  await t.close();
});

test('activity routes answer only to the /super cookie', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const { result: made } = await t.run('create_testers', 'u_s1');
  const admin = await loginAs(base, 'u_s1');
  assert.equal((await call(base, '/api/activity/summary', { cookie: admin })).status, 401, 'an app session is not a super session');
  const superTester = await loginAs(base, 'u_s1', made[0].pin);
  assert.equal((await call(base, '/api/activity/summary', { cookie: superTester })).status, 401);
  const sup = await loginSuper(base, made[0].pin);
  const s = await call(base, '/api/activity/summary?testerId=t1', { cookie: sup });
  assert.equal(s.status, 200); assert.ok(s.json.testers.find((x) => x.id === 't1').sessions >= 1, 'the super login itself is recorded');
  assert.equal((await call(base, '/api/activity/events?limit=2', { cookie: sup })).json.events.length, 2);
  assert.equal((await call(base, '/api/activity/testers', { cookie: sup })).json.length, 10);
  assert.ok(!(await call(base, '/api/activity/testers', { cookie: sup })).text.includes('scrypt'), 'no hashes leave the server');
  assert.equal((await call(base, '/api/activity/me', { cookie: sup })).json.users.length, 13);
  const csv = await call(base, '/api/activity/export.csv', { cookie: sup });
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/); assert.ok(csv.text.includes('auth/login'));
  assert.equal((await call(base, '/api/activity/nope', { cookie: sup })).status, 404);
  assert.equal((await t.db.query("SELECT count(*)::int AS c FROM activity_events WHERE name LIKE 'GET activity%'"))[0].c, 0, 'panel reads are not recorded');
  await close(); await t.close();
});
