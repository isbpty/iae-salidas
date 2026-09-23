import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { makeCtx } from './context.js';
import { isAuthActive, pickupEligibility, pickupCandidates, authorizedFor, withAuthExpiry, unaVezDefaultExpiry } from './eligibility.js';
import { evaluateAutoApprove } from './autoapprove.js';

/* Deviation from the brief: `t.db.tx((q) => makeCtx(q, ...))` returns a ctx whose `.q` is the
   transaction-scoped connection. PGlite closes that connection as soon as the tx callback's
   promise settles (see @electric-sql/pglite's `transaction()`: it flips a `closed` flag and every
   later query on it throws "Transaction is closed"), so a ctx meant to be used *after* the tx
   resolves can never work over PGlite. Building ctx straight off `t.db` gives the same `{query,
   exec}` surface makeCtx needs and stays valid for the rest of the test, matching how other tests
   in this codebase (e.g. server/db/seed.test.js) call repo functions with the plain `db` handle. */
const ctxFor = (t, userId) => makeCtx(t.db, t.deps, userId);

test('isAuthActive follows type, window, use and revocation', () => {
  const today = '2026-09-18';
  assert.equal(isAuthActive({ type: 'siempre' }, today), true);
  assert.equal(isAuthActive({ type: 'siempre', revokedAt: 1 }, today), false);
  assert.equal(isAuthActive({ type: 'temporal', validFrom: '2026-09-16', validTo: '2026-09-30' }, today), true);
  assert.equal(isAuthActive({ type: 'temporal', validFrom: '2026-09-19', validTo: '2026-09-30' }, today), false);
  assert.equal(isAuthActive({ type: 'una_vez' }, today), true);
  assert.equal(isAuthActive({ type: 'una_vez', usedAt: 1 }, today), false);
});

test('withAuthExpiry attaches the resolved una_vez expiry so the client never redoes the date math itself', () => {
  const ctx = { tz: 'America/Panama' };
  const createdAt = new Date('2026-09-17T15:30:00Z').getTime(); // 2026-09-17 10:30 Panama
  const list = [
    { id: 'a1', type: 'siempre' },
    { id: 'a3', type: 'temporal', validFrom: '2026-09-16', validTo: '2026-09-30' },
    { id: 'a4', type: 'una_vez', createdAt, validTo: null },
    { id: 'a5', type: 'una_vez', createdAt, validTo: '2026-09-19' },
  ];
  const out = withAuthExpiry(list, ctx);
  assert.equal(out.find((a) => a.id === 'a1').expiresOn, undefined, 'siempre never carries an expiry');
  assert.equal(out.find((a) => a.id === 'a3').expiresOn, undefined, 'temporal already has its own validTo, no expiresOn needed');
  assert.equal(out.find((a) => a.id === 'a4').expiresOn, '2026-09-24', 'default: 7 days after createdAt, in the school timezone');
  assert.equal(out.find((a) => a.id === 'a5').expiresOn, '2026-09-19', 'an explicit valid_to wins over the default');
  assert.equal(unaVezDefaultExpiry({ createdAt }, 'America/Panama'), '2026-09-24');
  assert.equal(unaVezDefaultExpiry({ createdAt: null }, 'America/Panama'), null);
});

test('eligibility distinguishes titular, authorized and strangers', async () => {
  const t = await makeTestApp();
  const ctx = await ctxFor(t, 'u_p1');
  assert.deepEqual(await pickupEligibility(ctx, 'e1', 'p1'), { ok: true, kind: 'titular' });
  assert.equal((await pickupEligibility(ctx, 'e1', 'p3')).kind, 'siempre');
  assert.equal((await pickupEligibility(ctx, 'e1', 'p4')).kind, 'temporal');
  assert.equal((await pickupEligibility(ctx, 'e1', 'p5')).kind, 'una_vez');
  assert.equal((await pickupEligibility(ctx, 'e1', 'p7')).ok, false);
  assert.equal((await pickupEligibility(ctx, 'e3', 'p3')).ok, false);
  const cands = await pickupCandidates(ctx, 'e1');
  assert.deepEqual(cands.map((c) => c.person.id + ':' + c.kind), ['p1:titular', 'p2:titular', 'p3:siempre', 'p4:temporal', 'p5:una_vez']);
  const forLaura = await authorizedFor(ctx, 'p5');
  assert.deepEqual(forLaura.map((x) => x.student.id), ['e1']);
  await t.close();
});

