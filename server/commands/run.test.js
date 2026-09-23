/* R1: los comandos de solo lectura no invalidan la vista de todos (bump: false). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';

test('los comandos de lectura no suben app_meta.revision; los que cambian datos sí', async () => {
  const t = await makeTestApp();
  const r0 = (await t.run('day_summary', 'u_s1', {})).revision;
  assert.equal((await t.run('day_summary', 'u_s1', {})).revision, r0, 'day_summary no sube la revisión');
  assert.equal((await t.run('where_is', 'u_p1', { studentId: 'e1' })).revision, r0, 'where_is no sube la revisión');
  assert.equal((await t.run('mark_notifications_read', 'u_p1', {})).revision, r0, 'mark_notifications_read no sube la revisión');

  const { result: salida, revision: r1 } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' });
  assert.ok(r1 > r0, 'create_salida sube la revisión');
  assert.ok(salida.code, 'la salida quedó auto-aprobada con código');

  const { revision: r2 } = await t.run('scan_code', 'u_s6', { code: salida.code });
  assert.equal(r2, r1, 'scan_code no sube la revisión');

  const { revision: r3 } = await t.run('send_day_summary', 'u_s1', {});
  assert.ok(r3 > r2, 'send_day_summary sí sube la revisión (crea un aviso a Dirección)');
  await t.close();
});
