import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, NOW, TZ } from '../test-helpers.js';
import { seedLoad, planFamilies, rng, FAMILY_SIZE_WEIGHTS } from './seed-load.js';
import { listStudents, listStaff, listRoutes } from './repo.js';

test('planFamilies sums exactly to the target with sizes 1..5 and an average near 2.65', () => {
  const sizes = planFamilies(rng(1), 700);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 700);
  assert.ok(sizes.every((s) => s >= 1 && s <= 5));
  const avg = 700 / sizes.length;
  assert.ok(avg > 2.3 && avg < 3.0, 'average family size ' + avg);
  assert.equal(FAMILY_SIZE_WEIGHTS.reduce((a, [, w]) => a + w, 0).toFixed(2), '1.00');
});

test('seedLoad adds 700 consistent students on top of the base seed and stays deterministic', async () => {
  const t = await makeTestApp();
  const started = Date.now();
  const counts = await t.db.tx((q) => seedLoad(q, { students: 700, seed: 7, now: NOW, tz: TZ }));
  const ms = Date.now() - started;
  assert.equal(counts.students, 700);
  assert.ok(counts.families >= 230 && counts.families <= 310, 'families ' + counts.families);
  assert.ok(ms < 30000, 'load seed took ' + ms + ' ms');

  const students = await listStudents(t.db);
  assert.equal(students.length, 704, 'base 4 + 700');
  assert.ok(students.every((s) => s.titulares.length >= 1 && s.titulares.length <= 2));
  const grades = new Set(students.map((s) => s.grade));
  assert.equal(grades.size, 13, 'every grade populated');
  const teachers = (await listStaff(t.db)).filter((s) => s.role === 'profesor');
  for (const g of grades) assert.ok(teachers.some((x) => (x.grades || []).includes(g)), 'teacher for ' + g);
  assert.equal((await listRoutes(t.db)).length, 8);
  const onBus = students.filter((s) => s.routeId).length;
  assert.ok(onBus > 200 && onBus < 360, 'students on bus ' + onBus);

  const dupCedula = await t.db.query('SELECT cedula, count(*)::int AS c FROM persons WHERE cedula IS NOT NULL GROUP BY cedula HAVING count(*) > 1');
  assert.equal(dupCedula.length, 0);
  const dupPhone = await t.db.query('SELECT phone, count(*)::int AS c FROM persons WHERE phone IS NOT NULL GROUP BY phone HAVING count(*) > 1');
  assert.equal(dupPhone.length, 0);

  /* Every generated parent can log in and sees only their family */
  const [u] = await t.db.query("SELECT id, ref_id FROM users WHERE id LIKE 'u_pl_%' ORDER BY id LIMIT 1");
  const view = await t.view(u.id);
  assert.ok(view.students.length >= 1 && view.students.length <= 5);
  assert.ok(view.students.every((s) => s.titulares.includes(u.ref_id)));
  const rec = await t.view('u_s2');
  assert.equal(rec.students.length, 704);
  assert.ok(rec.requests.length > 40, 'history and pending load for reception: ' + rec.requests.length);

  /* Same seed → same data */
  const t2 = await makeTestApp();
  await t2.db.tx((q) => seedLoad(q, { students: 700, seed: 7, now: NOW, tz: TZ }));
  const a = await t.db.query("SELECT id, name, grade FROM students WHERE id LIKE 'el_%' ORDER BY id LIMIT 20");
  const b = await t2.db.query("SELECT id, name, grade FROM students WHERE id LIKE 'el_%' ORDER BY id LIMIT 20");
  assert.deepEqual(a, b);
  await t.close(); await t2.close();
});

test('seed_load command is admin-only, resets and loads', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('seed_load', 'u_s2', { students: 100 }), /forbidden_role/);
  const { result } = await t.run('seed_load', 'u_s1', { students: 120 });
  assert.equal(result.students, 120);
  assert.equal((await listStudents(t.db)).length, 124);
  const { result: again } = await t.run('seed_load', 'u_s1', { students: 60 });
  assert.equal(again.students, 60);
  assert.equal((await listStudents(t.db)).length, 64, 'reloading resets first');
  await t.close();
});
