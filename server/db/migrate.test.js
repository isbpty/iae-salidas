import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './client.js';
import { migrate } from './migrate.js';
import { MIGRATIONS } from './schema.js';

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

test('tx commits on success and rolls back on error', async () => {
  const db = await openDb({});
  await migrate(db);
  await db.tx(async (q) => { await q.query("INSERT INTO app_meta(id, value) VALUES ('t', 1)"); });
  await assert.rejects(db.tx(async (q) => { await q.query("INSERT INTO app_meta(id, value) VALUES ('u', 2)"); throw new Error('boom'); }), /boom/);
  const rows = await db.query("SELECT id FROM app_meta WHERE id IN ('t','u') ORDER BY id");
  assert.deepEqual(rows.map((r) => r.id), ['t']);
  await db.close();
});
