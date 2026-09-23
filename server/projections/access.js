import { getSettings, getStaff, existsExcusaForTeacher } from '../db/repo.js';
import { todayISO } from '../domain/time.js';

/* S9: antes se permitía por dueño ("el dueño del adjunto es cotitular/retira hoy"), lo que abría de más --
   un cotitular compartido con un hijo propio podía abrir cualquier otro adjunto suyo, y garita cualquier
   adjunto cuyo dueño retirase hoy (incluidos certificados médicos). Ahora se comprueba por entidad: garita
   solo la cédula/foto que es el documento de identidad de quien retira hoy; los padres solo la excusa de
   su propio hijo o el documento de alguien que ellos mismos autorizaron. Consultas EXISTS de una sola
   ida (mismo estilo que `existsApprovedPickupToday`/`existsExcusaForTeacher`), sin tocar repo.js. */
export async function canSeeAttachment(q, user, att, env) {
  if (user.role === 'admin' || user.role === 'recepcion') return true;
  if (user.kind === 'person') {
    if (att.ownerPersonId === user.refId) return true;
    const excusa = await q.query(
      `SELECT 1 FROM requests req JOIN guardianships g ON g.student_id = req.student_id
       WHERE req.kind='excusa' AND req.attachment_id=$1 AND g.person_id=$2 LIMIT 1`,
      [att.id, user.refId],
    );
    if (excusa.length > 0) return true;
    /* The document (cédula/foto) of someone the parent authorized for their own child, while that
       authorization stands, and only for people with no account of their own: another account
       holder's document is never theirs to open just because they once authorized them. */
    const authDoc = await q.query(
      `SELECT 1 FROM persons p
       JOIN authorizations a ON a.person_id = p.id AND a.revoked_at IS NULL
       JOIN guardianships g ON g.student_id = a.student_id
       WHERE p.doc_attachment_id = $1 AND NOT p.has_account AND g.person_id = $2 LIMIT 1`,
      [att.id, user.refId],
    );
    return authDoc.length > 0;
  }
  const settings = await getSettings(q);
  const today = todayISO(env.now, settings.timezone || 'America/Panama');
  if (user.role === 'garita') {
    if (!['cedula', 'foto'].includes(att.purpose)) return false;
    const r = await q.query(
      `SELECT 1 FROM persons p WHERE p.doc_attachment_id = $1
       AND EXISTS (SELECT 1 FROM requests req WHERE req.date=$2 AND req.kind='salida' AND req.status IN ('aprobada','retirado') AND req.pickup_by = p.id)
       LIMIT 1`,
      [att.id, today],
    );
    return r.length > 0;
  }
  if (user.role === 'profesor') {
    const staff = await getStaff(q, user.refId);
    return existsExcusaForTeacher(q, att.id, staff.grades || []);
  }
  return false;
}
