import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { getSettings, getPermissions, listNotifications, listAudit, insertRow } from '../db/repo.js';

test('update_settings validates and merges, and logs the change', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('update_settings', 'u_s2', { data: {} }), /forbidden_capability:config/);
  const { result } = await t.run('update_settings', 'u_s1', { data: { autoApprove: false, minAnticipationMin: 90, maxTitulares: 3, schoolStart: '07:00', schoolEnd: '14:30', simulateBus: false, busProgress: 0.5, newAuthDays: 10, school: { name: 'IAE Norte', phone: '+507 1', pickupPoints: ['Puerta A', 'Puerta B'] }, defaultPickupPoint: 'Puerta B' } });
  assert.equal(result.autoApprove, false);
  assert.equal(result.minAnticipationMin, 90);
  assert.equal(result.school.name, 'IAE Norte');
  assert.equal(result.defaultPickupPoint, 'Puerta B');
  assert.equal(result.timezone, 'America/Panama', 'timezone is kept');
  assert.equal((await getSettings(t.db)).school.short, 'IAE', 'untouched keys survive');
  const { result: fixed } = await t.run('update_settings', 'u_s1', { data: { defaultPickupPoint: 'No existe', minAnticipationMin: -5, busProgress: 7 } });
  assert.equal(fixed.defaultPickupPoint, 'Puerta A');
  assert.equal(fixed.minAnticipationMin, 0);
  assert.equal(fixed.busProgress, 1);
  await assert.rejects(t.run('update_settings', 'u_s1', { data: { schoolStart: '7am' } }), /invalid_time/);
  await assert.rejects(t.run('update_settings', 'u_s1', { data: { school: { pickupPoints: [] } } }), /pickup_points_required/);
  assert.match((await listAudit(t.db, 1))[0].summary, /^Actualizó la configuración \(auto-aprobación: inactiva, anticipación 0 min\)$/);
  await t.close();
});

test('set_permission edits the matrix except for admin', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('set_permission', 'u_s2', { role: 'garita', capability: 'aprobar', allowed: true }), /forbidden_capability:personal/);
  await assert.rejects(t.run('set_permission', 'u_s1', { role: 'admin', capability: 'aprobar', allowed: false }), /admin_permissions_fixed/);
  await assert.rejects(t.run('set_permission', 'u_s1', { role: 'garita', capability: 'volar', allowed: true }), /invalid_capability/);
  const { result } = await t.run('set_permission', 'u_s1', { role: 'garita', capability: 'aprobar', allowed: true });
  assert.equal(result.garita.aprobar, true);
  assert.equal((await getPermissions(t.db)).garita.aprobar, true);
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '11:00', pickupBy: 'p1', reason: 'x' });
  const { result: ok } = await t.run('approve_request', 'u_s6', { requestId: r.id });
  assert.equal(ok.status, 'aprobada', 'the gate can now approve');
  assert.match((await listAudit(t.db, 3)).map((a) => a.summary).join('\n'), /Permiso "aprobar" otorgado a Garita de salida/);
  await t.close();
});

test('reset_demo wipes movement and reseeds; mark_notifications_read marks mine', async () => {
  const t = await makeTestApp();
  await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' });
  assert.equal((await listNotifications(t.db, { personId: 'p2' })).filter((n) => !n.read).length, 2);
  await t.run('mark_notifications_read', 'u_p2', {});
  assert.equal((await listNotifications(t.db, { personId: 'p2' })).filter((n) => !n.read).length, 0);
  assert.ok((await t.view('u_s6')).unread > 0, 'garita has an unread role notice');
  await t.run('mark_notifications_read', 'u_s6', {});
  assert.equal((await t.view('u_s6')).unread, 0);
  await assert.rejects(t.run('reset_demo', 'u_s2', {}), /forbidden_role/);
  const { result, revision } = await t.run('reset_demo', 'u_s1', {});
  assert.ok(result.revision >= 1);
  assert.ok(revision > result.revision);
  const v = await t.view('u_p1');
  assert.equal(v.requests.length, 0);
  assert.equal(v.notifications.length, 0);
  assert.equal(v.students.length, 2);
  await t.close();
});

test('role notices are read per user: one recepcionista reading does not silence another (L10)', async () => {
  const t = await makeTestApp();
  /* A second recepción account, alongside the seeded Yadira (s2/u_s2) -- e.g. a garita con TV y
     móvil, o dos personas en recepción. */
  await insertRow(t.db, 'staff', { id: 's9', name: 'Marta Solís', role: 'recepcion', title: 'Recepción' });
  await insertRow(t.db, 'users', { id: 'u_s9', kind: 'staff', refId: 's9', name: 'Marta Solís', role: 'recepcion' });

  await t.run('create_excusa', 'u_p7', { studentId: 'e4', date: '2026-09-19', excusaType: 'ausencia', reason: 'Cita médica' });

  const before2 = await t.view('u_s2');
  const before9 = await t.view('u_s9');
  const notice = before2.notifications.find((n) => /^Nueva excusa: Emily Chen/.test(n.text));
  assert.ok(notice, 'Yadira sees the new role notice');
  assert.equal(notice.read, false);
  const notice9 = before9.notifications.find((n) => n.id === notice.id);
  assert.ok(notice9, 'Marta sees the same role notice');
  assert.equal(notice9.read, false);
  const unread9Before = before9.unread;
  assert.ok(unread9Before > 0);

  await t.run('mark_notifications_read', 'u_s2', {});

  const after2 = await t.view('u_s2');
  const after9 = await t.view('u_s9');
  assert.equal(after2.notifications.find((n) => n.id === notice.id).read, true, 'Yadira now sees it read');
  assert.equal(after9.notifications.find((n) => n.id === notice.id).read, false, 'Marta still sees it unread');
  assert.equal(after9.unread, unread9Before, "Marta's unread count is untouched");
  await t.close();
});
