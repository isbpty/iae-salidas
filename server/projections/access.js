import { studentsOfPerson, listAuthorizations, listRequests, getSettings, getStaff, getStudent } from '../db/repo.js';
import { todayISO } from '../domain/time.js';

/* Who may open a stored document (cédula/foto of a pickup person or an excuse certificate). */
export async function canSeeAttachment(q, user, att, env) {
  if (user.role === 'admin' || user.role === 'recepcion') return true;
  if (user.kind === 'person') {
    if (att.ownerPersonId === user.refId) return true;
    const own = await studentsOfPerson(q, user.refId);
    if (own.some((s) => s.titulares.includes(att.ownerPersonId))) return true;
    const auths = await listAuthorizations(q, { studentIds: own.map((s) => s.id), personId: att.ownerPersonId });
    return auths.length > 0;
  }
  const settings = await getSettings(q);
  const today = todayISO(env.now, settings.timezone || 'America/Panama');
  if (user.role === 'garita') {
    const reqs = await listRequests(q, { date: today, kind: 'salida' });
    return reqs.some((r) => ['aprobada', 'retirado'].includes(r.status) && r.pickupBy === att.ownerPersonId);
  }
  if (user.role === 'profesor') {
    const staff = await getStaff(q, user.refId);
    const excuses = (await listRequests(q, { kind: 'excusa' })).filter((r) => r.attachmentId === att.id);
    for (const r of excuses) { const st = await getStudent(q, r.studentId); if (st && (staff.grades || []).includes(st.grade)) return true; }
  }
  return false;
}
