import { register } from './index.js';
import { requireCap, requireTitular, requireRouteAccess, STAFF_ROLES } from './guards.js';
import { markBoarding, setTripStatus, markNoBus, undoNoBus, whereIs } from '../domain/bus.js';
import { logEvent } from '../domain/notifications.js';
import { badRequest } from '../domain/errors.js';
import { todayISO, shiftISO } from '../domain/time.js';

const LEGS = ['ida', 'vuelta'];
/* mark_no_bus/undo_no_bus only accept an explicit date of "hoy" or "mañana" (L12) -- anything else
   is rejected rather than silently registering an opt-out for an arbitrary day. */
function optOutDate(ctx, date) {
  if (date === undefined || date === null) return undefined;
  const today = todayISO(ctx.now, ctx.tz);
  const tomorrow = shiftISO(ctx.now, ctx.tz, 1);
  if (date !== today && date !== tomorrow) badRequest('invalid_date');
  return date;
}
register({
  mark_boarding: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => {
      requireCap(ctx, 'marcar_bus');
      requireRouteAccess(ctx, input.routeId);
      return markBoarding(ctx, input.routeId, input.leg, input.studentId, input.status, ctx.staff.id, input.stopId || null);
    },
  },
  set_trip_status: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => {
      requireCap(ctx, 'marcar_bus');
      requireRouteAccess(ctx, input.routeId);
      return setTripStatus(ctx, input.routeId, input.leg, input.status, ctx.staff.id);
    },
  },
  mark_no_bus: {
    roles: ['parent'],
    handler: async (ctx, input) => {
      await requireTitular(ctx, input.studentId);
      const legs = Array.isArray(input.legs) && input.legs.length ? input.legs : LEGS;
      if (legs.some((l) => !LEGS.includes(l))) badRequest('invalid_leg');
      // { studentId, legs } with no date keeps working exactly as before (defaults to today inside
      // markNoBus); `date` is optional and new (L12).
      return markNoBus(ctx, input.studentId, ctx.person.id, legs, optOutDate(ctx, input.date));
    },
  },
  undo_no_bus: {
    roles: ['parent'],
    handler: async (ctx, input) => {
      await requireTitular(ctx, input.studentId);
      const legs = Array.isArray(input.legs) && input.legs.length ? input.legs : LEGS;
      if (legs.some((l) => !LEGS.includes(l))) badRequest('invalid_leg');
      return undoNoBus(ctx, input.studentId, ctx.person.id, legs, optOutDate(ctx, input.date));
    },
  },
  where_is: {
    roles: ['parent'],
    bump: false, // consulta de lectura
    handler: async (ctx, input) => {
      const st = await requireTitular(ctx, input.studentId);
      const w = await whereIs(ctx, st.id);
      await logEvent(ctx, 'Consultó la ubicación de ' + st.name + ' desde la app', ctx.person.name);
      return w;
    },
  },
});
