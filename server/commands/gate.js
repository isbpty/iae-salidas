import { register } from './index.js';
import { requireCap, requireTitular, STAFF_ROLES } from './guards.js';
import { requestConfirmation, confirmPickup, markExit } from '../domain/requests.js';
import { logEvent } from '../domain/notifications.js';
import { todayOf } from '../domain/eligibility.js';
import { getRequest, listRequests, getStudent } from '../db/repo.js';
import { HttpError, notFound } from '../domain/errors.js';

register({
  request_confirmation: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => { requireCap(ctx, 'marcar_salida'); return requestConfirmation(ctx, input.requestId, ctx.staff.id); },
  },
  confirm_pickup: {
    roles: ['parent'],
    handler: async (ctx, input) => {
      const r = await getRequest(ctx.q, input.requestId);
      if (!r) notFound('request_not_found');
      await requireTitular(ctx, r.studentId);
      return confirmPickup(ctx, r.id, ctx.person.id, !!input.confirmed);
    },
  },
  mark_exit: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => { requireCap(ctx, 'marcar_salida'); return markExit(ctx, input.requestId, ctx.staff.id); },
  },
  scan_code: {
    roles: STAFF_ROLES,
    bump: false, // solo lee y deja una fila en la bitácora de quien escanea; no cambia nada para los demás
    handler: async (ctx, input) => {
      requireCap(ctx, 'marcar_salida');
      const code = String(input.code || '').replace(/\D/g, '');
      const req = (await listRequests(ctx.q, { date: todayOf(ctx), kind: 'salida', status: 'aprobada', hydrate: false })).find((r) => r.code === code);
      if (!req) throw new HttpError(404, 'code_not_found', 'Código no válido o sin salida aprobada para hoy.');
      const st = await getStudent(ctx.q, req.studentId);
      await logEvent(ctx, 'Escaneó el código ' + code + ' (' + st.name + ')', ctx.staff.name);
      return { requestId: req.id };
    },
  },
});
