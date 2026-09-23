import { listStudents, listPersons, listAuthorizations, listRequests, listNotificationsForStaff, listStaff, listRoutes, listTripsOn, listAudit, listUsers, listChatSummaries, listConversations } from '../db/repo.js';
import { todayOf, withAuthExpiry } from '../domain/eligibility.js';
import { withExpired } from '../domain/requests.js';
import { shiftISO } from '../domain/time.js';
import { publicPerson } from './parent.js';

/* R3: "hoy + pendientes + últimos 14 días" -- how far back a Recepción/Admin/teacher view reaches
   before a `search_requests` call is needed for the rest of the history. */
const REQUEST_WINDOW_DAYS = 14;

const can = (ctx, cap) => ctx.user.role === 'admin' || !!(ctx.permissions[ctx.user.role] || {})[cap];

export async function staffView(ctx) {
  const me = ctx.staff;
  const role = ctx.user.role;
  const everyone = await listStudents(ctx.q);
  const today = todayOf(ctx);
  const since = shiftISO(ctx.now, ctx.tz, -REQUEST_WINDOW_DAYS);
  let students, requests, authorizations;
  if (role === 'garita') {
    /* Gate sees only today's aprobada/retirado salidas, and only the students, requesters
       and pickup persons those requests reference -- not the whole roster or its family data. */
    requests = (await listRequests(ctx.q, { date: today, kind: 'salida' })).filter((r) => ['aprobada', 'retirado'].includes(r.status));
    const referenced = new Set(requests.map((r) => r.studentId));
    students = everyone.filter((s) => referenced.has(s.id));
    authorizations = [];
  } else {
    students = can(ctx, 'todos_niveles') ? everyone : me.routeId ? everyone.filter((s) => s.routeId === me.routeId) : everyone.filter((s) => (me.grades || []).includes(s.grade));
    const ids = students.map((s) => s.id);
    requests = [];
    if (can(ctx, 'ver_solicitudes') || can(ctx, 'ver_excusas')) {
      requests = await listRequests(ctx.q, { studentIds: ids, since });
      if (!can(ctx, 'ver_solicitudes')) requests = requests.filter((r) => r.kind !== 'salida');
      if (!can(ctx, 'ver_excusas')) requests = requests.filter((r) => r.kind !== 'excusa');
    }
    authorizations = can(ctx, 'gestionar_autorizados') || can(ctx, 'ver_estudiantes') ? await listAuthorizations(ctx.q, { studentIds: ids }) : [];
  }
  requests = withExpired(requests, today);
  authorizations = withAuthExpiry(authorizations, ctx);
  const all = await listPersons(ctx.q);
  const byId = Object.fromEntries(all.map((p) => [p.id, p]));
  const persons = {};
  if (role === 'garita') {
    const wanted = new Set();
    for (const s of students) for (const t of s.titulares) wanted.add(t);
    for (const r of requests) { wanted.add(r.requestedBy); if (r.pickupBy) wanted.add(r.pickupBy); }
    for (const id of wanted) if (byId[id]) persons[id] = publicPerson(byId[id]);
  } else {
    /* R3: used to be "every person in the school" for `todos_niveles` roles (admin/recepción) --
       cédula and phone for a family that has nothing to do with what's on screen. Scoped to who the
       visible students/authorizations/requests actually reference, same as the other roles, plus
       (todos_niveles only) account holders with a phone so the WhatsApp phone picker still lists
       everyone it could simulate, not just the families this page happens to reference. */
    const wanted = new Set();
    for (const s of students) for (const t of s.titulares) wanted.add(t);
    for (const a of authorizations) { wanted.add(a.personId); if (a.createdBy) wanted.add(a.createdBy); }
    for (const r of requests) { wanted.add(r.requestedBy); if (r.pickupBy) wanted.add(r.pickupBy); }
    if (can(ctx, 'todos_niveles')) for (const p of all) if (p.hasAccount && p.phone) wanted.add(p.id);
    for (const id of wanted) if (byId[id]) persons[id] = publicPerson(byId[id]);
  }
  const allRoutes = await listRoutes(ctx.q);
  const routes = can(ctx, 'ver_rutas') ? (me.routeId ? allRoutes.filter((r) => r.id === me.routeId) : allRoutes) : [];
  const routeIds = new Set(routes.map((r) => r.id));
  const trips = (await listTripsOn(ctx.q, today)).filter((t) => routeIds.has(t.routeId));
  const notifications = await listNotificationsForStaff(ctx.q, role, me.id, ctx.user.id, { limit: 100 });
  const staff = await listStaff(ctx.q);
  return {
    me,
    students,
    persons,
    authorizations,
    requests,
    notifications,
    staff: can(ctx, 'personal') ? staff : staff.map(({ id, name, role: r, title }) => ({ id, name, role: r, title })),
    routes,
    trips,
    gpsNow: Object.fromEntries(routes.map((r) => [r.id, ctx.gps.position(r, ctx)])),
    staffNames: Object.fromEntries(staff.map((s) => [s.id, s.name])),
    audit: can(ctx, 'bitacora') ? await listAudit(ctx.q, 500) : null,
    permissions: role === 'admin' ? ctx.permissions : null,
    users: role === 'admin' ? (await listUsers(ctx.q)).map(({ id, name, role: r, kind, refId }) => ({ id, name, role: r, kind, refId })) : null,
    chats: role === 'admin' ? await listChatSummaries(ctx.q) : null,
    chatStates: role === 'admin' ? await listConversations(ctx.q) : null,
    unread: notifications.filter((n) => !n.read).length,
  };
}
