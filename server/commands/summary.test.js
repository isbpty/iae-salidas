import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { listNotifications } from '../db/repo.js';

test('day_summary counts today, measures times and send_day_summary notifies Dirección', async () => {
  const t = await makeTestApp();
  const before = (await t.run('day_summary', 'u_s2')).result;
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '11:00', pickupBy: 'p3', reason: 'x' });
  await t.run('approve_request', 'u_s2', { requestId: r.id, pickupPoint: 'Puerta Principal' });
  t.clock.now = new Date(t.clock.now.getTime() + 20 * 60000);
  await t.run('mark_exit', 'u_s6', { requestId: r.id });
  await t.run('create_excusa', 'u_p1', { studentId: 'e2', date: '2026-09-21', excusaType: 'Cita médica', reason: 'y' });
  const s = (await t.run('day_summary', 'u_s2')).result;
  assert.equal(s.date, '2026-09-18');
  assert.equal(s.salidas.pedidas, before.salidas.pedidas + 1);
  assert.equal(s.salidas.retiradas, before.salidas.retiradas + 1);
  assert.equal(s.excusas.recibidas, before.excusas.recibidas + 1);
  assert.equal(s.canales.app, before.canales.app + 2);
  assert.ok(s.tiempos.retiroPromedioMin >= 19 && s.tiempos.retiroPromedioMin <= 21, 'approved → exit ≈ 20 min: ' + s.tiempos.retiroPromedioMin);
  assert.ok(s.topRetira.some((x) => x.name === 'María Pérez'));
  assert.match(s.text, /Resumen del viernes, 18 de septiembre/);
  assert.match(s.text, /Retiró más: .*María Pérez/);
  await assert.rejects(t.run('day_summary', 'u_s6'), /forbidden_capability/);

  await t.run('send_day_summary', 'u_s2');
  const admin = await listNotifications(t.db, { role: 'admin' });
  assert.ok(admin.some((n) => n.text.startsWith('📊 Resumen del')));
  const audit = await t.db.query("SELECT summary FROM audit_log WHERE summary LIKE '%resumen del día%'");
  assert.equal(audit.length, 1);
  await t.close();
});
