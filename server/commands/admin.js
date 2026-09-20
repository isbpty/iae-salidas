import { register } from './index.js';
import { requireCap, STAFF_ROLES } from './guards.js';
import { getSettings, saveSettings, setPermission, getPermissions, markNotificationsRead } from '../db/repo.js';
import { resetAll, seedDemo } from '../db/seed.js';
import { seedLoad } from '../db/seed-load.js';
import { logEvent } from '../domain/notifications.js';
import { roleName } from '../domain/text.js';
import { badRequest, conflict } from '../domain/errors.js';
import { createTesters, countTesters } from '../testers.js';

const CAPS = ['ver_solicitudes', 'aprobar', 'ver_excusas', 'decidir_excusas', 'marcar_salida', 'ver_estudiantes', 'gestionar_autorizados', 'ver_rutas', 'marcar_bus', 'personal', 'config', 'bitacora', 'todos_niveles'];
const ROLES = ['recepcion', 'profesor', 'garita', 'monitora'];
const HHMM = /^\d{2}:\d{2}$/;
const clampInt = (v, min, max, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };

register({
  update_settings: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => {
      requireCap(ctx, 'config');
      const cur = await getSettings(ctx.q);
      const d = input.data || {};
      const next = { ...cur, school: { ...cur.school } };
      if ('autoApprove' in d) next.autoApprove = d.autoApprove === true || d.autoApprove === 'on';
      if ('simulateBus' in d) next.simulateBus = d.simulateBus === true || d.simulateBus === 'on';
      if ('minAnticipationMin' in d) next.minAnticipationMin = clampInt(d.minAnticipationMin, 0, 1440, cur.minAnticipationMin);
      if ('maxTitulares' in d) next.maxTitulares = clampInt(d.maxTitulares, 1, 4, cur.maxTitulares);
      if ('newAuthDays' in d) next.newAuthDays = clampInt(d.newAuthDays, 0, 60, cur.newAuthDays);
      if ('busProgress' in d) next.busProgress = Math.min(1, Math.max(0, Number(d.busProgress) || 0));
      for (const k of ['schoolStart', 'schoolEnd']) if (k in d) { if (!HHMM.test(String(d[k]))) badRequest('invalid_time'); next[k] = d[k]; }
      if (d.school) {
        if ('name' in d.school) next.school.name = String(d.school.name || '').trim() || cur.school.name;
        if ('phone' in d.school) next.school.phone = String(d.school.phone || '').trim() || cur.school.phone;
        if ('pickupPoints' in d.school) {
          const pts = [].concat(d.school.pickupPoints || []).map((x) => String(x).trim()).filter(Boolean);
          if (!pts.length) badRequest('pickup_points_required');
          next.school.pickupPoints = pts;
        }
      }
      const wanted = 'defaultPickupPoint' in d ? d.defaultPickupPoint : cur.defaultPickupPoint;
      next.defaultPickupPoint = next.school.pickupPoints.includes(wanted) ? wanted : next.school.pickupPoints[0];
      await saveSettings(ctx.q, next);
      await logEvent(ctx, 'Actualizó la configuración (auto-aprobación: ' + (next.autoApprove ? 'activa' : 'inactiva') + ', anticipación ' + next.minAnticipationMin + ' min)', ctx.staff.name);
      return next;
    },
  },
  set_permission: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => {
      requireCap(ctx, 'personal');
      if (input.role === 'admin') badRequest('admin_permissions_fixed');
      if (!ROLES.includes(input.role)) badRequest('invalid_role');
      if (!CAPS.includes(input.capability)) badRequest('invalid_capability');
      const allowed = input.allowed === true || input.allowed === 'on';
      await setPermission(ctx.q, input.role, input.capability, allowed);
      await logEvent(ctx, 'Permiso "' + input.capability + '" ' + (allowed ? 'otorgado a' : 'quitado a') + ' ' + roleName(input.role), ctx.staff.name);
      return getPermissions(ctx.q);
    },
  },
  reset_demo: {
    roles: ['admin'],
    handler: async (ctx) => {
      await resetAll(ctx.q);
      const revision = await seedDemo(ctx.q, { now: ctx.now, tz: ctx.tz });
      return { revision };
    },
  },
  /* Datos de prueba a escala: reinicia y carga N estudiantes generados encima del seed base. */
  seed_load: {
    roles: ['admin'],
    handler: async (ctx, input) => {
      const students = clampInt(input.students, 50, 3000, 700);
      const seed = clampInt(input.seed, 1, 1e9, 7);
      await resetAll(ctx.q);
      await seedDemo(ctx.q, { now: ctx.now, tz: ctx.tz });
      const counts = await seedLoad(ctx.q, { students, seed, now: ctx.now, tz: ctx.tz });
      await logEvent(ctx, 'Cargó datos de prueba: ' + counts.students + ' estudiantes en ' + counts.families + ' familias', ctx.staff.name);
      return counts;
    },
  },
  /* Testers: real people with their own PIN. Only the first creation happens here (from the shared PIN,
     before any super admin exists); everything else lives on the /super page with its own key. */
  create_testers: {
    roles: ['admin'],
    handler: async (ctx) => {
      if ((await countTesters(ctx.q)) > 0) conflict('testers_exist');
      const made = await createTesters(ctx.q, ctx.now);
      await logEvent(ctx, 'Creó los ' + made.length + ' probadores del piloto', ctx.staff.name);
      return made;
    },
  },
  mark_notifications_read: {
    roles: ['parent', ...STAFF_ROLES],
    handler: async (ctx) => {
      if (ctx.person) await markNotificationsRead(ctx.q, { personId: ctx.person.id }, ctx.now);
      if (ctx.staff) { await markNotificationsRead(ctx.q, { staffId: ctx.staff.id }, ctx.now); await markNotificationsRead(ctx.q, { role: ctx.user.role }, ctx.now); }
      return { ok: true };
    },
  },
});
