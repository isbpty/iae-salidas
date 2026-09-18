import { getStudent, getPerson, listAuthorizations, studentsOfPerson } from '../db/repo.js';
import { todayISO } from './time.js';

export const todayOf = (ctx) => todayISO(ctx.now, ctx.tz);

export function isAuthActive(a, today) {
  if (a.revokedAt) return false;
  if (a.type === 'siempre') return true;
  if (a.type === 'temporal') return a.validFrom <= today && today <= a.validTo;
  if (a.type === 'una_vez') return !a.usedAt;
  return false;
}
export async function pickupEligibility(ctx, studentId, personId) {
  const st = await getStudent(ctx.q, studentId);
  if (!st || !personId) return { ok: false };
  if (st.titulares.includes(personId)) return { ok: true, kind: 'titular' };
  const today = todayOf(ctx);
  const a = (await listAuthorizations(ctx.q, { studentIds: [studentId], personId })).find((x) => isAuthActive(x, today));
  return a ? { ok: true, kind: a.type, auth: a } : { ok: false };
}
export async function pickupCandidates(ctx, studentId) {
  const st = await getStudent(ctx.q, studentId);
  if (!st) return [];
  const today = todayOf(ctx);
  const list = [];
  for (const id of st.titulares) list.push({ person: await getPerson(ctx.q, id), kind: 'titular' });
  for (const a of await listAuthorizations(ctx.q, { studentIds: [studentId], includeRevoked: false })) {
    if (isAuthActive(a, today)) list.push({ person: await getPerson(ctx.q, a.personId), kind: a.type, auth: a });
  }
  return list;
}
export async function authorizedFor(ctx, personId) {
  const today = todayOf(ctx);
  const out = [];
  for (const a of await listAuthorizations(ctx.q, { personId, includeRevoked: false })) {
    if (!isAuthActive(a, today)) continue;
    const st = await getStudent(ctx.q, a.studentId);
    if (st && !st.titulares.includes(personId)) out.push({ auth: a, student: st });
  }
  return out;
}
export const studentsOf = (ctx, personId) => studentsOfPerson(ctx.q, personId);
