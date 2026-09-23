import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { listNotifications, findTrip, getSettings, saveSettings } from '../db/repo.js';
import { todayISO, shiftISO } from '../domain/time.js';

const texts = async (db, target) => (await listNotifications(db, target)).map((n) => n.text);

test('where_is answers by real state: on the bus with ETA and location', async () => {
  const t = await makeTestApp(); // simulateBus=true, vuelta at 22 %, e1 and e2 aboard since 10:09
  const { result } = await t.run('where_is', 'u_p1', { studentId: 'e1' });
  assert.match(result.text, /^🚌 Joseph va en el Bus 12 \(placa T-4521\), vuelta \(tarde\)\. Abordó a las 10:09 am\.\n📍 Próxima parada: Villa Lucre\n🏁 Llega a Villa Lucre en ~9 min\n👩 Monitora: Kenia Pérez$/);
  assert.equal(result.location.routeId, 'r1');
  assert.equal(result.location.leg, 'vuelta');
  assert.equal(result.location.label, 'Bus 12 · vuelta (tarde) · GPS simulado');
  assert.ok(result.location.lat > 9.012 && result.location.lat < 9.03);
  await assert.rejects(t.run('where_is', 'u_p7', { studentId: 'e1' }), /forbidden_not_titular/);
  await t.close();
});

test('where_is: not marked, opted out, got off, did not board, in class, retired, out of hours', async () => {
  const t = await makeTestApp();
  assert.equal((await t.run('where_is', 'u_p5', { studentId: 'e3' })).result.text, '⏳ El Bus 7 está en ruta, pero la monitora aún no ha marcado a Mateo a bordo. Si no lo esperabas, llama a recepción al +507 6800-0000.');
  await t.run('mark_no_bus', 'u_p5', { studentId: 'e3' });
  assert.equal((await t.run('where_is', 'u_p5', { studentId: 'e3' })).result.text, '🚌 Hoy Mateo no va en el Bus 7 (avisado por la familia). Está en el plantel.');
  assert.match((await texts(t.db, { staffId: 's8' })).at(-1), /^🚌 Mateo Castillo hoy no va en el bus \(ida, vuelta\) · avisó Laura Gómez$/);
  assert.match((await texts(t.db, { personId: 'p6' })).at(-1), /^ℹ️ Laura Gómez avisó que Mateo hoy no va en el Bus 7 \(ida, vuelta\)\.$/);
  assert.deepEqual((await findTrip(t.db, '2026-09-18', 'r2', 'ida')).noBus, ['e3']);

  await t.run('mark_boarding', 'u_s7', { routeId: 'r1', leg: 'vuelta', studentId: 'e1', status: 'bajo', stopId: 'st2' });
  assert.equal((await t.run('where_is', 'u_p1', { studentId: 'e1' })).result.text, '✅ Joseph bajó del Bus 12 en Villa Lucre a las 10:30 am. Lo confirmó la monitora Kenia Pérez.');
  await t.run('mark_boarding', 'u_s7', { routeId: 'r1', leg: 'vuelta', studentId: 'e2', status: 'no_abordo' });
  assert.equal((await t.run('where_is', 'u_p1', { studentId: 'e2' })).result.text, '⚠️ La monitora marcó que Sofía NO abordó el Bus 12 (10:30 am). Contacta a recepción al +507 6800-0000.');
  assert.match((await texts(t.db, { role: 'recepcion' })).at(-1), /^Sofía Rodríguez no abordó el Bus 12 \(vuelta \(tarde\)\)$/);

  assert.equal((await t.run('where_is', 'u_p7', { studentId: 'e4' })).result.text, '🏫 Emily está en el plantel · 9° Premedia · Prof. Jorge Ávila.');

  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' });
  await t.run('mark_exit', 'u_s6', { requestId: r.id });
  assert.equal((await t.run('where_is', 'u_p1', { studentId: 'e1' })).result.text, '🚪 Joseph salió por Puerta Principal a las 10:30 am, retirado(a) por Carlos Rodríguez (solicitante). Confirmó Manuel Ortega (Oficial de garita).');

  await saveSettings(t.db, { ...(await getSettings(t.db)), simulateBus: false });
  t.clock.now = new Date('2026-09-19T01:00:00Z'); // 20:00 in Panama
  assert.equal((await t.run('where_is', 'u_p1', { studentId: 'e2' })).result.text, '🕒 Fuera de horario escolar. No hay registro de salida especial de Sofía hoy. Próximo viaje del Bus 12: ida mañana a las 6:00 am.');
  await t.close();
});

