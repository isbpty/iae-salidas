import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, call, loginAs } from '../test-helpers.js';

test('parent sees only the family, plus the directory of account holders', async () => {
  const t = await makeTestApp();
  await t.run('create_salida', 'u_p5', { studentId: 'e3', date: '2026-09-18', time: '13:00', pickupBy: 'p5', reason: 'x' });
  const v = await t.view('u_p1');
  assert.equal(v.user.role, 'parent');
  assert.equal(v.me.id, 'p1');
  assert.deepEqual(v.students.map((s) => s.id), ['e1', 'e2']);
  assert.deepEqual(v.students[0].titulares, ['p1', 'p2']);
  assert.deepEqual(Object.keys(v.persons).sort(), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.equal(v.persons.p3.docAttachmentId, 'att_p3');
  assert.ok(!('bytes' in v.persons.p3));
  assert.deepEqual(v.accounts.map((a) => a.id), ['p2', 'p5', 'p6', 'p7']);
  assert.ok(!('phone' in v.accounts[0]), 'directory has no phones');
  assert.deepEqual(v.authorizations.map((a) => a.id), ['a1', 'a2', 'a3', 'a4']);
  assert.equal(v.requests.length, 0, 'the e3 request belongs to another family');
  assert.deepEqual(v.routes.map((r) => r.id), ['r1']);
  assert.equal(v.trips[0].boarded.e1.status, 'abordo');
  assert.equal(v.staffNames.s6, 'Manuel Ortega');
  assert.equal(typeof v.serverNow, 'number');
  assert.equal(v.today, '2026-09-18');
  const laura = await t.view('u_p5');
  assert.deepEqual(laura.authorizedFor.map((x) => x.student.id), ['e1']);
  // Deviation from brief: r_h1 (seeded, studentId e3, requestedBy p5) is already in scope
  // alongside the new salida for e3, per the scope rule "requests whose studentId is in
  // scope" -- so Laura's scoped requests total 2, not 1.
  assert.equal(laura.requests.length, 2);
  assert.equal(laura.chat.length, 1, 'own chat only: the auto-approval message');
  assert.equal(laura.gpsNow.r2.leg, 'vuelta');
  await t.close();
});

test('teacher sees her grade, gate sees today approved salidas, monitor sees her route', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p3', reason: 'x' });
  await t.run('create_excusa', 'u_p5', { studentId: 'e3', date: '2026-09-19', excusaType: 'ausencia', reason: 'x' });
  const diana = await t.view('u_s3');
  assert.deepEqual(diana.students.map((s) => s.id), ['e1', 'e3']);
  assert.deepEqual(diana.requests.map((x) => x.kind).sort(), ['excusa', 'salida', 'salida'], 'r_h1 (e3), the excuse and the new salida');
  assert.ok(!diana.requests.some((x) => x.id === 'r_h3'), 'Emily is 9°');
  assert.equal(diana.audit, null);
  assert.equal(diana.users, null);
  assert.ok(diana.notifications.some((n) => n.text.startsWith('Salida aprobada: Joseph')));

  const gate = await t.view('u_s6');
  assert.deepEqual(gate.requests.map((x) => x.id), [r.id]);
  assert.equal(gate.persons.p3.cedula, '8-200-111');
  assert.ok(gate.notifications.some((n) => n.text.startsWith('Salida aprobada')));
  assert.equal(gate.authorizations.length, 0);

  const kenia = await t.view('u_s7');
  assert.deepEqual(kenia.routes.map((x) => x.id), ['r1']);
  assert.deepEqual(kenia.students.map((s) => s.id), ['e1', 'e2']);
  assert.equal(kenia.trips.length, 1);
  assert.equal(kenia.requests.length, 0);

  const rec = await t.view('u_s2');
  assert.equal(rec.students.length, 4);
  assert.equal(rec.requests.length, 5);
  assert.ok(rec.audit.length > 0);
  assert.equal(rec.users, null);

  const admin = await t.view('u_s1');
  assert.ok(admin.users.length >= 13);
  assert.equal(admin.permissions.garita.marcar_salida, true);
  assert.ok(Array.isArray(admin.chats.p1));
  assert.equal(admin.capabilities.config, true);
  await t.close();
});

test('the HTTP view carries the same shape and updates after a command', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const cookie = await loginAs(base, 'u_p1');
  const v1 = await call(base, '/api/me/view', { cookie });
  assert.equal(v1.json.view.requests.length, 0);
  const cmd = await call(base, '/api/commands/create_salida', { method: 'POST', cookie, body: { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' } });
  assert.equal(cmd.status, 200);
  assert.equal(cmd.json.view.requests.length, 1);
  assert.equal(cmd.json.revision, v1.json.revision + 1);
  const forbidden = await call(base, '/api/commands/approve_request', { method: 'POST', cookie, body: { requestId: cmd.json.result.id } });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.error, 'forbidden_role');
  await close(); await t.close();
});
