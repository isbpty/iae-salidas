import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, loginAs, PNG_1x1 as png } from '../test-helpers.js';
import { deleteOrphanAttachments } from './attachments.js';

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');

test('upload validates purpose, mime and size and stores the owner', async () => {
  const t = await makeTestApp();
  const { result } = await t.run('upload_attachment', 'u_p1', { purpose: 'cedula', mime: 'image/png', name: 'ced.png', dataBase64: png });
  assert.match(result.attachmentId, /^att/);
  await assert.rejects(t.run('upload_attachment', 'u_p1', { purpose: 'meme', mime: 'image/png', name: 'x', dataBase64: png }), /invalid_purpose/);
  await assert.rejects(t.run('upload_attachment', 'u_p1', { purpose: 'foto', mime: 'text/html', name: 'x', dataBase64: png }), /invalid_mime/);
  /* SVG is a document that can carry script and these files come back from our own origin. */
  await assert.rejects(t.run('upload_attachment', 'u_p1', { purpose: 'foto', mime: 'image/svg+xml', name: 'x.svg', dataBase64: svg }), /invalid_mime/);
  const big = Buffer.alloc(524289).toString('base64');
  await assert.rejects(t.run('upload_attachment', 'u_p1', { purpose: 'foto', mime: 'image/png', name: 'x', dataBase64: big }), /attachment_too_large/);
  await assert.rejects(t.run('upload_attachment', 'u_s6', { purpose: 'foto', mime: 'image/png', name: 'x', dataBase64: png }), /forbidden_role/);
  await t.close();
});

test('attachment route enforces who may look at a document', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const p1 = await loginAs(base, 'u_p1'), p7 = await loginAs(base, 'u_p7'), gate = await loginAs(base, 'u_s6'), rec = await loginAs(base, 'u_s2');
  const get = (cookie, id) => fetch(`${base}/api/attachments/${id}`, { headers: { cookie } });
  assert.equal((await get(p1, 'att_p3')).status, 200, 'titular sees the grandmother authorized for his kids');
  assert.equal((await get(p1, 'att_p1')).status, 200, 'own document');
  assert.equal((await get(p7, 'att_p3')).status, 403, 'other family');
  assert.equal((await get(rec, 'att_p3')).status, 200);
  assert.equal((await get(gate, 'att_p3')).status, 403, 'no approved salida today for María');
  await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p3', reason: 'x' });
  const res = await get(gate, 'att_p3');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(res.headers.get('content-disposition'), 'inline; filename="foto_maria.jpg"');
  assert.match(await res.text(), /María Pérez/);
  assert.equal((await get(gate, 'missing')).status, 404);
  assert.equal((await fetch(`${base}/api/attachments/att_p3`)).status, 401);
  await close(); await t.close();
});

test('a parent loses the document once every authorization for their students is revoked', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const p1 = await loginAs(base, 'u_p1');
  const get = (cookie, id) => fetch(`${base}/api/attachments/${id}`, { headers: { cookie } });
  assert.equal((await get(p1, 'att_p3')).status, 200);
  /* María is authorized for both of Carlos' kids (a1 for Joseph, a2 for Sofía): while either
     stands he still sees her document. */
  await t.run('revoke_authorization', 'u_p2', { authorizationId: 'a1' });
  assert.equal((await get(p1, 'att_p3')).status, 200, 'a2 (Sofía) still stands');
  await t.run('revoke_authorization', 'u_p2', { authorizationId: 'a2' });
  assert.equal((await get(p1, 'att_p3')).status, 403, 'no authorization left');
  await close(); await t.close();
});

test('authorizing an account holder does not hand over their document', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const p7 = await loginAs(base, 'u_p7');
  const get = (cookie, id) => fetch(`${base}/api/attachments/${id}`, { headers: { cookie } });
  await t.run('add_authorization', 'u_p7', { studentIds: ['e4'], mode: 'cuenta', cedula: '8-701-123', type: 'siempre' });
  assert.equal((await get(p7, 'att_p1')).status, 403, 'Carlos has his own account: his cédula is not Wei\'s to open');
  assert.equal((await get(p7, 'att_p7')).status, 200, 'own document');
  await close(); await t.close();
});

/* S9: sin cuota, un padre podía llenar la base de blobs que nunca se borran solos. */
test('upload_attachment: cuota de 20 subidas por persona al día', async () => {
  const t = await makeTestApp();
  for (let i = 0; i < 20; i++) {
    const r = await t.run('upload_attachment', 'u_p1', { purpose: 'foto', mime: 'image/png', name: 'x' + i, dataBase64: png });
    assert.match(r.result.attachmentId, /^att/);
  }
  await assert.rejects(t.run('upload_attachment', 'u_p1', { purpose: 'foto', mime: 'image/png', name: 'x20', dataBase64: png }), /upload_quota/);
  /* Otra persona empieza su propio cupo; el personal (sin `ctx.person`) no lo comparte con nadie. */
  const other = await t.run('upload_attachment', 'u_p2', { purpose: 'foto', mime: 'image/png', name: 'y', dataBase64: png });
  assert.match(other.result.attachmentId, /^att/);
  const staffUpload = await t.run('upload_attachment', 'u_s2', { purpose: 'foto', mime: 'image/png', name: 'z', dataBase64: png });
  assert.match(staffUpload.result.attachmentId, /^att/);
  await t.close();
});

/* S9: adjuntos huérfanos (nunca vinculados a una solicitud ni al documento de una persona) de más de
   24 h se borran en la purga de /super; los referenciados o recientes sobreviven. */
test('deleteOrphanAttachments: borra solo lo viejo y sin referencia', async () => {
  const t = await makeTestApp();
  const fresh = await t.run('upload_attachment', 'u_p1', { purpose: 'certificado', mime: 'image/png', name: 'reciente', dataBase64: png });
  const old = await t.run('upload_attachment', 'u_p1', { purpose: 'certificado', mime: 'image/png', name: 'huerfano', dataBase64: png });
  const oldLinked = await t.run('upload_attachment', 'u_p1', { purpose: 'certificado', mime: 'image/png', name: 'viejo-pero-usado', dataBase64: png });
  await t.run('create_excusa', 'u_p1', { studentId: 'e1', date: '2026-09-18', excusaType: 'ausencia', reason: 'gripe', attachmentId: oldLinked.result.attachmentId, attachmentName: 'x' });
  /* Envejece "old" y "oldLinked" más de 24 h; "fresh" queda subido hace un instante. */
  await t.db.query('UPDATE attachments SET created_at = $1 WHERE id = ANY($2)', [new Date(t.clock.now.getTime() - 25 * 3600000).toISOString(), [old.result.attachmentId, oldLinked.result.attachmentId]]);
  const deleted = await deleteOrphanAttachments(t.db, new Date(t.clock.now.getTime() - 24 * 3600000));
  assert.equal(deleted, 1);
  const remaining = await t.db.query('SELECT id FROM attachments WHERE id = ANY($1)', [[fresh.result.attachmentId, old.result.attachmentId, oldLinked.result.attachmentId]]);
  const ids = remaining.map((r) => r.id);
  assert.ok(ids.includes(fresh.result.attachmentId), 'fresh: menos de 24h, sobrevive');
  assert.ok(!ids.includes(old.result.attachmentId), 'old: huérfano y viejo, se borra');
  assert.ok(ids.includes(oldLinked.result.attachmentId), 'oldLinked: viejo pero referenciado por una excusa, sobrevive');
  await t.close();
});
