import test from 'node:test';
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeTestApp } from '../test-helpers.js';
import { listNotifications, getConversation, listAudit, getRequest, listRequests, patchRow } from '../db/repo.js';

const texts = async (db, target) => (await listNotifications(db, target)).map((n) => n.text);

test('a titular request with enough anticipation is auto-approved and everyone is told', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'Cita médica' });
  assert.equal(r.status, 'aprobada');
  assert.equal(r.autoApproved, true);
  assert.equal(r.pickupPoint, 'Puerta Principal');
  assert.match(r.code, /^\d{4}$/);
  assert.equal(r.pickupKind, 'titular');
  assert.equal(r.history[0].text, 'Solicitud creada por Carlos Rodríguez vía App');
  assert.match(r.history[1].text, /^Aprobada automáticamente/);
  const ana = await texts(t.db, { personId: 'p2' });
  assert.match(ana[0], /^ℹ️ Carlos Rodríguez solicitó salida de Joseph Rodríguez hoy a las 1:00 pm/);
  assert.match(ana[1], /^✅ Salida aprobada: Joseph Rodríguez hoy a las 1:00 pm\. Retira: Carlos Rodríguez \(solicitante\)\. Punto de retiro: Puerta Principal\. Código: \d{4}\.$/);
  assert.match((await texts(t.db, { role: 'garita' }))[0], /^Salida aprobada: Joseph Rodríguez 1:00 pm · retira Carlos Rodríguez · Puerta Principal$/);
  assert.equal((await texts(t.db, { staffId: 's3' })).length, 1);
  assert.equal((await listAudit(t.db, 1))[0].summary, 'Auto-aprobó salida de Joseph Rodríguez · Puerta Principal');
  await t.close();
});

test('short notice goes to reception, who approves with a pickup point', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '11:00', pickupBy: 'p1', reason: 'x' });
  assert.equal(r.status, 'pendiente');
  assert.equal(r.history[1].text, 'Pendiente de revisión: menos de 60 min de anticipación');
  assert.match((await texts(t.db, { role: 'recepcion' }))[0], /menos de 60 min de anticipación$/);
  const { result: a } = await t.run('approve_request', 'u_s2', { requestId: r.id, pickupPoint: 'Recepción' });
  assert.equal(a.status, 'aprobada');
  assert.equal(a.decidedBy, 's2');
  assert.equal(a.pickupPoint, 'Recepción');
  assert.equal(a.history[2].text, 'Aprobada por Yadira Batista · Recepción');
  await assert.rejects(t.run('approve_request', 'u_s2', { requestId: r.id, pickupPoint: 'Recepción' }), /request_not_pending/);
  await t.close();
});

test('roles and family scope are enforced', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('create_salida', 'u_p5', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p5', reason: 'x' }), /forbidden_not_titular/);
  await assert.rejects(t.run('create_salida', 'u_s2', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' }), /forbidden_role/);
  // Tomorrow, not today: the seed already carries a pendiente salida for Emily today (r_h3), and a
  // second active salida for the same student and date is now rejected as a duplicate (L15).
  const { result: r } = await t.run('create_salida', 'u_p7', { studentId: 'e4', date: '2026-09-19', time: '11:00', pickupBy: 'p7', reason: 'x' });
  await assert.rejects(t.run('cancel_request', 'u_p1', { requestId: r.id }), /forbidden_not_titular/);
  await assert.rejects(t.run('approve_request', 'u_s3', { requestId: r.id }), /forbidden_capability:aprobar/);
  await assert.rejects(t.run('approve_request', 'u_s6', { requestId: r.id }), /forbidden_capability:aprobar/);
  const { result: c } = await t.run('cancel_request', 'u_p7', { requestId: r.id });
  assert.equal(c.status, 'cancelada');
  assert.match((await texts(t.db, { role: 'recepcion' })).at(-1), /^Solicitud cancelada por el padre: Emily Chen 11:00 am$/);
  assert.match((await texts(t.db, { role: 'garita' })).at(-1), /^Salida cancelada: Emily Chen 11:00 am$/);
  await assert.rejects(t.run('cancel_request', 'u_p7', { requestId: r.id }), /request_not_cancellable/);
  await t.close();
});

test('rejection needs a reason and notifies both titulares', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('reject_request', 'u_s2', { requestId: 'r_h3', reason: '  ' }), /reason_required/);
  const { result: r } = await t.run('reject_request', 'u_s2', { requestId: 'r_h3', reason: 'Examen en curso' });
  assert.equal(r.status, 'rechazada');
  assert.equal(r.rejectReason, 'Examen en curso');
  assert.match((await texts(t.db, { personId: 'p7' }))[0], /^❌ Salida de Emily Chen hoy 12:15 pm no fue aprobada\. Motivo: Examen en curso\. Contacta a recepción al \+507 6800-0000\.$/);
  await t.close();
});

