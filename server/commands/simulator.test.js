/* L18: el simulador reservaba su "instancia única" solo por pestaña -- dos probadores que lo arrancan a
   la vez ejecutaban `reset_demo` uno sobre el otro. `sim_lock` guarda un candado de 15 min en
   `app_meta` (id='sim_lock'): `acquire` falla con 409 `simulator_busy` mientras no venció, `release` lo
   limpia antes de tiempo. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';

test('sim_lock: acquire rechaza mientras otro probador lo tiene, release lo libera', async () => {
  const t = await makeTestApp();
  const r1 = await t.run('sim_lock', 'u_p1', { action: 'acquire' });
  assert.equal(typeof r1.result.until, 'number');
  /* Otro probador (otro rol, cualquiera puede correr el simulador) no puede arrancar mientras dure. */
  await assert.rejects(t.run('sim_lock', 'u_s6', { action: 'acquire' }), /simulator_busy/);
  await t.run('sim_lock', 'u_p1', { action: 'release' });
  const r2 = await t.run('sim_lock', 'u_s6', { action: 'acquire' });
  assert.equal(typeof r2.result.until, 'number');
  await t.close();
});

test('sim_lock: el candado vence solo a los 15 minutos', async () => {
  const t = await makeTestApp();
  await t.run('sim_lock', 'u_p1', { action: 'acquire' });
  await assert.rejects(t.run('sim_lock', 'u_s6', { action: 'acquire' }), /simulator_busy/);
  /* Nadie lo suelta, pero pasan más de 15 minutos: el siguiente acquire lo puede tomar. */
  t.clock.now = new Date(t.clock.now.getTime() + 16 * 60 * 1000);
  const r = await t.run('sim_lock', 'u_s6', { action: 'acquire' });
  assert.equal(typeof r.result.until, 'number');
  await t.close();
});

test('sim_lock: release sin candado no falla; cualquier rol puede correrlo', async () => {
  const t = await makeTestApp();
  const r = await t.run('sim_lock', 'u_s3', { action: 'release' });
  assert.equal(r.result.released, true);
  await t.run('sim_lock', 'u_s2', { action: 'acquire' });
  await t.run('sim_lock', 'u_s2', { action: 'release' });
  const r2 = await t.run('sim_lock', 'u_s7', { action: 'acquire' });
  assert.equal(typeof r2.result.until, 'number');
  await t.close();
});

test('sim_lock: no bombea la revisión (bump: false)', async () => {
  const t = await makeTestApp();
  const before = (await t.run('sim_lock', 'u_p1', { action: 'acquire' })).revision;
  const after = (await t.run('sim_lock', 'u_p1', { action: 'release' })).revision;
  assert.equal(after, before);
  await t.close();
});
