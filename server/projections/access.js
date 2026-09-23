import { studentsOfPerson, listAuthorizations, getSettings, getStaff, getPerson, existsApprovedPickupToday, existsExcusaForTeacher } from '../db/repo.js';
import { todayISO } from '../domain/time.js';

/* Who may open a stored document (cédula/foto of a pickup person or an excuse certificate). */
export async function canSeeAttachment(q, user, att, env) {
  if (user.role === 'admin' || user.role === 'recepcion') return true;
  if (user.kind === 'person') {
    if (att.ownerPersonId === user.refId) return true;
    const own = await studentsOfPerson(q, user.refId);
    if (own.some((s) => s.titulares.includes(att.ownerPersonId))) return true;
    /* A parent sees the document of somebody authorized for their own student only while that
       authorization stands, and only for people who have no account of their own: another
       account holder's cédula is never theirs to open. */
    const owner = await getPerson(q, att.ownerPersonId);
    if (!owner || owner.hasAccount) return false;
    const auths = await listAuthorizations(q, { studentIds: own.map((s) => s.id), personId: att.ownerPersonId, includeRevoked: false });
    return auths.length > 0;
  }
  const settings = await getSettings(q);
  const today = todayISO(env.now, settings.timezone || 'America/Panama');
  if (user.role === 'garita') {
    return existsApprovedPickupToday(q, today, att.ownerPersonId);
  }
  if (user.role === 'profesor') {
    const staff = await getStaff(q, user.refId);
    return existsExcusaForTeacher(q, att.id, staff.grades || []);
  }
  return false;
}
