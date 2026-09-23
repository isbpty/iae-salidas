/* R1: los comandos de solo lectura no invalidan la vista de todos (bump: false). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, PNG_1x1 as png } from '../test-helpers.js';

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

/* S10: `add_authorization` en modo 'nueva' manda la cédula y el teléfono de la persona nueva en el input;
   `runCommand` ahora reutiliza `maskInput` (el mismo enmascarado de la telemetría) en vez del `sanitize`
   que solo truncaba strings largos. */
test('runCommand enmascara cédula/teléfono en audit_log.input (maskInput, no solo truncar)', async () => {
  const t = await makeTestApp();
  const { result: up } = await t.run('upload_attachment', 'u_p1', { purpose: 'foto', mime: 'image/png', name: 'nana.png', dataBase64: png });
  await t.run('add_authorization', 'u_p1', {
    studentIds: ['e1'], mode: 'nueva', name: 'Rosa Nana', relation: 'Niñera', cedula: '8-1-1', phone: '+507 6000-1000',
    attachmentId: up.attachmentId, type: 'siempre',
  });
  const [row] = await t.db.query("SELECT input FROM audit_log WHERE command = 'add_authorization' ORDER BY id DESC LIMIT 1");
  assert.equal(row.input.cedula, '***'); assert.equal(row.input.phone, '***');
  assert.equal(row.input.name, 'Rosa Nana', 'lo que no es secreto sigue legible');
  await t.close();
});

/* R7: "marcar leído" es, con mucho, el comando más frecuente (L10); no deja fila en audit_log. */
test('mark_notifications_read no deja fila en audit_log', async () => {
  const t = await makeTestApp();
  await t.run('mark_notifications_read', 'u_p1', {});
  const rows = await t.db.query("SELECT id FROM audit_log WHERE command = 'mark_notifications_read'");
  assert.equal(rows.length, 0);
  await t.close();
});
