import { register } from './index.js';
import { requireCap, requireTitular, STAFF_ROLES } from './guards.js';
import { addAuthorization, revokeAuthorization } from '../domain/authorizations.js';
import { getAuthorization, getAttachment, getPerson, listAuthorizations } from '../db/repo.js';
import { studentsOf } from '../domain/eligibility.js';
import { deny, notFound, badRequest } from '../domain/errors.js';

const creatorOf = (ctx) => (ctx.person
  ? { personId: ctx.person.id, name: ctx.person.name, isStaff: false }
  : { personId: null, name: ctx.staff.name, isStaff: true });

/* A parent may only point at a person they are already meant to see: an account holder from the
   directory the app shows them, or somebody already authorized for one of their own students.
   Anything else would turn `personId` into a lookup of another family's cédula and document. */
async function requireVisiblePerson(ctx, personId) {
  const p = await getPerson(ctx.q, personId);
  if (!p) notFound('person_not_found');
  if (p.hasAccount) return p;
  const mine = (await studentsOf(ctx, ctx.person.id)).map((s) => s.id);
  const auths = mine.length ? await listAuthorizations(ctx.q, { studentIds: mine, personId, includeRevoked: false }) : [];
  if (!auths.length) deny('forbidden_person');
  return p;
}

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
        if (ctx.person && a.ownerPersonId !== ctx.person.id) deny('forbidden_attachment');
      }
      const mode = input.mode === 'cuenta' ? 'cuenta' : 'nueva';
      if (mode === 'cuenta' && ctx.user.role === 'parent') await requireVisiblePerson(ctx, String(input.personId || ''));
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
