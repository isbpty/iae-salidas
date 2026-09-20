import { register } from './index.js';
import { insertAttachment } from '../db/repo.js';
import { uid } from '../domain/ids.js';
import { HttpError, badRequest } from '../domain/errors.js';

const PURPOSES = ['cedula', 'foto', 'certificado'];
/* Formats a browser renders inertly. SVG is deliberately absent: it is a document that can carry
   script, and these files are served back from our own origin. */
const MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'];
const MAX = 524288;

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
      const id = uid('att');
      await insertAttachment(ctx.q, { id, ownerPersonId: ctx.person ? ctx.person.id : null, purpose: input.purpose, mime, bytes, size: bytes.length, name: String(input.name || 'adjunto').slice(0, 120) });
      return { attachmentId: id };
    },
  },
});
