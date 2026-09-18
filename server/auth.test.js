import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { constantEquals, loginBlocked, recordLoginFailure, clearLoginFailures } from './auth.js';

test('constantEquals compares strings without leaking length', () => {
  assert.equal(constantEquals('4321', '4321'), true);
  assert.equal(constantEquals('4321', '43210'), false);
  assert.equal(constantEquals('', '1'), false);
});

test('ten failures inside 15 minutes block the key, clearing unblocks', async () => {
  const db = await openDb({}); await migrate(db);
  const now = new Date('2026-09-18T15:30:00Z');
  for (let i = 0; i < 9; i++) await recordLoginFailure(db, ['ip:1'], now);
  assert.equal(await loginBlocked(db, ['ip:1'], now), false);
  await recordLoginFailure(db, ['ip:1'], now);
  assert.equal(await loginBlocked(db, ['ip:1'], now), true);
  assert.equal(await loginBlocked(db, ['ip:1'], new Date(now.getTime() + 16 * 60000)), false, 'window expired');
  await clearLoginFailures(db, ['ip:1']);
  assert.equal(await loginBlocked(db, ['ip:1'], now), false);
  await db.close();
});