test('excuses are created pending and accepted by reception', async () => {
  const t = await makeTestApp();
  const { result: e } = await t.run('create_excusa', 'u_p7', { studentId: 'e4', date: '2026-09-19', excusaType: 'ausencia', reason: 'Cita médica', attachmentName: 'certificado.jpg' });
  assert.equal(e.status, 'pendiente');
  assert.equal(e.kind, 'excusa');
  assert.equal(e.attachmentName, 'certificado.jpg');
  assert.match((await texts(t.db, { personId: 'p7' }))[0], /^📝 Excusa recibida para Emily Chen \(ausencia · mañana\)/);
  assert.match((await texts(t.db, { role: 'recepcion' }))[0], /^Nueva excusa: Emily Chen \(9°\) · ausencia mañana$/);
  assert.equal((await texts(t.db, { staffId: 's4' })).length, 1, 'Jorge teaches 9°');
  await assert.rejects(t.run('accept_excusa', 'u_s3', { requestId: e.id }), /forbidden_capability:decidir_excusas/);
  const { result: a } = await t.run('accept_excusa', 'u_s2', { requestId: e.id });
  assert.equal(a.status, 'aceptada');
  assert.match((await texts(t.db, { personId: 'p7' })).at(-1), /^✅ Excusa aceptada: Emily Chen · ausencia mañana/);
  await t.close();
});

test('unusual pickups trigger the proactive alert with buttons and a chat step', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p4', reason: 'x' });
  assert.equal(r.status, 'aprobada', 'temporal authorizations still auto-approve');
  assert.equal(r.pickupKind, 'temporal');
  const alerts = (await listNotifications(t.db, { personId: 'p2' })).filter((n) => n.text.startsWith('⚠️ AVISO'));
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].buttons, ['Es correcto', 'NO']);
  assert.match(alerts[0].text, /autorización por tiempo \(2026-09-16 → 2026-09-30\)/);
  assert.deepEqual(await getConversation(t.db, 'p1'), { step: 'alert_pickup', requestId: r.id, draft: null, alerts: [] });
  assert.deepEqual(await getConversation(t.db, 'p2'), { step: 'alert_pickup', requestId: r.id, draft: null, alerts: [] });
  await t.close();
});

test('one-time authorizations need manual approval and announce the gate confirmation', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p5', reason: 'x' });
  assert.equal(r.status, 'pendiente');
  assert.equal(r.history[1].text, 'Pendiente de revisión: autorización de una sola vez requiere revisión');
  const { result: a } = await t.run('approve_request', 'u_s2', { requestId: r.id, pickupPoint: 'Puerta Principal' });
  assert.ok(a.history.some((h) => h.text === 'Requiere confirmación del titular cuando la persona llegue a la garita'));
  assert.match((await texts(t.db, { personId: 'p1' })).find((x) => x.startsWith('✅')), /Te pediremos confirmar cuando la persona llegue a la garita/);
  assert.match((await texts(t.db, { personId: 'p5' })).at(-1), /^👋 Estás autorizado\(a\) para retirar a Joseph Rodríguez hoy a las 1:00 pm por Puerta Principal/);
  assert.equal((await getRequest(t.db, r.id)).status, 'aprobada');
  await t.close();
});

test('input validation', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'e1', date: '18/09/2026', time: '13:00', pickupBy: 'p1', reason: 'x' }), /invalid_date/);
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '1pm', pickupBy: 'p1', reason: 'x' }), /invalid_time/);
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'nope', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' }), /student_not_found/);
  await t.close();
});

test('date and time must be real calendar values, not just the right shape', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-13-45', time: '13:00', pickupBy: 'p1', reason: 'x' }), /invalid_date/);
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-31', time: '13:00', pickupBy: 'p1', reason: 'x' }), /invalid_date/, 'September has 30 days: no rolling into October');
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '29:99', pickupBy: 'p1', reason: 'x' }), /invalid_time/);
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:60', pickupBy: 'p1', reason: 'x' }), /invalid_time/);
  await t.close();
});

