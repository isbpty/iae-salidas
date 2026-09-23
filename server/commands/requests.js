import { register } from './index.js';
import { requireCap, requireTitular, STAFF_ROLES } from './guards.js';
import { createRequest, approveRequest, rejectRequest, acceptExcusa, cancelRequest, staffCancelRequest, withExpired } from '../domain/requests.js';
import { todayOf } from '../domain/eligibility.js';
import { isValidDate } from '../domain/time.js';
import { getRequest, getAttachment, listStudents, searchRequests } from '../db/repo.js';
import { deny, notFound, badRequest, conflict } from '../domain/errors.js';

const REQUEST_STATUSES = ['pendiente', 'aprobada', 'rechazada', 'retirado', 'cancelada', 'aceptada'];
const can = (ctx, cap) => ctx.user.role === 'admin' || !!(ctx.permissions[ctx.user.role] || {})[cap];

async function ownRequest(ctx, requestId) {
  const r = await getRequest(ctx.q, requestId);
  if (!r) notFound('request_not_found');
  await requireTitular(ctx, r.studentId);
  return r;
}

register({
  create_salida: {
    roles: ['parent'],
    handler: async (ctx, input) => {
      await requireTitular(ctx, input.studentId);
      return createRequest(ctx, { kind: 'salida', channel: 'web', requestedBy: ctx.person.id, studentId: input.studentId, date: input.date, time: input.time, pickupBy: input.pickupBy || ctx.person.id, reason: input.reason });
    },
  },
  create_excusa: {
    roles: ['parent'],
    handler: async (ctx, input) => {
      await requireTitular(ctx, input.studentId);
      if (input.attachmentId) {
        const a = await getAttachment(ctx.q, input.attachmentId);
        if (!a || a.ownerPersonId !== ctx.person.id) deny('forbidden_attachment');
      }
      return createRequest(ctx, { kind: 'excusa', channel: 'web', requestedBy: ctx.person.id, studentId: input.studentId, date: input.date, excusaType: input.excusaType, reason: input.reason, attachmentId: input.attachmentId || null, attachmentName: input.attachmentName || null });
    },
  },
  cancel_request: {
    roles: ['parent'],
    handler: async (ctx, input) => {
      const r = await ownRequest(ctx, input.requestId);
      if (!['pendiente', 'aprobada'].includes(r.status)) conflict('request_not_cancellable');
      return cancelRequest(ctx, r.id, ctx.person.id);
    },
  },
  approve_request: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => {
      requireCap(ctx, 'aprobar');
      const points = ctx.settings.school.pickupPoints || [];
      const pickupPoint = points.includes(input.pickupPoint) ? input.pickupPoint : ctx.settings.defaultPickupPoint;
      return approveRequest(ctx, input.requestId, { by: ctx.staff.id, pickupPoint });
    },
  },
  reject_request: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => {
      const r = await getRequest(ctx.q, input.requestId);
      if (!r) notFound('request_not_found');
      requireCap(ctx, r.kind === 'salida' ? 'aprobar' : 'decidir_excusas');
      const reason = String(input.reason || '').trim();
      if (!reason) badRequest('reason_required');
      return rejectRequest(ctx, r.id, reason, ctx.staff.id);
    },
  },
  accept_excusa: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => {
      requireCap(ctx, 'decidir_excusas');
      return acceptExcusa(ctx, input.requestId, ctx.staff.id);
    },
  },
  staff_cancel_request: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => {
      requireCap(ctx, 'aprobar');
      const r = await getRequest(ctx.q, input.requestId);
      if (!r) notFound('request_not_found');
      const reason = String(input.reason || '').trim();
      if (!reason) badRequest('reason_required');
      return staffCancelRequest(ctx, r.id, reason, ctx.staff.id);
    },
  },
  /* R3: the staff views only carry "hoy + pendientes + últimos 14 días" -- this is how the search
     box in Salidas reaches further back, on demand, instead of every view paying to load the whole
     history. Read-only (`bump: false`), capped at 200 rows, scoped to the same students the caller
     can already see (same rule as `staffView`). */
  search_requests: {
    roles: STAFF_ROLES,
    bump: false,
    handler: async (ctx, input) => {
      requireCap(ctx, 'ver_solicitudes');
      const everyone = await listStudents(ctx.q);
      const students = can(ctx, 'todos_niveles') ? everyone : ctx.staff.routeId ? everyone.filter((s) => s.routeId === ctx.staff.routeId) : everyone.filter((s) => (ctx.staff.grades || []).includes(s.grade));
      const studentIds = students.map((s) => s.id);
      const text = String(input.q || '').trim().slice(0, 100);
      const from = isValidDate(input.from) ? input.from : null;
      const to = isValidDate(input.to) ? input.to : null;
      const status = REQUEST_STATUSES.includes(input.status) ? input.status : null;
      const kind = ['salida', 'excusa'].includes(input.kind) ? input.kind : null;
      const rows = await searchRequests(ctx.q, { studentIds, text, from, to, status, kind, limit: 200 });
      return withExpired(rows, todayOf(ctx));
    },
  },
});
