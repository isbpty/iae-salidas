import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, PNG_1x1 as png } from '../test-helpers.js';
import { listNotifications, listAuthorizations, getPerson, getAuthorization } from '../db/repo.js';

const texts = async (db, target) => (await listNotifications(db, target)).map((n) => n.text);

test('a titular registers a new person with a document for two kids', async () => {
  const t = await makeTestApp();
  const { result: up } = await t.run('upload_attachment', 'u_p1', { purpose: 'foto', mime: 'image/png', name: 'nana.png', dataBase64: png });
  const { result } = await t.run('add_authorization', 'u_p1', { studentIds: ['e1', 'e2'], mode: 'nueva', name: 'Rosa Nana', relation: 'Niñera', cedula: '8-1-1', phone: '+507 6000-1000', attachmentId: up.attachmentId, type: 'temporal', from: '2026-09-18', to: '2026-09-30' });
  assert.equal(result.authorizations.length, 2);
  const p = await getPerson(t.db, result.personId);
  assert.equal(p.name, 'Rosa Nana');
  assert.equal(p.hasAccount, false);
  assert.equal(p.docAttachmentId, up.attachmentId);
  assert.equal(result.authorizations[0].validTo, '2026-09-30');
  assert.match((await texts(t.db, { personId: 'p2' })).at(-1), /^ℹ️ Carlos Rodríguez autorizó a Rosa Nana \(Niñera\) para retirar a Sofía Rodríguez · Por tiempo\.$/);
  assert.match((await texts(t.db, { role: 'recepcion' })).at(-1), /^Nueva persona autorizada: Rosa Nana para Joseph, Sofía · Por tiempo$/);
  await t.close();
});

test('validation: document required for new persons, dates, ownership, titular skipped', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('add_authorization', 'u_p1', { studentIds: ['e1'], mode: 'nueva', name: 'X', relation: 'Tío', cedula: '1', type: 'siempre' }), /document_required/);
  await assert.rejects(t.run('add_authorization', 'u_p1', { studentIds: ['e1'], mode: 'cuenta', personId: 'p5', type: 'temporal', from: '2026-09-20', to: '2026-09-10' }), /invalid_date_range/);
  await assert.rejects(t.run('add_authorization', 'u_p1', { studentIds: ['e3'], mode: 'cuenta', personId: 'p5', type: 'siempre' }), /forbidden_not_titular/);
  await assert.rejects(t.run('add_authorization', 'u_p1', { studentIds: [], mode: 'cuenta', personId: 'p5', type: 'siempre' }), /students_required/);
  await assert.rejects(t.run('add_authorization', 'u_p1', { studentIds: ['e1'], mode: 'cuenta', personId: 'p5', type: 'mensual' }), /invalid_type/);
  const { result } = await t.run('add_authorization', 'u_p1', { studentIds: ['e1'], mode: 'cuenta', personId: 'p2', type: 'siempre' });
  assert.equal(result.authorizations.length, 0, 'Ana is already a titular of Joseph');
  const recepcionLast = (await texts(t.db, { role: 'recepcion' })).at(-1);
  assert.ok(!recepcionLast || !recepcionLast.startsWith('Nueva persona autorizada: Ana Pérez'), 'no recepcion notice when nothing was created');
  const { result: acct } = await t.run('add_authorization', 'u_p1', { studentIds: ['e2'], mode: 'cuenta', personId: 'p5', type: 'una_vez' });
  assert.equal(acct.authorizations[0].type, 'una_vez');
  assert.match((await texts(t.db, { personId: 'p5' })).at(-1), /^🔑 Carlos Rodríguez te autorizó para retirar a Sofía Rodríguez \(Kínder\) · Una vez \(con confirmación\)\. Lo verás en tu app\.$/);
  await t.close();
});

test('a parent may not attach a document they do not own', async () => {
  const t = await makeTestApp();
  const { result: up } = await t.run('upload_attachment', 'u_s2', { purpose: 'cedula', mime: 'image/png', name: 'c.png', dataBase64: png });
  await assert.rejects(t.run('add_authorization', 'u_p1', { studentIds: ['e1'], mode: 'nueva', name: 'Intruso', relation: 'Amigo', cedula: '9-9-9', attachmentId: up.attachmentId, type: 'siempre' }), /forbidden_attachment/);
  await assert.rejects(t.run('add_authorization', 'u_p1', { studentIds: ['e1'], mode: 'nueva', name: 'Intruso', relation: 'Amigo', cedula: '9-9-9', attachmentId: 'att_missing', type: 'siempre' }), /attachment_not_found/);
  await t.close();
});

test('reception may register and revoke; parents revoke only their family', async () => {
  const t = await makeTestApp();
  const { result: up } = await t.run('upload_attachment', 'u_s2', { purpose: 'cedula', mime: 'image/png', name: 'c.png', dataBase64: png });
  const { result } = await t.run('add_authorization', 'u_s2', { studentIds: ['e3'], mode: 'nueva', name: 'Tío Beto', relation: 'Tío', cedula: '2-2-2', attachmentId: up.attachmentId, type: 'siempre' });
  assert.equal(result.authorizations.length, 1);
  assert.match((await texts(t.db, { personId: 'p5' })).at(-1), /^ℹ️ Yadira Batista autorizó a Tío Beto/);
  await assert.rejects(t.run('revoke_authorization', 'u_p1', { authorizationId: result.authorizations[0].id }), /forbidden_not_titular/);
  await assert.rejects(t.run('revoke_authorization', 'u_s3', { authorizationId: 'a1' }), /forbidden_capability:gestionar_autorizados/);
  await t.run('revoke_authorization', 'u_s2', { authorizationId: result.authorizations[0].id });
  assert.ok((await getAuthorization(t.db, result.authorizations[0].id)).revokedAt);
  await t.run('revoke_authorization', 'u_p2', { authorizationId: 'a1' });
  assert.ok((await getAuthorization(t.db, 'a1')).revokedAt);
  assert.match((await texts(t.db, { personId: 'p1' })).at(-1), /^ℹ️ Se revocó la autorización de María Pérez para retirar a Joseph Rodríguez\.$/);
  assert.equal((await listAuthorizations(t.db, { studentIds: ['e1'], includeRevoked: false })).some((a) => a.id === 'a1'), false);
  await t.close();
});