test('monitor scope, trip status and validation', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('mark_boarding', 'u_s8', { routeId: 'r1', leg: 'vuelta', studentId: 'e1', status: 'abordo' }), /forbidden_route/);
  await assert.rejects(t.run('mark_boarding', 'u_s2', { routeId: 'r1', leg: 'vuelta', studentId: 'e1', status: 'abordo' }), /forbidden_capability:marcar_bus/);
  await assert.rejects(t.run('mark_boarding', 'u_s7', { routeId: 'r1', leg: 'noche', studentId: 'e1', status: 'abordo' }), /invalid_leg/);
  await assert.rejects(t.run('mark_boarding', 'u_s7', { routeId: 'r1', leg: 'ida', studentId: 'e1', status: 'volando' }), /invalid_status/);
  await assert.rejects(t.run('mark_boarding', 'u_s7', { routeId: 'r1', leg: 'ida', studentId: 'e3', status: 'abordo' }), /student_not_on_route/);
  await assert.rejects(t.run('mark_no_bus', 'u_p7', { studentId: 'e4' }), (e) => e.code === 'no_bus_route');
  await assert.rejects(t.run('set_trip_status', 'u_s7', { routeId: 'r2', leg: 'vuelta', status: 'en_ruta' }), /forbidden_route/);
  const { result } = await t.run('set_trip_status', 'u_s7', { routeId: 'r1', leg: 'vuelta', status: 'finalizado' });
  assert.equal(result.status, 'finalizado');
  assert.ok(result.endedAt);
  const { result: admin } = await t.run('set_trip_status', 'u_s1', { routeId: 'r2', leg: 'vuelta', status: 'en_ruta' });
  assert.equal(admin.status, 'en_ruta');
  await t.close();
});

test('mark_no_bus/undo_no_bus (L12): accept hoy/mañana, reject any other date, and undo_no_bus reverses the opt-out', async () => {
  const t = await makeTestApp();
  const today = todayISO(t.clock.now, 'America/Panama');
  const tomorrow = shiftISO(t.clock.now, 'America/Panama', 1);

  await assert.rejects(t.run('mark_no_bus', 'u_p1', { studentId: 'e1', date: '2026-01-01' }), /invalid_date/);
  const { result: r1 } = await t.run('mark_no_bus', 'u_p1', { studentId: 'e1', legs: ['ida'], date: tomorrow });
  assert.equal(r1.date, tomorrow);
  assert.deepEqual((await findTrip(t.db, tomorrow, 'r1', 'ida')).noBus, ['e1']);
  assert.equal(await findTrip(t.db, today, 'r1', 'ida'), null, "today's ida trip was never touched");

  await assert.rejects(t.run('undo_no_bus', 'u_p1', { studentId: 'e1', legs: ['ida'], date: '2026-01-01' }), /invalid_date/);
  await assert.rejects(t.run('undo_no_bus', 'u_p7', { studentId: 'e1', legs: ['ida'], date: tomorrow }), /forbidden_not_titular/);
  const { result: r2 } = await t.run('undo_no_bus', 'u_p1', { studentId: 'e1', legs: ['ida'], date: tomorrow });
  assert.equal(r2.removed, true);
  assert.deepEqual((await findTrip(t.db, tomorrow, 'r1', 'ida')).noBus, []);
  await t.close();
});
