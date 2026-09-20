import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './client.js';
import { migrate } from './migrate.js';
import { seedDemo, resetAll, isEmpty, seedIfEmpty } from './seed.js';
import { getStudent, listUsers, listRoutes, findTrip, getRequest, listRequests, getPerson, getPermissions, getSettings, insertRow, patchRow, getRevision } from './repo.js';

const TZ = 'America/Panama';
const now = new Date('2026-09-18T15:30:00Z');

async function fresh() { const db = await openDb({}); await migrate(db); await db.tx((q) => seedDemo(q, { now, tz: TZ })); return db; }

test('seed creates the prototype families, staff, users and routes', async () => {
  const db = await fresh();
  const e1 = await getStudent(db, 'e1');
  assert.deepEqual(e1.titulares, ['p1', 'p2']);
  assert.equal(e1.routeId, 'r1');
  const users = await listUsers(db);
  assert.ok(users.find((u) => u.id === 'u_p1' && u.role === 'parent' && u.refId === 'p1'));
  assert.ok(users.find((u) => u.id === 'u_s6' && u.role === 'garita'));
  assert.equal(users.filter((u) => u.role === 'parent').length, 5);
  const routes = await listRoutes(db);
  assert.equal(routes[0].stops.length, 4);
  assert.equal(routes[0].schedule.vuelta.start, '15:00');
  const trip = await findTrip(db, '2026-09-18', 'r1', 'vuelta');
  assert.equal(trip.status, 'en_ruta');
  assert.equal(trip.boarded.e1.status, 'abordo');
  assert.deepEqual(trip.noBus, []);
  const p3 = await getPerson(db, 'p3');
  assert.ok(p3.docAttachmentId, 'seeded persons carry a demo document');
  assert.equal((await getPermissions(db)).garita.marcar_salida, true);
  assert.equal((await getSettings(db)).timezone, TZ);
  assert.equal(await getRevision(db), 1);
  await db.close();
});

test('seeded requests carry history and dates relative to today', async () => {
  const db = await fresh();
  const r = await getRequest(db, 'r_h1');
  assert.equal(r.status, 'retirado');
  assert.equal(r.date, '2026-09-17');
  assert.equal(r.history.length, 3);
  assert.equal(r.confirmation, null);
  const pending = await listRequests(db, { status: 'pendiente' });
  assert.deepEqual(pending.map((x) => x.id), ['r_h3']);
  await db.close();
});

test('insertRow and patchRow map camelCase, dates and json', async () => {
  const db = await fresh();
  await insertRow(db, 'notifications', { id: 'n1', personId: 'p1', text: 'hola', buttons: ['Sí', 'No'] });
  await patchRow(db, 'notifications', 'n1', { readAt: now, kind: 'wa' });
  const [row] = await db.query('SELECT * FROM notifications WHERE id=$1', ['n1']);
  assert.deepEqual(row.buttons, ['Sí', 'No']);
  assert.equal(new Date(row.read_at).getTime(), now.getTime());
  assert.equal(row.kind, 'wa');
  await db.close();
});

test('resetAll empties everything and seedIfEmpty only seeds once', async () => {
  const db = await fresh();
  await insertRow(db, 'notifications', { id: 'n1', personId: 'p1', text: 'hola' });
  await db.tx(async (q) => { await resetAll(q); assert.equal(await isEmpty(q), true); await seedDemo(q, { now, tz: TZ }); });
  assert.equal((await db.query('SELECT count(*)::int AS c FROM notifications'))[0].c, 0);
  await db.tx((q) => seedIfEmpty(q, { now, tz: TZ }));
  assert.equal((await db.query('SELECT count(*)::int AS c FROM students'))[0].c, 4);
  await db.close();
});
