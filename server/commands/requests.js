import { register } from './index.js';
import { requireCap, requireTitular, STAFF_ROLES } from './guards.js';
import { createRequest, approveRequest, rejectRequest, acceptExcusa, cancelRequest, staffCancelRequest } from '../domain/requests.js';
import { getRequest, getAttachment } from '../db/repo.js';
import { deny, notFound, badRequest, conflict } from '../domain/errors.js';

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
});