test('eligibility uses the date of the salida, not today: a temporal window outside the salida date is not eligible', async () => {
  const t = await makeTestApp();
  const ctx = await ctxFor(t, 'u_p1');
  // a3: p4 has a temporal authorization for e1, 2026-09-16..2026-09-30. "today" is 2026-09-18.
  assert.equal((await pickupEligibility(ctx, 'e1', 'p4', '2026-09-18')).kind, 'temporal', 'today falls inside the window');
  assert.equal((await pickupEligibility(ctx, 'e1', 'p4', '2026-10-15')).ok, false, 'October 15 is long past the window');
  const candsToday = await pickupCandidates(ctx, 'e1', '2026-09-18');
  assert.ok(candsToday.some((c) => c.person.id === 'p4'), 'p4 is a candidate for today');
  const candsOct = await pickupCandidates(ctx, 'e1', '2026-10-15');
  assert.ok(!candsOct.some((c) => c.person.id === 'p4'), 'p4 is not a candidate for a date outside the window');
  await t.close();
});

test('a temporal authorization that starts tomorrow is not eligible today but is eligible tomorrow', async () => {
  const t = await makeTestApp();
  const ctx = await ctxFor(t, 'u_p1');
  await t.run('add_authorization', 'u_p2', { studentIds: ['e1'], mode: 'cuenta', cedula: 'E-8-12345', type: 'temporal', from: '2026-09-19', to: '2026-10-03' });
  assert.equal((await pickupEligibility(ctx, 'e1', 'p7', '2026-09-18')).ok, false, 'the window has not started yet');
  assert.equal((await pickupEligibility(ctx, 'e1', 'p7', '2026-09-19')).kind, 'temporal', 'tomorrow the window is open');
  await t.close();
});

test('a una_vez authorization without an explicit valid_to expires 7 days after it was granted', async () => {
  const t = await makeTestApp();
  // a4: p5 has a una_vez authorization for e1, granted 2026-09-17 (a day before "now"): the
  // default window is 2026-09-17..2026-09-24 (7 days, inclusive).
  assert.equal((await pickupEligibility(await ctxFor(t, 'u_p1'), 'e1', 'p5')).kind, 'una_vez');
  t.clock.now = new Date('2026-09-24T15:00:00Z'); // last day of the default window: still active
  assert.equal((await pickupEligibility(await ctxFor(t, 'u_p1'), 'e1', 'p5')).kind, 'una_vez');
  t.clock.now = new Date('2026-09-25T15:00:00Z'); // one day past the window: expired
  assert.equal((await pickupEligibility(await ctxFor(t, 'u_p1'), 'e1', 'p5')).ok, false);
  await t.close();
});

test('una_vez respects an explicit valid_to', async () => {
  const t = await makeTestApp();
  await t.run('add_authorization', 'u_p1', { studentIds: ['e2'], mode: 'cuenta', cedula: '8-703-789', type: 'una_vez', to: '2026-09-19' });
  const ctx = await ctxFor(t, 'u_p1');
  assert.equal((await pickupEligibility(ctx, 'e2', 'p5', '2026-09-19')).kind, 'una_vez');
  assert.equal((await pickupEligibility(ctx, 'e2', 'p5', '2026-09-20')).ok, false, 'past the explicit valid_to');
  await t.close();
});

test('auto-approval rule returns the prototype reasons', async () => {
  const t = await makeTestApp(); // now = 10:30 Panama
  const ctx = await ctxFor(t, 'u_p1');
  const base = { studentId: 'e1', requestedBy: 'p1', pickupBy: 'p1', date: '2026-09-18', time: '13:00' };
  const st = { titulares: ['p1', 'p2'] };
  assert.deepEqual(await evaluateAutoApprove(ctx, base, st), { ok: true });
  assert.equal((await evaluateAutoApprove(ctx, { ...base, time: '11:00' }, st)).reason, 'menos de 60 min de anticipación');
  assert.equal((await evaluateAutoApprove(ctx, { ...base, requestedBy: 'p3' }, st)).reason, 'el solicitante no es titular');
  assert.equal((await evaluateAutoApprove(ctx, { ...base, pickupBy: 'p7' }, st)).reason, 'la persona que retira no está autorizada');
  assert.equal((await evaluateAutoApprove(ctx, { ...base, pickupBy: 'p5' }, st)).reason, 'autorización de una sola vez requiere revisión');
  assert.equal((await evaluateAutoApprove({ ...ctx, settings: { ...ctx.settings, autoApprove: false } }, base, st)).reason, 'auto-aprobación desactivada');
  await t.db.query("INSERT INTO requests(id, kind, student_id, requested_by, date, channel, status, created_at) VALUES ('rx','salida','e1','p1','2026-09-10','web','rechazada', $1)", [new Date('2026-09-10T15:00:00Z').toISOString()]);
  assert.equal((await evaluateAutoApprove(ctx, base, st)).reason, 'el estudiante tiene un rechazo reciente');
  await t.close();
});
