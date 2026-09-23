import { uid } from './ids.js';
import { insertNotification, insertAudit } from '../db/repo.js';

export const actorLabel = (ctx) => (ctx.staff && ctx.staff.name) || (ctx.person && ctx.person.name) || 'Sistema';

export async function notifyPerson(ctx, personId, text, opts = {}) {
  const p = await ctx.getPerson(personId);
  if (!p) return;
  await insertNotification(ctx.q, { id: uid('n'), personId, text, kind: opts.kind || 'info', buttons: opts.buttons || null }, ctx.now);
  if (p.phone) await ctx.transport.send(ctx, personId, { text, buttons: opts.buttons || null });
}
export async function notifyRole(ctx, role, text) {
  await insertNotification(ctx.q, { id: uid('n'), role, text, kind: 'school' }, ctx.now);
}
export async function notifyStaff(ctx, staffId, text) {
  await insertNotification(ctx.q, { id: uid('n'), staffId, text, kind: 'school' }, ctx.now);
}
export async function notifyTeachers(ctx, studentId, text) {
  const st = await ctx.getStudent(studentId);
  if (!st) return;
  for (const s of await ctx.staffList()) if (s.role === 'profesor' && (s.grades || []).includes(st.grade)) await notifyStaff(ctx, s.id, text);
}
export async function logEvent(ctx, text, actorName = 'Sistema') {
  await insertAudit(ctx.q, {
    at: ctx.now, actorUserId: ctx.user ? ctx.user.id : null, actorRole: ctx.user ? ctx.user.role : 'system', actorName,
    command: ctx.command || null, channel: ctx.channel || null, summary: text,
  });
}
