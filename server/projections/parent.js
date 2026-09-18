import { listPersons, listAuthorizations, listRequests, listNotifications, listChat, getConversation, listRoutes, listTripsOn, listStaff } from '../db/repo.js';
import { studentsOf, authorizedFor, todayOf } from '../domain/eligibility.js';

export const publicPerson = ({ id, name, phone, cedula, relation, hasAccount, docName, docAttachmentId }) => ({ id, name, phone, cedula, relation, hasAccount, docName, docAttachmentId });

export async function parentView(ctx) {
  const me = ctx.person;
  const students = await studentsOf(ctx, me.id);
  const ids = students.map((s) => s.id);
  const all = await listPersons(ctx.q);
  const byId = Object.fromEntries(all.map((p) => [p.id, p]));
  const authorizations = await listAuthorizations(ctx.q, { studentIds: ids, includeRevoked: false });
  const requests = await listRequests(ctx.q, { studentIds: ids });
  const wanted = new Set([me.id]);
  for (const s of students) for (const t of s.titulares) wanted.add(t);
  for (const a of authorizations) { wanted.add(a.personId); if (a.createdBy) wanted.add(a.createdBy); }
  for (const r of requests) { wanted.add(r.requestedBy); if (r.pickupBy) wanted.add(r.pickupBy); }
  const forOthers = await authorizedFor(ctx, me.id);
  const persons = {};
  for (const id of wanted) if (byId[id]) persons[id] = publicPerson(byId[id]);
  const routeIds = new Set(students.map((s) => s.routeId).filter(Boolean));
  const routes = (await listRoutes(ctx.q)).filter((r) => routeIds.has(r.id));
  const trips = (await listTripsOn(ctx.q, todayOf(ctx))).filter((t) => routeIds.has(t.routeId));
  const notifications = await listNotifications(ctx.q, { personId: me.id });
  return {
    me: publicPerson(me),
    students,
    persons,
    accounts: all.filter((p) => p.hasAccount && p.id !== me.id).map(({ id, name, relation }) => ({ id, name, relation })),
    authorizations,
    authorizedFor: forOthers.map((x) => ({ auth: x.auth, createdByName: (byId[x.auth.createdBy] || {}).name || null, student: { id: x.student.id, name: x.student.name, grade: x.student.grade, emoji: x.student.emoji } })),
    requests,
    notifications,
    chat: await listChat(ctx.q, me.id),
    chatState: await getConversation(ctx.q, me.id),
    routes,
    trips,
    gpsNow: Object.fromEntries(routes.map((r) => [r.id, ctx.gps.position(r, ctx)])),
    staffNames: Object.fromEntries((await listStaff(ctx.q)).map((s) => [s.id, s.name])),
    unread: notifications.filter((n) => !n.read).length,
  };
}
