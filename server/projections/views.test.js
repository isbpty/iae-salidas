import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, call, loginAs } from '../test-helpers.js';

test('parent sees only the family, never a directory of account holders', async () => {
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
  assert.equal(v.accounts, undefined, 'no directory of the other families: add_authorization looks people up by exact cédula or phone');
  assert.deepEqual(v.authorizations.map((a) => a.id), ['a1', 'a2', 'a3', 'a4']);
  const a4 = v.authorizations.find((a) => a.id === 'a4');
  assert.equal(a4.expiresOn, '2026-09-24', 'a4 (una_vez, no explicit valid_to) carries its server-computed default expiry (school tz), not left for the client to compute');
  assert.equal(v.authorizations.find((a) => a.id === 'a1').expiresOn, undefined, 'siempre never carries expiresOn');
  assert.equal(v.authorizations.find((a) => a.id === 'a3').expiresOn, undefined, 'temporal already has its own validTo');
  assert.equal(v.requests.length, 0, 'the e3 request belongs to another family');
  assert.deepEqual(v.routes.map((r) => r.id), ['r1']);
  assert.equal(v.trips[0].boarded.e1.status, 'abordo');
  assert.equal(v.staffNames.s6, 'Manuel Ortega');
  assert.equal(typeof v.serverNow, 'number');
  assert.equal(v.today, '2026-09-18');
  assert.equal(v.realtime, 'sse', 'a long-lived listener can hold an EventSource open');
  const laura = await t.view('u_p5');
  assert.deepEqual(laura.authorizedFor.map((x) => x.student.id), ['e1']);
  assert.equal(laura.authorizedFor[0].createdByName, 'Carlos Rodríguez');
  assert.ok(!('p1' in laura.persons), 'the titular who created the one-time authorization is not leaked to a merely-authorized parent');
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
  assert.deepEqual(gate.students.map((s) => s.id), ['e1'], 'only the student behind today\'s aprobada/retirado salidas, not the whole roster');
  // Deviation from review-findings suggestion: e1's titulares are p1 AND p2 (both parents),
  // so the scope rule (titulares of referenced students + requestedBy + pickupBy) yields
  // {p1, p2, p3} -- not {p1, p3}. Verified against actual output.
  assert.deepEqual(Object.keys(gate.persons).sort(), ['p1', 'p2', 'p3'], 'requester p1, co-titular p2, pickup p3 -- not the full family/staff directory');
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
  assert.equal(rec.authorizations.find((a) => a.id === 'a4').expiresOn, '2026-09-24', 'the staff view resolves una_vez expiry too');

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

test('a parent learns nothing new about an account holder they authorize', async () => {
  const t = await makeTestApp();
  await t.run('add_authorization', 'u_p7', { studentIds: ['e4'], mode: 'cuenta', personId: 'p1', type: 'siempre' });
  const v = await t.view('u_p7');
  assert.deepEqual(Object.keys(v.persons.p1).sort(), ['hasAccount', 'id', 'name', 'relation']);
  for (const field of ['cedula', 'phone', 'docAttachmentId', 'docName']) assert.ok(!(field in v.persons.p1), field + ' stays with Carlos');
  assert.equal(v.me.cedula, 'E-8-12345', 'own details are still there');
  /* And the reverse view: Carlos keeps the full record of the people he is responsible for. */
  const carlos = await t.view('u_p1');
  assert.equal(carlos.persons.p3.cedula, '8-200-111', 'the grandmother he authorized, who has no account');
  assert.equal(carlos.persons.p2.cedula, '8-702-456', 'his co-titular');
  assert.ok(!('cedula' in carlos.persons.p5), 'Laura has her own account and her own family');
  await t.close();
});
