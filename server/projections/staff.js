import { listStudents, listPersons, listAuthorizations, listRequests, listNotifications, listStaff, listRoutes, listTripsOn, listAudit, listUsers, listAllChats, listConversations } from '../db/repo.js';
import { todayOf } from '../domain/eligibility.js';
import { publicPerson } from './parent.js';

const can = (ctx, cap) => ctx.user.role === 'admin' || !!(ctx.permissions[ctx.user.role] || {})[cap];

export async function staffView(ctx) {
  const me = ctx.staff;
  const role = ctx.user.role;
  const everyone = await listStudents(ctx.q);
  const today = todayOf(ctx);
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
      requests = await listRequests(ctx.q, { studentIds: ids });
      if (!can(ctx, 'ver_solicitudes')) requests = requests.filter((r) => r.kind !== 'salida');
      if (!can(ctx, 'ver_excusas')) requests = requests.filter((r) => r.kind !== 'excusa');
    }
    authorizations = can(ctx, 'gestionar_autorizados') || can(ctx, 'ver_estudiantes') ? await listAuthorizations(ctx.q, { studentIds: ids }) : [];
  }
  const all = await listPersons(ctx.q);
  const byId = Object.fromEntries(all.map((p) => [p.id, p]));
  const persons = {};
  if (role === 'garita') {
    const wanted = new Set();
    for (const s of students) for (const t of s.titulares) wanted.add(t);
    for (const r of requests) { wanted.add(r.requestedBy); if (r.pickupBy) wanted.add(r.pickupBy); }
    for (const id of wanted) if (byId[id]) persons[id] = publicPerson(byId[id]);
  } else if (can(ctx, 'todos_niveles')) {
    for (const p of all) persons[p.id] = publicPerson(p);
  } else {
    const wanted = new Set();
    for (const s of students) for (const t of s.titulares) wanted.add(t);
    for (const a of authorizations) { wanted.add(a.personId); if (a.createdBy) wanted.add(a.createdBy); }
    for (const r of requests) { wanted.add(r.requestedBy); if (r.pickupBy) wanted.add(r.pickupBy); }
    for (const id of wanted) if (byId[id]) persons[id] = publicPerson(byId[id]);
  }
  const allRoutes = await listRoutes(ctx.q);
  const routes = can(ctx, 'ver_rutas') ? (me.routeId ? allRoutes.filter((r) => r.id === me.routeId) : allRoutes) : [];
  const routeIds = new Set(routes.map((r) => r.id));
  const trips = (await listTripsOn(ctx.q, today)).filter((t) => routeIds.has(t.routeId));
  const notifications = [...(await listNotifications(ctx.q, { role })), ...(await listNotifications(ctx.q, { staffId: me.id }))].sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));
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
    chats: role === 'admin' ? await listAllChats(ctx.q) : null,
    chatStates: role === 'admin' ? await listConversations(ctx.q) : null,
    unread: notifications.filter((n) => !n.read).length,
  };
}
