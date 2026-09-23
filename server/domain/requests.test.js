import test from 'node:test';
import assert from 'node:assert/strict';
import { insertSalidaRequest, withExpired } from './requests.js';

/* Focused unit tests for the two small pure/near-pure helpers this task adds, isolated from the
   full app so the retry path can be forced deterministically instead of relying on a genuine
   concurrent collision (which the test harness can't produce: PGlite serializes every tx). */

test('insertSalidaRequest retries with a new code when the insert collides with the unique index', async () => {
  let calls = 0;
  const fakeQ = {
    query: async () => {
      calls++;
      if (calls === 1) { const e = new Error('duplicate key value violates unique constraint "requests_date_code"'); e.code = '23505'; throw e; }
      return [];
    },
  };
  const req = { id: 'rx', kind: 'salida', date: '2026-09-18', code: '1111' };
  await insertSalidaRequest({ q: fakeQ }, req);
  assert.equal(calls, 2, 'the first attempt collided, the second succeeded');
  assert.match(req.code, /^\d{4}$/);
  assert.notEqual(req.code, '1111', 'a fresh code was generated after the collision');
});

test('insertSalidaRequest gives up and rethrows any other error immediately', async () => {
  const boom = new Error('connection lost');
  const fakeQ = { query: async () => { throw boom; } };
  const req = { id: 'rx', kind: 'salida', date: '2026-09-18', code: '1111' };
  await assert.rejects(insertSalidaRequest({ q: fakeQ }, req), (e) => e === boom);
});

test('withExpired flags approved salidas from a past date without touching anything else', () => {
  const requests = [
    { id: 'r1', kind: 'salida', status: 'aprobada', date: '2026-09-17' },
    { id: 'r2', kind: 'salida', status: 'aprobada', date: '2026-09-18' },
    { id: 'r3', kind: 'salida', status: 'pendiente', date: '2026-09-17' },
    { id: 'r4', kind: 'salida', status: 'retirado', date: '2026-09-17' },
  ];
  const out = withExpired(requests, '2026-09-18');
  assert.deepEqual(out.map((r) => [r.id, r.expired]), [['r1', true], ['r2', false], ['r3', false], ['r4', false]]);
  assert.equal(out[0].status, 'aprobada', 'the stored status is never changed');
});
