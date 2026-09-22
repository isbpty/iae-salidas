import { getStudent, getPerson, listAuthorizations, studentsOfPerson } from '../db/repo.js';
import { todayISO, shiftISO } from './time.js';

export const todayOf = (ctx) => todayISO(ctx.now, ctx.tz);

/* Fallback zone for callers that check an authorization outside a request context (none today,
   kept only so `isAuthActive` never needs a ctx to answer the simple type/window/use questions). */
const DEFAULT_TZ = 'America/Panama';

/* A una_vez authorization with no explicit valid_to defaults to 7 days after it was granted, so an
   old, never-used one-time authorization doesn't stay eligible forever. This must be computed in
   the school's timezone (never the browser's) -- see `withAuthExpiry` below, which hands the
   client this same value pre-computed so it never has to redo date math in its own local zone. */
export function unaVezDefaultExpiry(a, tz = DEFAULT_TZ) {
  return a.createdAt ? shiftISO(new Date(a.createdAt), tz, 7) : null;
}

/* `today` is always the date of the salida being checked (the caller's `date` param), not
   necessarily the calendar day the check runs on -- that's what lets a temporal or una_vez
   authorization be evaluated correctly for a future or past salida instead of always "now". */
export function isAuthActive(a, today, tz = DEFAULT_TZ) {
  if (a.revokedAt) return false;
  if (a.type === 'siempre') return true;
  if (a.type === 'temporal') return a.validFrom <= today && today <= a.validTo;
  if (a.type === 'una_vez') {
    if (a.usedAt) return false;
    const validTo = a.validTo || unaVezDefaultExpiry(a, tz);
    return !validTo || today <= validTo;
  }
  return false;
}

/* Attaches the resolved una_vez expiry (explicit valid_to, or the 7-day default) as `expiresOn`
   so the client's isAuthActive never has to compute a "createdAt + 7 days" date itself -- doing
   that client-side with the browser's local timezone/clock disagrees with the server around the
   cutoff day (a real bug: 2026-09-24 vs 2026-09-25 under a timezone ahead of school time). */
export function withAuthExpiry(authorizations, ctx) {
  return authorizations.map((a) => (a.type === 'una_vez' ? { ...a, expiresOn: a.validTo || unaVezDefaultExpiry(a, ctx.tz) } : a));
}

export async function pickupEligibility(ctx, studentId, personId, date = todayOf(ctx)) {
  const st = await getStudent(ctx.q, studentId);
  if (!st || !personId) return { ok: false };
  if (st.titulares.includes(personId)) return { ok: true, kind: 'titular' };
  const a = (await listAuthorizations(ctx.q, { studentIds: [studentId], personId })).find((x) => isAuthActive(x, date, ctx.tz));
  return a ? { ok: true, kind: a.type, auth: a } : { ok: false };
}
export async function pickupCandidates(ctx, studentId, date = todayOf(ctx)) {
  const st = await getStudent(ctx.q, studentId);
  if (!st) return [];
  const list = [];
  for (const id of st.titulares) list.push({ person: await getPerson(ctx.q, id), kind: 'titular' });
  for (const a of await listAuthorizations(ctx.q, { studentIds: [studentId], includeRevoked: false })) {
    if (isAuthActive(a, date, ctx.tz)) list.push({ person: await getPerson(ctx.q, a.personId), kind: a.type, auth: a });
  }
  return list;
}
export async function authorizedFor(ctx, personId) {
  const today = todayOf(ctx);
  const out = [];
  for (const a of await listAuthorizations(ctx.q, { personId, includeRevoked: false })) {
    if (!isAuthActive(a, today, ctx.tz)) continue;
    const st = await getStudent(ctx.q, a.studentId);
    if (st && !st.titulares.includes(personId)) out.push({ auth: a, student: st });
  }
  return out;
}
export const studentsOf = (ctx, personId) => studentsOfPerson(ctx.q, personId);