test('a salida cannot be created in the past; an excusa can', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-01', time: '13:00', pickupBy: 'p1', reason: 'x' }), /date_in_past/);
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '09:00', pickupBy: 'p1', reason: 'x' }), /time_in_past/, 'today at 09:00, but now is 10:30');
  const { result: e } = await t.run('create_excusa', 'u_p1', { studentId: 'e1', date: '2026-09-01', excusaType: 'ausencia', reason: 'x' });
  assert.equal(e.status, 'pendiente', 'excusas have no past restriction');
  await t.close();
});

test('pickupBy must be a real pickup candidate, and rejection tells no one', async () => {
  const t = await makeTestApp();
  const before = (await listNotifications(t.db, { personId: 'p7' })).length;
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p7', reason: 'x' }), /pickup_not_candidate/, 'p7 is Wei Chen, another family entirely');
  assert.equal((await listNotifications(t.db, { personId: 'p7' })).length, before, 'Wei never hears about it');
  assert.equal((await listRequests(t.db, { studentIds: ['e1'] })).length, 0, 'nothing was created');
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'nobody', reason: 'x' }), /pickup_not_candidate/);
  await t.close();
});

test('approveRequest revalidates who retrieves: revoked eligibility and a missing person both fail cleanly', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p5', reason: 'x' });
  assert.equal(r.status, 'pendiente', 'one-time authorizations need manual review');
  await t.run('revoke_authorization', 'u_p1', { authorizationId: 'a4' });
  await assert.rejects(t.run('approve_request', 'u_s2', { requestId: r.id }), (e) => e.status === 409 && e.code === 'pickup_no_longer_eligible');
  /* r is still pendiente (the approval never went through): cancel it first, since a second active
     salida for the same student and date is now rejected as a duplicate (L15). */
  await t.run('cancel_request', 'u_p1', { requestId: r.id });

  const { result: r2 } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'y' });
  assert.equal(r2.status, 'aprobada', 'a titular with enough notice auto-approves');
  // e2 (Sofía) is Carlos's other child: a different student avoids clashing with r2, still active for e1.
  const { result: r3 } = await t.run('create_salida', 'u_p1', { studentId: 'e2', date: '2026-09-18', time: '11:00', pickupBy: 'p1', reason: 'z' });
  assert.equal(r3.status, 'pendiente', 'short notice needs Recepción');
  /* Simulate a stale row (legacy data, or a person deleted since): approveRequest must never throw a
     TypeError reading properties off a null person. */
  await t.db.tx((q) => patchRow(q, 'requests', r3.id, { pickupBy: 'nobody' }));
  await assert.rejects(t.run('approve_request', 'u_s2', { requestId: r3.id }), (e) => e.status === 409 && e.code === 'pickup_person_missing');
  await t.close();
});

test('eligibility follows the date of the salida, not today: a temporal window outside the requested date is rejected at creation', async () => {
  const t = await makeTestApp();
  // a3: p4 has a temporal authorization for e1, 2026-09-16..2026-09-30.
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-10-15', time: '13:00', pickupBy: 'p4', reason: 'x' }), /pickup_not_candidate/, 'October 15 is long past the temporal window');
  await t.close();
});

test('a temporal authorization that starts tomorrow makes tomorrow\'s salida auto-approvable today, but not today\'s', async () => {
  const t = await makeTestApp();
  await t.run('add_authorization', 'u_p2', { studentIds: ['e1'], mode: 'cuenta', cedula: 'E-8-12345', type: 'temporal', from: '2026-09-19', to: '2026-10-03' });
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p7', reason: 'x' }), /pickup_not_candidate/, 'the window has not started yet');
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-19', time: '09:00', pickupBy: 'p7', reason: 'x' });
  assert.equal(r.status, 'aprobada', 'tomorrow the window is open, so it auto-approves today');
  assert.equal(r.pickupKind, 'temporal');
  await t.close();
});

test('approveRequest rejects a salida whose date is already in the past', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '11:00', pickupBy: 'p1', reason: 'short notice' });
  assert.equal(r.status, 'pendiente', 'short notice needs Recepción');
  t.clock.now = new Date('2026-09-19T15:00:00Z'); // next day: nobody ever decided on it
  await assert.rejects(t.run('approve_request', 'u_s2', { requestId: r.id }), (e) => e.status === 409 && e.code === 'date_in_past');
  await t.close();
});

