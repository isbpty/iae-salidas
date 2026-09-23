import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './client.js';
import { migrate, bootstrap } from './migrate.js';
import { MIGRATIONS } from './schema.js';
import { countQueries } from '../test-helpers.js';

test('migrate creates the schema once and is idempotent', async () => {
  const db = await openDb({});
  await migrate(db);
  await migrate(db);
  const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1")).map((r) => r.table_name);
  for (const t of ['settings', 'app_meta', 'levels', 'staff', 'role_permissions', 'persons', 'students', 'guardianships', 'users', 'attachments', 'authorizations', 'requests', 'request_events', 'pickup_confirmations', 'notifications', 'chat_messages', 'conversation_state', 'routes', 'stops', 'trips', 'trip_boardings', 'bus_opt_outs', 'audit_log', 'login_attempts', 'testers', 'activity_events', 'schema_migrations']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  const applied = await db.query('SELECT version FROM schema_migrations');
  assert.equal(applied.length, MIGRATIONS.length);
  await db.close();
});

/* C2/migration 012_integrity: every constraint/index it adds must actually exist afterwards, and
   `VALIDATE CONSTRAINT` must have left it in the "validated" state (`convalidated`) -- a NOT VALID
   constraint that silently failed to validate would still let bad data back in. */
test('012_integrity: date/time CHECKs, the six new FKs and the activity_events(at) index are all present and validated', async () => {
  const db = await openDb({});
  await migrate(db);
  const constraints = await db.query(
    "SELECT conname, contype, convalidated FROM pg_constraint WHERE conname IN ('requests_date_format', 'requests_time_format', 'requests_requested_by_fkey', 'requests_pickup_by_fkey', 'requests_decided_by_fkey', 'notifications_person_id_fkey', 'notifications_staff_id_fkey', 'trip_boardings_student_id_fkey')");
  assert.equal(constraints.length, 8, 'missing constraint(s): ' + JSON.stringify(constraints));
  for (const c of constraints) assert.ok(c.convalidated, c.conname + ' was not validated');
  assert.equal(constraints.find((c) => c.conname === 'requests_date_format').contype, 'c');
  assert.equal(constraints.filter((c) => c.contype === 'f').length, 6, 'requested_by/pickup_by/decided_by/person_id/staff_id/student_id FKs');
  const indexes = await db.query("SELECT indexname FROM pg_indexes WHERE tablename='activity_events' AND indexname='activity_at'");
  assert.equal(indexes.length, 1);
  await db.close();
});

/* R5: on a warm instance `bootstrap` should not take the advisory lock (a real transaction, with a
   real `pg_advisory_xact_lock` round trip on Postgres) or touch the seed at all once the schema is
   current and the demo data is present -- only the one un-locked check. */
test('bootstrap no toma el lock ni re-siembra en una instancia tibia', async () => {
  const db = await openDb({});
  const env = { now: new Date('2026-09-18T15:30:00Z'), tz: 'America/Panama' };
  await bootstrap(db, env); // cold: migrates and seeds
  const before = (await db.query('SELECT count(*)::int AS c FROM users'))[0].c;
  assert.ok(before > 0, 'the cold bootstrap seeded demo users');

  const { count, calls } = await countQueries(db, () => bootstrap(db, env));
  assert.ok(!calls.some((s) => /INSERT|UPDATE|DELETE|CREATE|ALTER/i.test(s)), 'a warm bootstrap writes and runs no DDL:\n' + calls.join('\n'));
  assert.ok(count <= 3, 'a warm bootstrap is a couple of un-locked reads (to_regclass, applied versions, seed check), not a migrate+seed pass: ' + count + '\n' + calls.join('\n'));
  const after = (await db.query('SELECT count(*)::int AS c FROM users'))[0].c;
  assert.equal(after, before, 'nothing got re-seeded');
  await db.close();
});

test('tx commits on success and rolls back on error', async () => {
  const db = await openDb({});
  await migrate(db);
  await db.tx(async (q) => { await q.query("INSERT INTO app_meta(id, value) VALUES ('t', 1)"); });
  await assert.rejects(db.tx(async (q) => { await q.query("INSERT INTO app_meta(id, value) VALUES ('u', 2)"); throw new Error('boom'); }), /boom/);
  const rows = await db.query("SELECT id FROM app_meta WHERE id IN ('t','u') ORDER BY id");
  assert.deepEqual(rows.map((r) => r.id), ['t']);
  await db.close();
});
