import { uid } from './ids.js';
import { badRequest, notFound } from './errors.js';
import { getStudent, getPerson, insertRow, patchRow, getAuthorization, getAttachment } from '../db/repo.js';
import { notifyPerson, notifyRole, logEvent } from './notifications.js';
import { AUTH_TYPES, firstName } from './text.js';

export async function addAuthorization(ctx, { studentIds, personId, newPerson, attachmentId, type, from, to, creator }) {
  if (!Array.isArray(studentIds) || !studentIds.length) badRequest('students_required');
  if (!AUTH_TYPES[type]) badRequest('invalid_type');
  if (type === 'temporal') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) badRequest('invalid_date_range');
    if (to < from) badRequest('invalid_date_range');
  }
  let att = null;
  if (attachmentId) { att = await getAttachment(ctx.q, attachmentId); if (!att) notFound('attachment_not_found'); }
  let pid = personId;
  if (!pid) {
    if (!newPerson || !String(newPerson.name || '').trim()) badRequest('name_required');
    if (!att) badRequest('document_required');
    pid = uid('p');
    await insertRow(ctx.q, 'persons', { id: pid, name: newPerson.name.trim(), relation: newPerson.relation || '', cedula: newPerson.cedula || '', phone: newPerson.phone || null, hasAccount: false, docName: att.name, docAttachmentId: att.id });
    await patchRow(ctx.q, 'attachments', att.id, { ownerPersonId: pid });
  } else {
    if (!(await getPerson(ctx.q, pid))) notFound('person_not_found');
    if (att) { await patchRow(ctx.q, 'persons', pid, { docName: att.name, docAttachmentId: att.id }); await patchRow(ctx.q, 'attachments', att.id, { ownerPersonId: pid }); }
  }
  const p = await getPerson(ctx.q, pid);
  const created = [];
  const names = [];
  for (const sid of studentIds) {
    const st = await getStudent(ctx.q, sid);
    if (!st) notFound('student_not_found');
    if (st.titulares.includes(pid)) continue; // ya es titular
    names.push(firstName(st.name));
    const a = { id: uid('a'), studentId: sid, personId: pid, type, createdBy: creator.personId || null, createdAt: ctx.now, validFrom: type === 'temporal' ? from : null, validTo: type === 'temporal' ? to : null };
    await insertRow(ctx.q, 'authorizations', a);
    created.push(await getAuthorization(ctx.q, a.id));
    await logEvent(ctx, 'Autorizó a ' + p.name + ' (' + p.relation + ') para retirar a ' + st.name + ' · ' + AUTH_TYPES[type], creator.name);
    for (const t of st.titulares.filter((x) => x !== creator.personId)) await notifyPerson(ctx, t, 'ℹ️ ' + creator.name + ' autorizó a ' + p.name + ' (' + p.relation + ') para retirar a ' + st.name + ' · ' + AUTH_TYPES[type] + '.');
    if (p.hasAccount) await notifyPerson(ctx, pid, '🔑 ' + creator.name + ' te autorizó para retirar a ' + st.name + ' (' + st.grade + ') · ' + AUTH_TYPES[type] + (type === 'temporal' ? ' del ' + from + ' al ' + to : '') + '. Lo verás en tu app.');
  }
  if (created.length) await notifyRole(ctx, 'recepcion', 'Nueva persona autorizada: ' + p.name + ' para ' + names.join(', ') + ' · ' + AUTH_TYPES[type]);
  return { personId: pid, authorizations: created };
}

export async function revokeAuthorization(ctx, id, actor) {
  const a = await getAuthorization(ctx.q, id);
  if (!a) notFound('authorization_not_found');
  await patchRow(ctx.q, 'authorizations', id, { revokedAt: ctx.now });
  const st = await getStudent(ctx.q, a.studentId);
  const p = await getPerson(ctx.q, a.personId);
  await logEvent(ctx, 'Revocó autorización de ' + p.name + ' para ' + st.name, actor.name);
  for (const t of st.titulares.filter((x) => x !== actor.personId)) await notifyPerson(ctx, t, 'ℹ️ Se revocó la autorización de ' + p.name + ' para retirar a ' + st.name + '.');
  return getAuthorization(ctx.q, id);
}
