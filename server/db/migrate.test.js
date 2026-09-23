import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './client.js';
import { migrate, bootstrap } from './migrate.js';
import { MIGRATIONS } from './schema.js';
import { seedDemo } from './seed.js';
import { countQueries, NOW, TZ } from '../test-helpers.js';

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

/* C2/migration 012_integrity: every constraint/index it adds must actually exist afterwards. The six
   FKs must have been `VALIDATE CONSTRAINT`ed (`convalidated`) -- a NOT VALID FK that silently failed
   to validate would still let bad data back in. The two `date`/`time` CHECKs are the opposite on
   purpose: they stay `NOT VALID` forever (never `VALIDATE CONSTRAINT`ed) because a malformed date/time
   on an old row cannot be safely auto-repaired or deleted the way a dangling FK reference can -- see
   the migration's own comment in schema.js. This only asserts what the migration leaves behind; the
   test below ("cleans up pre-existing dangling references...") exercises *why* that cleanup exists. */
test('012_integrity: date/time CHECKs stay NOT VALID, the six new FKs are validated, and the activity_events(at) index exists', async () => {
  const db = await openDb({});
  await migrate(db);
  const constraints = await db.query(
    "SELECT conname, contype, convalidated FROM pg_constraint WHERE conname IN ('requests_date_format', 'requests_time_format', 'requests_requested_by_fkey', 'requests_pickup_by_fkey', 'requests_decided_by_fkey', 'notifications_person_id_fkey', 'notifications_staff_id_fkey', 'trip_boardings_student_id_fkey')");
  assert.equal(constraints.length, 8, 'missing constraint(s): ' + JSON.stringify(constraints));
  const checks = constraints.filter((c) => c.contype === 'c');
  const fks = constraints.filter((c) => c.contype === 'f');
  assert.equal(checks.length, 2, 'requests_date_format/requests_time_format');
  assert.equal(fks.length, 6, 'requested_by/pickup_by/decided_by/person_id/staff_id/student_id FKs');
  for (const c of checks) assert.equal(c.convalidated, false, c.conname + ' should stay NOT VALID (unvalidated) -- old malformed rows are never scanned');
  for (const c of fks) assert.ok(c.convalidated, c.conname + ' was not validated');
  const indexes = await db.query("SELECT indexname FROM pg_indexes WHERE tablename='activity_events' AND indexname='activity_at'");
  assert.equal(indexes.length, 1);
  await db.close();
});

/* Controller fix round: `bootstrap` runs `migrate()` on every cold start, including against the live
   Neon database, which already has rows written by code that predates every constraint 012 adds --
   `decided_by = 'auto'` for auto-approved salidas chief among them. If 012's `VALIDATE CONSTRAINT`
   failed on that data it would abort the whole migration transaction and, since bootstrap is
   unconditional, take the entire app down (503 for everyone). This reproduces that exact situation:
   migrate up to 011 (the schema as it existed before this task), seed the demo data, hand-insert the
   kinds of dangling rows a pre-012 codebase could have left behind, then apply 012 alone and assert
   it succeeds *and* did the right thing with each row -- repair-in-place where the column is optional,
   delete where it isn't (or where nothing meaningful is left), and never touch/delete a row over a
   merely malformed date (the CHECK stays unvalidated, see the test above). */
