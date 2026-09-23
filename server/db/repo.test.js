import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, countQueries, NOW, TZ } from '../test-helpers.js';
import { seedLoad } from './seed-load.js';
import { makeCtx } from '../domain/context.js';
import { staffView } from '../projections/staff.js';

/* Reads only: R2 is about *over-fetching* (`withTitulares` scanning all guardianships, `getRoute`
   scanning every route/stop, hydrating history/confirmations nobody asked for, `listStaff` re-run
   per notice...) -- every one of those is a `SELECT`. The write side of a command (one notification
   row + one chat row + one audit row per actual recipient) is a fixed, correctness-mandated cost
   that scales with real recipients, not with table size, and isn't part of the N+1 story. */
const selects = (calls) => calls.filter((c) => /^\s*SELECT/i.test(c));

/* R2/Task 6: `create_salida` used to read the full `guardianships` table on every `getStudent`
   (~8 calls), re-list every route to answer `getRoute`, hydrate history/confirmations for requests
   that only ever needed a `code` or a `status` (uniqueCode, the rejected/duplicate checks), re-run
   `listStaff` once per notice, and re-fetch the same student/person over and over. This test pins a
   read-query budget so a future change cannot silently reintroduce the N+1. */
test('create_salida hace 20 lecturas o menos', async () => {
  const t = await makeTestApp();
  const { calls } = await countQueries(t.db, (mark) => t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'Cita médica' }));
  const reads = selects(calls);
  assert.ok(reads.length <= 20, 'create_salida hizo ' + reads.length + ' lecturas (tope 20):\n' + reads.join('\n'));
  await t.close();
});

/* R2/Task 6: Recepción rebuilds its whole screen on every non-304 poll. With 700 students the old
   `withTitulares`/`getRoute`/`listStaff`/double `listNotifications` behavior scanned thousands of
   rows and cost 21 queries per rebuild (matches the review's own count). This budgets the
   projection's own queries -- not the `makeCtx` session bootstrap, which is identical for every
   request regardless of role or dataset size and isn't part of R2. */
test('vista de Recepción con 700 estudiantes hace 12 consultas o menos', async () => {
  const t = await makeTestApp();
  await t.db.tx((q) => seedLoad(q, { students: 700, seed: 7, now: NOW, tz: TZ }));
  const { count, calls } = await countQueries(t.db, (mark) => t.db.tx(async (q) => {
    const ctx = await makeCtx(q, t.deps, 'u_s2');
    mark();
    return staffView(ctx);
  }));
  assert.ok(count <= 12, 'la vista de Recepción hizo ' + count + ' consultas (tope 12):\n' + calls.join('\n'));
  await t.close();
});
