import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { listNotifications, getConversation, getAuthorization } from '../db/repo.js';

const texts = async (db, target) => (await listNotifications(db, target)).map((n) => n.text);

test('one-time pickup: gate asks, a titular confirms, gate marks the exit and the authorization is consumed', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p5', reason: 'x' });
  await t.run('approve_request', 'u_s2', { requestId: r.id, pickupPoint: 'Puerta Principal' });
  await assert.rejects(t.run('mark_exit', 'u_s6', { requestId: r.id }), (e) => e.code === 'confirmation_required' && /primero solicita la confirmación/.test(e.detail));
  const { result: c } = await t.run('request_confirmation', 'u_s6', { requestId: r.id });
  assert.equal(c.confirmation.status, 'pendiente');
  assert.equal((await getConversation(t.db, 'p2')).step, 'confirm_pickup');
  const asks = (await listNotifications(t.db, { personId: 'p2' })).filter((n) => n.text.startsWith('⚠️ Laura Gómez (Mamá) está en la garita'));
  assert.deepEqual(asks[0].buttons, ['Sí, confirmo', 'No']);
  await assert.rejects(t.run('confirm_pickup', 'u_p7', { requestId: r.id, confirmed: true }), /forbidden_not_titular/);
  const { result: ok } = await t.run('confirm_pickup', 'u_p2', { requestId: r.id, confirmed: true });
  assert.equal(ok.confirmation.status, 'confirmada');
  assert.equal(ok.confirmation.byPerson, 'p2');
  assert.equal(await getConversation(t.db, 'p2'), null);
  assert.equal(await getConversation(t.db, 'p1'), null, 'the other titular is released too');
  assert.match((await texts(t.db, { role: 'garita' })).at(-1), /^✅ Confirmado por Ana Pérez: entrega de Joseph Rodríguez a Laura Gómez$/);
  assert.match((await texts(t.db, { personId: 'p1' })).at(-1), /^✅ Ana Pérez confirmó la entrega de Joseph Rodríguez a Laura Gómez\.$/);
  await assert.rejects(t.run('mark_exit', 'u_s2', { requestId: r.id }), /forbidden_capability:marcar_salida/);
  const { result: done } = await t.run('mark_exit', 'u_s6', { requestId: r.id });
  assert.equal(done.status, 'retirado');
  assert.equal(done.exitBy, 's6');
  assert.ok((await getAuthorization(t.db, 'a4')).usedAt, 'one-time authorization consumed');
  assert.match((await texts(t.db, { personId: 'p1' })).at(-1), /^🚪 Joseph Rodríguez salió por Puerta Principal a las 10:30 am, retirado\(a\) por Laura Gómez \(Mamá\)\. Confirmó Manuel Ortega \(Oficial de garita\)\.$/);
  assert.match((await texts(t.db, { personId: 'p5' })).at(-1), /^🚪 Registramos que retiraste a Joseph Rodríguez a las 10:30 am\. ¡Gracias!$/);
  assert.match((await texts(t.db, { staffId: 's3' })).at(-1), /^Joseph Rodríguez salió a las 10:30 am$/);
  await assert.rejects(t.run('mark_exit', 'u_s6', { requestId: r.id }), /request_not_approved/);
  await t.close();
});

test('a denied confirmation blocks the exit; confirmation is not offered for ordinary pickups', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p5', reason: 'x' });
  await t.run('approve_request', 'u_s2', { requestId: r.id });
  await t.run('request_confirmation', 'u_s6', { requestId: r.id });
  await t.run('confirm_pickup', 'u_p1', { requestId: r.id, confirmed: false });
  await assert.rejects(t.run('mark_exit', 'u_s6', { requestId: r.id }), /confirmation_required/);
  assert.match((await texts(t.db, { role: 'garita' })).at(-1), /^⛔ NEGADO por Carlos Rodríguez/);
  const { result: plain } = await t.run('create_salida', 'u_p1', { studentId: 'e2', date: '2026-09-18', time: '13:00', pickupBy: 'p3', reason: 'x' });
  await assert.rejects(t.run('request_confirmation', 'u_s6', { requestId: plain.id }), /confirmation_not_needed/);
  await t.close();
});

test('scan_code finds today approved salidas only and logs the scan', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' });
  const { result: found } = await t.run('scan_code', 'u_s6', { code: ' ' + r.code + ' ' });
  assert.equal(found.requestId, r.id);
  await assert.rejects(t.run('scan_code', 'u_s6', { code: '0000' }), (e) => e.code === 'code_not_found' && e.detail === 'Código no válido o sin salida aprobada para hoy.');
  await assert.rejects(t.run('scan_code', 'u_s6', { code: '4821' }), /code_not_found/, 'yesterday retired request');
  await t.close();
});