test('012_integrity cleans up pre-existing dangling references before validating the new FKs, without touching malformed dates/times', async () => {
  const db = await openDb({});
  await db.tx(async (q) => {
    await q.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const m of MIGRATIONS.slice(0, -1)) {
      await q.exec(m.sql);
      await q.query('INSERT INTO schema_migrations(version) VALUES ($1)', [m.version]);
    }
  });
  await db.tx((q) => seedDemo(q, { now: NOW, tz: TZ }));

  await db.tx(async (q) => {
    // decided_by = 'auto': the pre-012 sentinel for an auto-approved salida -- not a staff id.
    await q.query(`INSERT INTO requests (id, kind, student_id, requested_by, pickup_by, date, time, reason, channel, status, decided_by, decided_at, auto_approved, created_at)
      VALUES ('r_dirty_auto', 'salida', 'e1', 'p1', 'p1', '2026-09-18', '13:00', 'x', 'web', 'aprobada', 'auto', now(), true, now())`);
    // pickup_by pointing at a person that no longer exists (e.g. a stale row from an earlier seed_load).
    await q.query(`INSERT INTO requests (id, kind, student_id, requested_by, pickup_by, date, time, reason, channel, status, created_at)
      VALUES ('r_dirty_pickup', 'salida', 'e1', 'p1', 'nobody', '2026-09-18', '13:00', 'x', 'web', 'pendiente', now())`);
    // requested_by pointing at nobody at all -- the row itself is meaningless without it.
    await q.query(`INSERT INTO requests (id, kind, student_id, requested_by, date, time, reason, channel, status, created_at)
      VALUES ('r_dirty_requester', 'salida', 'e1', 'nobody', '2026-09-18', '13:00', 'x', 'web', 'pendiente', now())`);
    // A malformed date -- must survive the migration untouched (see the test above: never validated).
    await q.query(`INSERT INTO requests (id, kind, student_id, requested_by, date, reason, channel, status, created_at)
      VALUES ('r_dirty_date', 'excusa', 'e1', 'p1', '2026-13-45', 'x', 'web', 'pendiente', now())`);
    // A notification with a dangling staff_id.
    await q.query(`INSERT INTO notifications (id, staff_id, text, kind, created_at) VALUES ('n_dirty', 'nobody', 'x', 'info', now())`);
    // A trip_boardings row for a student that no longer exists.
    await q.query(`INSERT INTO trips (id, date, route_id, leg, status) VALUES ('trip_dirty', '2026-09-18', 'r1', 'ida', 'programado')`);
    await q.query(`INSERT INTO trip_boardings (trip_id, student_id, status, by_staff_id, at) VALUES ('trip_dirty', 'nobody', 'abordo', 's7', now())`);
  });

  const twelve = MIGRATIONS[MIGRATIONS.length - 1];
  assert.equal(twelve.version, '012_integrity', 'this test targets the last migration -- update it if a 013 lands after it');
  await db.tx((q) => q.exec(twelve.sql)); // must not throw despite every dirty row above

  const dirtyAuto = (await db.query("SELECT decided_by FROM requests WHERE id='r_dirty_auto'"))[0];
  assert.ok(dirtyAuto, 'the row itself is kept (decided_by is optional)');
  assert.equal(dirtyAuto.decided_by, null, "the 'auto' sentinel was nulled out instead of violating the new FK");

  const dirtyPickup = (await db.query("SELECT pickup_by FROM requests WHERE id='r_dirty_pickup'"))[0];
  assert.ok(dirtyPickup, 'the row itself is kept (pickup_by is optional)');
  assert.equal(dirtyPickup.pickup_by, null, 'a dangling pickup_by was nulled out instead of violating the new FK');

  assert.equal((await db.query("SELECT id FROM requests WHERE id='r_dirty_requester'")).length, 0, 'a request with no valid requested_by is deleted, not left dangling');
  assert.equal((await db.query("SELECT id FROM request_events WHERE request_id='r_dirty_requester'")).length, 0, 'ON DELETE CASCADE took its (nonexistent here) history with it');

  assert.equal((await db.query("SELECT id FROM requests WHERE id='r_dirty_date'")).length, 1, 'a malformed date is NOT deleted -- the CHECK stays NOT VALID for existing rows');

  assert.equal((await db.query("SELECT id FROM notifications WHERE id='n_dirty'")).length, 0, 'a notification with a dangling staff_id is deleted');

  assert.equal((await db.query("SELECT trip_id FROM trip_boardings WHERE trip_id='trip_dirty'")).length, 0, 'a trip_boardings row for a student that no longer exists is deleted');
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
