import { register } from './index.js';
import { requireCap, requireTitular, STAFF_ROLES } from './guards.js';
import { addAuthorization, revokeAuthorization } from '../domain/authorizations.js';
import { getAuthorization, getAttachment } from '../db/repo.js';
import { deny, notFound, badRequest } from '../domain/errors.js';

const creatorOf = (ctx) => (ctx.person ? { personId: ctx.person.id, name: ctx.person.name } : { personId: null, name: ctx.staff.name });

register({
  add_authorization: {
    roles: ['parent', ...STAFF_ROLES],
    handler: async (ctx, input) => {
      const studentIds = [].concat(input.studentIds || []);
      if (!studentIds.length) badRequest('students_required');
      if (ctx.user.role === 'parent') for (const sid of studentIds) await requireTitular(ctx, sid);
      else requireCap(ctx, 'gestionar_autorizados');
      if (input.attachmentId) {
        const a = await getAttachment(ctx.q, input.attachmentId);
        if (!a) notFound('attachment_not_found');
        if (ctx.person && a.ownerPersonId && a.ownerPersonId !== ctx.person.id) deny('forbidden_attachment');
      }
      const mode = input.mode === 'cuenta' ? 'cuenta' : 'nueva';
      return addAuthorization(ctx, {
        studentIds, type: input.type, from: input.from, to: input.to, attachmentId: input.attachmentId || null, creator: creatorOf(ctx),
        personId: mode === 'cuenta' ? input.personId : null,
        newPerson: mode === 'nueva' ? { name: input.name, relation: input.relation, cedula: input.cedula, phone: input.phone } : null,
      });
    },
  },
  revoke_authorization: {
    roles: ['parent', ...STAFF_ROLES],
    handler: async (ctx, input) => {
      const a = await getAuthorization(ctx.q, input.authorizationId);
      if (!a) notFound('authorization_not_found');
      if (ctx.user.role === 'parent') await requireTitular(ctx, a.studentId);
      else requireCap(ctx, 'gestionar_autorizados');
      return revokeAuthorization(ctx, a.id, creatorOf(ctx));
    },
  },
});
