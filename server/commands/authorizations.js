import { register } from './index.js';
import { requireCap, requireTitular, STAFF_ROLES } from './guards.js';
import { addAuthorization, revokeAuthorization } from '../domain/authorizations.js';
import { getAuthorization, getAttachment, listAuthorizations } from '../db/repo.js';
import { studentsOf } from '../domain/eligibility.js';
import { deny, notFound, badRequest } from '../domain/errors.js';

const creatorOf = (ctx) => (ctx.person
  ? { personId: ctx.person.id, name: ctx.person.name, isStaff: false }
  : { personId: null, name: ctx.staff.name, isStaff: true });

/* Phones compare by their digits, with or without Panama's country code (507). */
const phoneDigits = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length > 8 && d.startsWith('507') ? d.slice(3) : d; };

/* A parent names an existing person by their full cédula or phone, never by id (ids are sequential and would
   walk the whole directory). An exact match counts only if the parent is meant to see that person: somebody
   with an account, or (`known`, add_authorization only) somebody already authorized (not revoked) for one of
   the parent's own students. Anything else is 404, the same answer as "nobody has that cédula". Shared by
   lookup_person and add_authorization (mode `cuenta`); both spend the `lookup:<userId>` budget (`limit` below). */
async function findPersonForParent(ctx, input, { known = false } = {}) {
  const cedula = String(input.cedula || '').trim().toLowerCase();
  const phone = phoneDigits(input.phone);
  if (!cedula && !phone) badRequest('lookup_required');
  const rows = await ctx.q.query(
    `SELECT id, name, relation, has_account FROM persons
      WHERE id <> $1
        AND (($2 <> '' AND lower(trim(cedula)) = $2)
          OR ($3 <> '' AND (regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') IN ($3, '507' || $3))))
      ORDER BY has_account DESC, id`, [ctx.person.id, cedula, phone]);
  const mine = known && rows.some((r) => !r.has_account) ? (await studentsOf(ctx, ctx.person.id)).map((s) => s.id) : [];
  for (const r of rows) {
    if (r.has_account) return r;
    if (mine.length && (await listAuthorizations(ctx.q, { studentIds: mine, personId: r.id, includeRevoked: false })).length) return r;
  }
  return notFound('person_not_found');
}
const LOOKUP_LIMIT = { key: 'lookup', max: 20 };
/* The raw cédula/phone typed to find somebody stays out of the audit log. */
const hideLookup = (input) => ({ ...input, ...(input.cedula ? { cedula: '***' } : {}), ...(input.phone ? { phone: '***' } : {}) });

register({
  /* A parent authorizing somebody who already has an account names them by their full cédula or phone:
     an exact match returns only id, name and relation; anything else is 404. There is no directory. */
  lookup_person: {
    roles: ['parent'],
    limit: LOOKUP_LIMIT,
    auditInput: hideLookup,
    handler: async (ctx, input) => {
      const p = await findPersonForParent(ctx, input);
      return { id: p.id, name: p.name, relation: p.relation };
    },
  },
  add_authorization: {
    roles: ['parent', ...STAFF_ROLES],
    /* Only the `cuenta` mode looks somebody up (a parent's cédula/phone); `nueva` creates a person. */
    limit: { ...LOOKUP_LIMIT, when: (input) => input.mode === 'cuenta' && !!(input.cedula || input.phone) },
    auditInput: (input) => (input.mode === 'cuenta' ? hideLookup(input) : input),
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
      /* Parents: the person comes from their cédula/phone; a `personId` sent by the client is ignored. Staff keep ids. */
      let personId = null;
      if (mode === 'cuenta') personId = ctx.user.role === 'parent' ? (await findPersonForParent(ctx, input, { known: true })).id : input.personId;
      return addAuthorization(ctx, {
        studentIds, type: input.type, from: input.from, to: input.to, attachmentId: input.attachmentId || null, creator: creatorOf(ctx),
        personId,
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
