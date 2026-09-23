import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { makeCtx } from './context.js';
import { markNoBus, undoNoBus, markBoarding, setTripStatus, whereIs } from './bus.js';
import { createRequest, acceptExcusa } from './requests.js';
import { listNotifications, patchRow, findTrip } from '../db/repo.js';
import { todayISO, shiftISO } from './time.js';

/* Same pattern as domain/eligibility.test.js: a ctx built straight off `t.db` (not a closed tx
   connection) stays valid for the rest of the test. */
const ctxFor = (t, userId) => makeCtx(t.db, t.deps, userId);

test('markNoBus (L12): notifies only once per trip, accepts an explicit date, and falls back to Recepción instead of crashing when the route has no monitora', async () => {
  const t = await makeTestApp();
  const ctx = await ctxFor(t, 'u_p1');
  const today = todayISO(ctx.now, ctx.tz);

  const r1 = await markNoBus(ctx, 'e1', 'p1', ['ida', 'vuelta']); // no date: keeps working, defaults to today
  assert.equal(r1.date, today);
  assert.equal(r1.alreadyRegistered, false);
  assert.equal((await listNotifications(t.db, { staffId: 's7' })).length, 1);

  // A repeated opt-out for the same trip must not fire the notifications again (L12).
  const r2 = await markNoBus(ctx, 'e1', 'p1', ['ida', 'vuelta']);
  assert.equal(r2.alreadyRegistered, true);
  assert.equal((await listNotifications(t.db, { staffId: 's7' })).length, 1, 'no duplicate notification');

  // A route with no monitora used to make the notifyStaff insert violate notifications' CHECK
  // constraint (staff_id null, nothing else set) and crash with a 500 -- Recepción hears about it
  // instead, and the opt-out still gets registered for tomorrow.
  await patchRow(t.db, 'routes', 'r2', { monitorStaffId: null });
  const tomorrow = shiftISO(ctx.now, ctx.tz, 1);
  const ctxP5 = await ctxFor(t, 'u_p5');
  const r3 = await markNoBus(ctxP5, 'e3', 'p5', ['vuelta'], tomorrow);
  assert.equal(r3.date, tomorrow);
  assert.equal(r3.alreadyRegistered, false);
  assert.match((await listNotifications(t.db, { role: 'recepcion' })).at(-1).text, /Mateo Castillo.*mañana.*Bus 7.*no tiene monitora/);
  await t.close();
});

test('undoNoBus (L12): reverses a registered opt-out, tells the other titular, and is a no-op when nothing was registered', async () => {
  const t = await makeTestApp();
  const ctx = await ctxFor(t, 'u_p1');
  const today = todayISO(ctx.now, ctx.tz);
  await markNoBus(ctx, 'e1', 'p1', ['ida']);
  const before = (await listNotifications(t.db, { personId: 'p2' })).length;

  const undone = await undoNoBus(ctx, 'e1', 'p1', ['ida']);
  assert.equal(undone.removed, true);
  const trip = await findTrip(t.db, today, 'r1', 'ida');
  assert.deepEqual(trip.noBus, []);
  assert.equal((await listNotifications(t.db, { personId: 'p2' })).length, before + 1, 'the other titular is told the student is back on the bus');
  assert.match((await listNotifications(t.db, { personId: 'p2' })).at(-1).text, /SÍ va en el Bus 12/);

  const noop = await undoNoBus(ctx, 'e1', 'p1', ['ida']);
  assert.equal(noop.removed, false, 'nothing left to undo the second time');
  assert.equal((await listNotifications(t.db, { personId: 'p2' })).length, before + 1, 'no extra notification for the no-op');
  await t.close();
});

test('markBoarding (L13): the stop must belong to the route, and boarding is rejected for an opted-out or already-exited student', async () => {
  const t = await makeTestApp();
  const ctx = await ctxFor(t, 'u_s7');
  const today = todayISO(ctx.now, ctx.tz);

  await assert.rejects(markBoarding(ctx, 'r1', 'ida', 'e1', 'abordo', 's7', 'st5'), (e) => e.code === 'invalid_stop', 'st5 belongs to Bus 7 (r2), not Bus 12 (r1)');

  await markNoBus(await ctxFor(t, 'u_p1'), 'e2', 'p1', ['ida']);
  await assert.rejects(markBoarding(ctx, 'r1', 'ida', 'e2', 'abordo', 's7', 'st2'), (e) => e.code === 'student_opted_out');

  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: today, time: '13:00', pickupBy: 'p1', reason: 'x' });
  assert.equal(r.status, 'aprobada');
  await t.run('mark_exit', 'u_s6', { requestId: r.id });
  await assert.rejects(markBoarding(ctx, 'r1', 'ida', 'e1', 'abordo', 's7', 'st2'), (e) => e.code === 'student_already_exited');
  await t.close();
});

