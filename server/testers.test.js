import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { resetAll } from './db/seed.js';
import { hashPin, verifyPin, randomPin, createTesters, findTesterByPin, regenerateTesterPin, listTesters, renameTester } from './testers.js';
import { insertActivity } from './db/repo.js';

test('PIN hashes are salted and verify only the right PIN', () => {
  const a = hashPin('123456'), b = hashPin('123456');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('scrypt$'));
  assert.equal(verifyPin('123456', a), true);
  assert.equal(verifyPin('123457', a), false);
  assert.equal(verifyPin('123456', 'garbage'), false);
  assert.match(randomPin(), /^\d{6}$/);
});

test('createTesters makes 10 testers once, PINs resolve, and resets keep them', async () => {
  const db = await openDb({}); await migrate(db);
  const now = new Date('2026-09-20T12:00:00Z');
  const made = await db.tx((q) => createTesters(q, now));
  assert.equal(made.length, 10);
  assert.equal(made[0].id, 't1'); assert.equal(made[0].name, 'Super admin');
  assert.ok(made.every((t) => /^\d{6}$/.test(t.pin)));
  assert.equal((await db.tx((q) => createTesters(q, now))).length, 0, 'second call is a no-op');
  const found = await findTesterByPin(db, made[3].pin);
  assert.equal(found.id, 't4'); assert.equal(found.super, false); assert.equal(found.pinHash, undefined);
  assert.equal(await findTesterByPin(db, '000000' === made[3].pin ? '000001' : '000000'), null);
  const t1 = await findTesterByPin(db, made[0].pin);
  assert.equal(t1.super, true);

  const re = await db.tx((q) => regenerateTesterPin(q, 't4'));
  assert.notEqual(re.pin, made[3].pin);
  assert.equal(await findTesterByPin(db, made[3].pin), null, 'old PIN dead');
  assert.equal((await findTesterByPin(db, re.pin)).id, 't4');
  assert.equal((await db.tx((q) => renameTester(q, 't4', 'María'))).name, 'María');

  await insertActivity(db, { at: now, source: 'server', kind: 'login', testerId: 't4' });
  assert.equal((await db.query('SELECT count(*)::int AS c FROM activity_events'))[0].c, 1);
  await db.tx((q) => resetAll(q));
  assert.equal((await listTesters(db)).length, 10, 'testers survive reset');
  assert.equal((await db.query('SELECT count(*)::int AS c FROM activity_events'))[0].c, 1, 'activity history survives a demo reset');
  await db.close();
});