test('a parent may only name people they are already meant to see', async () => {
  const t = await makeTestApp();
  /* María has no account and is authorized only for Carlos' kids: to Wei she is a stranger,
     and `personId` must not work as a lookup of her cédula and document. */
  await assert.rejects(t.run('add_authorization', 'u_p7', { studentIds: ['e4'], mode: 'cuenta', personId: 'p3', type: 'siempre' }), /forbidden_person/);
  await assert.rejects(t.run('add_authorization', 'u_p7', { studentIds: ['e4'], mode: 'cuenta', personId: 'p_nope', type: 'siempre' }), /person_not_found/);
  const { result } = await t.run('add_authorization', 'u_p7', { studentIds: ['e4'], mode: 'cuenta', personId: 'p1', type: 'siempre' });
  assert.equal(result.authorizations.length, 1, 'an account holder from the directory is fair game');
  /* And the other branch: somebody without an account who is already authorized for one of my
     own students, even after the authorization for this particular child was revoked. */
  await t.run('revoke_authorization', 'u_p1', { authorizationId: 'a2' });
  const { result: again } = await t.run('add_authorization', 'u_p1', { studentIds: ['e2'], mode: 'cuenta', personId: 'p3', type: 'siempre' });
  assert.equal(again.authorizations.length, 1);
  await t.close();
});

test('a parent never rewrites the document of a person who already exists', async () => {
  const t = await makeTestApp();
  const before = await getPerson(t.db, 'p3');
  const { result: up } = await t.run('upload_attachment', 'u_p1', { purpose: 'cedula', mime: 'image/png', name: 'suplantada.png', dataBase64: png });
  await t.run('revoke_authorization', 'u_p1', { authorizationId: 'a2' });
  const { result } = await t.run('add_authorization', 'u_p1', { studentIds: ['e2'], mode: 'cuenta', personId: 'p3', attachmentId: up.attachmentId, type: 'siempre' });
  assert.equal(result.authorizations.length, 1, 'the attachment is ignored, not an error');
  const after = await getPerson(t.db, 'p3');
  assert.equal(after.docAttachmentId, before.docAttachmentId);
  assert.equal(after.docName, before.docName);
  /* Reception still may: correcting a stale cédula is part of the job. */
  const { result: staffUp } = await t.run('upload_attachment', 'u_s2', { purpose: 'cedula', mime: 'image/png', name: 'maria_nueva.png', dataBase64: png });
  await t.run('add_authorization', 'u_s2', { studentIds: ['e3'], mode: 'cuenta', personId: 'p3', attachmentId: staffUp.attachmentId, type: 'siempre' });
  const staffed = await getPerson(t.db, 'p3');
  assert.equal(staffed.docAttachmentId, staffUp.attachmentId);
  assert.equal(staffed.docName, 'maria_nueva.png');
  await t.close();
});

test('lookup_person finds an account holder by exact cédula or phone, and nothing else', async () => {
  const t = await makeTestApp();
  const byCedula = (await t.run('lookup_person', 'u_p1', { cedula: ' 8-703-789 ' })).result;
  assert.deepEqual(byCedula, { id: 'p5', name: 'Laura Gómez', relation: 'Mamá' }, 'only id, name and relation');
  assert.deepEqual((await t.run('lookup_person', 'u_p1', { phone: '+507 6333-3333' })).result, byCedula);
  assert.deepEqual((await t.run('lookup_person', 'u_p1', { phone: '6333 3333' })).result, byCedula, 'the local number without the country code is the same phone');
  assert.deepEqual((await t.run('lookup_person', 'u_p1', { cedula: 'e-8-12345' })).result.id, 'p7');
  await assert.rejects(t.run('lookup_person', 'u_p1', { cedula: '8-703' }), /person_not_found/, 'no partial matches');
  await assert.rejects(t.run('lookup_person', 'u_p1', { phone: '6333' }), /person_not_found/);
  await assert.rejects(t.run('lookup_person', 'u_p1', { cedula: '8-200-111' }), /person_not_found/, 'a person without an account is not in the lookup');
  await assert.rejects(t.run('lookup_person', 'u_p1', {}), /lookup_required/);
  await assert.rejects(t.run('lookup_person', 'u_s2', { cedula: '8-703-789' }), /forbidden_role/);
  const err = await t.run('lookup_person', 'u_p1', { cedula: 'nadie' }).catch((e) => e);
  assert.equal(err.status, 404);
  /* the found id is what add_authorization (mode cuenta) takes */
  const { result } = await t.run('add_authorization', 'u_p1', { studentIds: ['e1'], mode: 'cuenta', personId: byCedula.id, type: 'siempre' });
  assert.equal(result.authorizations[0].personId, 'p5');
  await t.close();
});