test('markBoarding no_abordo notifies the titulares, not only Recepción (L13)', async () => {
  const t = await makeTestApp();
  const ctx = await ctxFor(t, 'u_s7');
  await markBoarding(ctx, 'r1', 'ida', 'e1', 'no_abordo', 's7', null);
  assert.match((await listNotifications(t.db, { personId: 'p1' })).at(-1).text, /NO abordó el Bus 12/);
  assert.match((await listNotifications(t.db, { personId: 'p2' })).at(-1).text, /NO abordó el Bus 12/);
  assert.match((await listNotifications(t.db, { role: 'recepcion' })).at(-1).text, /no abordó el Bus 12/);
  await t.close();
});

test('setTripStatus (L13): only forward, single-step transitions are allowed', async () => {
  const t = await makeTestApp();
  const ctx = await ctxFor(t, 'u_s8'); // r2/ida has no seeded trip: starts at "programado"
  await assert.rejects(setTripStatus(ctx, 'r2', 'ida', 'finalizado', 's8'), (e) => e.code === 'invalid_transition', 'programado -> finalizado skips en_ruta');
  const started = await setTripStatus(ctx, 'r2', 'ida', 'en_ruta', 's8');
  assert.equal(started.status, 'en_ruta');
  const startedAt = started.startedAt;
  await assert.rejects(setTripStatus(ctx, 'r2', 'ida', 'en_ruta', 's8'), (e) => e.code === 'invalid_transition', 'a second en_ruta must not silently rewrite startedAt');
  assert.equal((await findTrip(t.db, todayISO(ctx.now, ctx.tz), 'r2', 'ida')).startedAt, startedAt);
  const ended = await setTripStatus(ctx, 'r2', 'ida', 'finalizado', 's8');
  assert.equal(ended.status, 'finalizado');
  await assert.rejects(setTripStatus(ctx, 'r2', 'ida', 'programado', 's8'), (e) => e.code === 'invalid_transition', 'finalizado must never go back to programado');
  await t.close();
});

test('whereIs (L11): an accepted/pending excusa for today explains an absence or tardanza before ever saying "está en el plantel"', async () => {
  const t = await makeTestApp();
  const ctx = await ctxFor(t, 'u_p7'); // Emily (e4) has no bus route, so nothing but the excusa check applies
  const today = todayISO(ctx.now, ctx.tz);
  const exc = await createRequest(ctx, { kind: 'excusa', requestedBy: 'p7', studentId: 'e4', channel: 'web', date: today, excusaType: 'ausencia', reason: 'Gripe' });
  const staffCtx = await ctxFor(t, 'u_s2');
  await acceptExcusa(staffCtx, exc.id, 's2');
  const w = await whereIs(ctx, 'e4');
  assert.match(w.text, /no asistió hoy/);
  assert.match(w.text, /Gripe/);
  await t.close();
});

test('whereIs (L11): a pending tardanza excusa says "llega tarde"; weekends say there is no school', async () => {
  const t = await makeTestApp();
  const ctx = await ctxFor(t, 'u_p7');
  const today = todayISO(ctx.now, ctx.tz);
  await createRequest(ctx, { kind: 'excusa', requestedBy: 'p7', studentId: 'e4', channel: 'web', date: today, excusaType: 'tardanza', reason: 'Cita médica' });
  const w = await whereIs(ctx, 'e4'); // still pendiente -- an unreviewed excusa still explains the absence
  assert.match(w.text, /llega tarde/);
  await t.close();

  const sat = await makeTestApp({ now: new Date('2026-09-19T15:30:00Z') }); // Saturday 10:30 Panama
  const satCtx = await ctxFor(sat, 'u_p7');
  const w2 = await whereIs(satCtx, 'e4');
  assert.match(w2.text, /no hay clases/);
  await sat.close();
});