test('a second active salida for the same student and date is rejected as a duplicate (L15)', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' });
  assert.equal(r.status, 'aprobada');
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '14:00', pickupBy: 'p2', reason: 'y' }), (e) => e.status === 409 && e.code === 'duplicate_salida');
  // A still-pendiente one blocks a new one too, not just an aprobada one.
  const { result: r2 } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-19', time: '11:00', pickupBy: 'p5', reason: 'z' });
  assert.equal(r2.status, 'pendiente', 'una_vez needs manual review');
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-19', time: '12:00', pickupBy: 'p1', reason: 'w' }), (e) => e.code === 'duplicate_salida');
  // Cancelling frees the date up again.
  await t.run('cancel_request', 'u_p1', { requestId: r.id });
  const { result: r3 } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '14:00', pickupBy: 'p2', reason: 'y' });
  assert.equal(r3.status, 'aprobada');
  // A different student, or a different date, is never a duplicate.
  await t.run('create_salida', 'u_p1', { studentId: 'e2', date: '2026-09-18', time: '14:30', pickupBy: 'p1', reason: 'z2' });
  await t.close();
});

test('staff_cancel_request notifies titulares and the account-holding authorized person, and garita only when it was approved (L15)', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p5', reason: 'x' });
  assert.equal(r.status, 'pendiente', 'una_vez needs manual review');
  await assert.rejects(t.run('staff_cancel_request', 'u_s3', { requestId: r.id, reason: 'x' }), /forbidden_capability:aprobar/);
  await assert.rejects(t.run('staff_cancel_request', 'u_s2', { requestId: r.id, reason: '  ' }), /reason_required/);
  const { result: c1 } = await t.run('staff_cancel_request', 'u_s2', { requestId: r.id, reason: 'Cambio de instrucciones de la familia' });
  assert.equal(c1.status, 'cancelada');
  assert.match((await texts(t.db, { personId: 'p1' })).at(-1), /^⛔ Salida de Joseph Rodríguez hoy 1:00 pm fue cancelada por el personal\. Motivo: Cambio de instrucciones de la familia\.$/);
  assert.match((await texts(t.db, { personId: 'p2' })).at(-1), /^⛔ Salida de Joseph Rodríguez hoy 1:00 pm fue cancelada por el personal/);
  // Never approved: Laura (p5) never got a code, and garita was never told about it.
  assert.equal((await texts(t.db, { personId: 'p5' })).length, 0);
  assert.equal((await texts(t.db, { role: 'garita' })).length, 0);

  const { result: r2 } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-19', time: '13:00', pickupBy: 'p5', reason: 'y' });
  await t.run('approve_request', 'u_s2', { requestId: r2.id });
  const garitaBefore = (await texts(t.db, { role: 'garita' })).length;
  const { result: c2 } = await t.run('staff_cancel_request', 'u_s2', { requestId: r2.id, reason: 'Se resolvió el trámite' });
  assert.equal(c2.status, 'cancelada');
  assert.match((await texts(t.db, { personId: 'p5' })).at(-1), /^⛔ La salida de Joseph Rodríguez que ibas a retirar fue cancelada por el personal\. Motivo: Se resolvió el trámite\.$/);
  assert.ok((await texts(t.db, { role: 'garita' })).length > garitaBefore, 'garita is told, since it had been approved');
  await assert.rejects(t.run('staff_cancel_request', 'u_s2', { requestId: r2.id, reason: 'otra vez' }), /request_not_cancellable/);
  await t.close();
});

test('pickup codes use crypto.randomInt and the DB enforces one code per date for salidas', async () => {
  const t = await makeTestApp();
  const spy = mock.method(crypto, 'randomInt');
  const { result: r1 } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' });
  assert.ok(spy.mock.calls.length > 0, 'crypto.randomInt was used to generate the code');
  assert.match(r1.code, /^\d{4}$/);
  spy.mock.restore();
  const { result: r2 } = await t.run('create_salida', 'u_p1', { studentId: 'e2', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'y' });
  assert.notEqual(r1.code, r2.code, 'two salidas the same day never share a code');
  // Migration 004: the unique index rejects a duplicate (date, code) for salidas at the DB level.
  await assert.rejects(
    t.db.query("INSERT INTO requests(id, kind, student_id, requested_by, date, time, channel, status, code, created_at) VALUES ('rz_dup','salida','e1','p1','2026-09-18','16:00','web','pendiente',$1,$2)", [r1.code, new Date().toISOString()]),
    (e) => e.code === '23505',
  );
  await t.close();
});
