import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { makeCtx } from './context.js';
import { isAuthActive, pickupEligibility, pickupCandidates, authorizedFor } from './eligibility.js';
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
