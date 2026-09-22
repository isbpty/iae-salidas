import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { resetAll } from './db/seed.js';
import { hashPin, verifyPin, randomPin, pinLookup, createTesters, findTesterByPin, regenerateTesterPin, listTesters, renameTester } from './testers.js';

const SECRET = 's'.repeat(32);
import { insertActivity } from './db/repo.js';

test('PIN hashes are salted and verify only the right PIN', async () => {
  const a = hashPin('123456'), b = hashPin('123456');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('scrypt$'));
  assert.equal(await verifyPin('123456', a), true);
  assert.equal(await verifyPin('123457', a), false);
  assert.equal(await verifyPin('123456', 'garbage'), false);
  assert.match(randomPin(), /^\d{6}$/);
});

test('createTesters makes 10 testers once, PINs resolve, and resets keep them', async () => {
  const db = await openDb({}); await migrate(db);
  const now = new Date('2026-09-20T12:00:00Z');
  const made = await db.tx((q) => createTesters(q, now, SECRET));
  assert.equal(made.length, 10);
  assert.equal(made[0].id, 't1'); assert.equal(made[0].name, 'Super admin');
  assert.ok(made.every((t) => /^\d{6}$/.test(t.pin)));
  assert.equal((await db.tx((q) => createTesters(q, now, SECRET))).length, 0, 'second call is a no-op');
  const found = await findTesterByPin(db, made[3].pin, SECRET);
  assert.equal(found.id, 't4'); assert.equal(found.super, false); assert.equal(found.pinHash, undefined);
  assert.equal(await findTesterByPin(db, '000000' === made[3].pin ? '000001' : '000000', SECRET), null);
  const t1 = await findTesterByPin(db, made[0].pin, SECRET);
  assert.equal(t1.super, true);

  const re = await db.tx((q) => regenerateTesterPin(q, 't4', SECRET));
  assert.notEqual(re.pin, made[3].pin);
  assert.equal(await findTesterByPin(db, made[3].pin, SECRET), null, 'old PIN dead');
  assert.equal((await findTesterByPin(db, re.pin, SECRET)).id, 't4');
  assert.equal((await db.tx((q) => renameTester(q, 't4', 'María'))).name, 'María');

  await insertActivity(db, { at: now, source: 'server', kind: 'login', testerId: 't4' });
  assert.equal((await db.query('SELECT count(*)::int AS c FROM activity_events'))[0].c, 1);
  await db.tx((q) => resetAll(q));
  assert.equal((await listTesters(db)).length, 10, 'testers survive reset');
  assert.equal((await db.query('SELECT count(*)::int AS c FROM activity_events'))[0].c, 1, 'activity history survives a demo reset');
  await db.close();
});

test('PINs are found by their HMAC lookup; testers created before the lookup still work and get one on first use', async () => {
  const db = await openDb({}); await migrate(db);
  const now = new Date('2026-09-20T12:00:00Z');
  const made = await db.tx((q) => createTesters(q, now, SECRET));
  const rows = await db.query('SELECT id, pin_lookup FROM testers ORDER BY length(id), id');
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.pin_lookup)), 'every new PIN writes its lookup');
  assert.equal(rows[1].pin_lookup, pinLookup(made[1].pin, SECRET));
  assert.equal((await findTesterByPin(db, made[1].pin, SECRET)).id, 't2');
  assert.equal(await findTesterByPin(db, made[1].pin, 'x'.repeat(32)), null, 'the lookup is peppered with the secret');

  /* A lookup that matches but a hash that does not: the lookup alone never proves the PIN. */
  await db.query("UPDATE testers SET pin_hash = $1 WHERE id = 't3'", [hashPin('999999')]);
  assert.equal(await findTesterByPin(db, made[2].pin, SECRET), null);

  /* Production testers made before migration 006 have no lookup: the old scan still finds them, and fills it in. */
  await db.query("UPDATE testers SET pin_hash = $1, pin_lookup = NULL WHERE id = 't4'", [hashPin('123123')]);
  const legacy = await findTesterByPin(db, '123123', SECRET);
  assert.equal(legacy.id, 't4'); assert.equal(legacy.pinLookup, undefined);
  assert.equal((await db.query("SELECT pin_lookup FROM testers WHERE id = 't4'"))[0].pin_lookup, pinLookup('123123', SECRET), 'first use writes the lookup');
  assert.equal((await findTesterByPin(db, '123123', SECRET)).id, 't4', 'and from then on the lookup path finds it');
  assert.equal(await findTesterByPin(db, '321321', SECRET), null);

  const re = await db.tx((q) => regenerateTesterPin(q, 't5', SECRET));
  assert.equal((await db.query("SELECT pin_lookup FROM testers WHERE id = 't5'"))[0].pin_lookup, pinLookup(re.pin, SECRET), 'regenerating writes the lookup');
  assert.ok((await db.query("SELECT sessions_valid_after FROM testers WHERE id = 't5'"))[0].sessions_valid_after, 'and revokes open sessions');
  assert.equal(await verifyPin('123456', hashPin('123456')), true);
  assert.equal(await verifyPin('123457', hashPin('123456')), false);
  await db.close();
});
