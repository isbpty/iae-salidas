import { register } from './index.js';
import { insertAttachment } from '../db/repo.js';
import { uid } from '../domain/ids.js';
import { HttpError, badRequest } from '../domain/errors.js';

const PURPOSES = ['cedula', 'foto', 'certificado'];
/* Formats a browser renders inertly. SVG is deliberately absent: it is a document that can carry
   script, and these files are served back from our own origin. */
const MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'];
const MAX = 524288;
/* S9: sin cuota, un padre podía llenar la base con blobs de 512 KB (nunca se borran solos si no
   terminan referenciados por una solicitud o una persona). 20/día por persona basta para el uso real
   (cédula, foto, un par de excusas) y deja margen de sobra. */
const DAILY_QUOTA = 20;

register({
  upload_attachment: {
    roles: ['parent', 'recepcion', 'admin'],
    handler: async (ctx, input) => {
      if (!PURPOSES.includes(input.purpose)) badRequest('invalid_purpose');
      const mime = String(input.mime || '');
      if (!MIMES.includes(mime)) badRequest('invalid_mime');
      const bytes = Buffer.from(String(input.dataBase64 || ''), 'base64');
      if (!bytes.length) badRequest('empty_attachment');
      if (bytes.length > MAX) throw new HttpError(413, 'attachment_too_large', 'La imagen supera 512 KB. Reduce su tamaño e inténtalo de nuevo.');
      const ownerPersonId = ctx.person ? ctx.person.id : null;
      if (ownerPersonId) {
        const since = new Date(ctx.now.getTime() - 86400000).toISOString();
        const r = await ctx.q.query('SELECT count(*)::int AS c FROM attachments WHERE owner_person_id=$1 AND created_at >= $2', [ownerPersonId, since]);
        if ((r[0] ? r[0].c : 0) >= DAILY_QUOTA) throw new HttpError(429, 'upload_quota', 'Alcanzaste el máximo de 20 subidas por día. Inténtalo de nuevo mañana.');
      }
      const id = uid('att');
      await insertAttachment(ctx.q, { id, ownerPersonId, purpose: input.purpose, mime, bytes, size: bytes.length, name: String(input.name || 'adjunto').slice(0, 120) });
      return { attachmentId: id };
    },
  },
});

/* S9: adjuntos huérfanos -- subidos pero nunca vinculados a una solicitud (`requests.attachment_id`)
   ni al documento de una persona (`persons.doc_attachment_id`) -- de más de 24 h. Se llama desde la
   purga existente de /super (server/routes/super.js), no desde un comando nuevo ni un cron aparte. */
export async function deleteOrphanAttachments(q, before) {
  const r = await q.query(
    `DELETE FROM attachments a WHERE a.created_at < $1
       AND NOT EXISTS (SELECT 1 FROM requests req WHERE req.attachment_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM persons p WHERE p.doc_attachment_id = a.id)
     RETURNING a.id`,
    [before.toISOString()],
  );
  return r.length;
}
