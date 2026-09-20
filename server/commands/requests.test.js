import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { listNotifications, getConversation, listAudit, getRequest } from '../db/repo.js';

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
  const { result: r } = await t.run('create_salida', 'u_p7', { studentId: 'e4', date: '2026-09-18', time: '11:00', pickupBy: 'p7', reason: 'x' });
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
  assert.deepEqual(await getConversation(t.db, 'p1'), { step: 'alert_pickup', requestId: r.id, draft: null });
  assert.deepEqual(await getConversation(t.db, 'p2'), { step: 'alert_pickup', requestId: r.id, draft: null });
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
