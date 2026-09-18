import { register } from './index.js';
import { insertAttachment } from '../db/repo.js';
import { uid } from '../domain/ids.js';
import { HttpError, badRequest } from '../domain/errors.js';

const PURPOSES = ['cedula', 'foto', 'certificado'];
const MAX = 524288;

register({
  upload_attachment: {
    roles: ['parent', 'recepcion', 'admin'],
    handler: async (ctx, input) => {
      if (!PURPOSES.includes(input.purpose)) badRequest('invalid_purpose');
      const mime = String(input.mime || '');
      if (!/^image\//.test(mime) && mime !== 'application/pdf') badRequest('invalid_mime');
      const bytes = Buffer.from(String(input.dataBase64 || ''), 'base64');
      if (!bytes.length) badRequest('empty_attachment');
      if (bytes.length > MAX) throw new HttpError(413, 'attachment_too_large', 'La imagen supera 512 KB. Reduce su tamaño e inténtalo de nuevo.');
      const id = uid('att');
      await insertAttachment(ctx.q, { id, ownerPersonId: ctx.person ? ctx.person.id : null, purpose: input.purpose, mime, bytes, size: bytes.length, name: String(input.name || 'adjunto').slice(0, 120) });
      return { attachmentId: id };
    },
  },
});
