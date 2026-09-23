import { camel, snake } from './rows.js';
import { todayISO } from '../domain/time.js';

const one = (rows) => camel(rows[0] || null);
const all = (rows) => rows.map(camel);
const isBytes = (v) => Buffer.isBuffer(v) || v instanceof Uint8Array;
function param(v) {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object' && !isBytes(v)) return JSON.stringify(v);
  return v;
}

/* ---------- generic ---------- */
export async function insertRow(q, table, obj) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const cols = keys.map(snake).join(', ');
  const marks = keys.map((_, i) => '$' + (i + 1)).join(', ');
  await q.query(`INSERT INTO ${table} (${cols}) VALUES (${marks})`, keys.map((k) => param(obj[k])));
}
/* Multi-row insert (chunks of 200) for the load seed; every row must carry the same keys. */
export async function insertRows(q, table, rows) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const cols = keys.map(snake).join(', ');
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const values = [];
    const marks = chunk.map((row, r) => '(' + keys.map((k, c) => { values.push(param(row[k])); return '$' + (r * keys.length + c + 1); }).join(', ') + ')').join(', ');
    await q.query(`INSERT INTO ${table} (${cols}) VALUES ${marks}`, values);
  }
}
export async function patchRow(q, table, id, patch) {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${snake(k)}=$${i + 2}`).join(', ');
  await q.query(`UPDATE ${table} SET ${sets} WHERE id=$1`, [id, ...keys.map((k) => param(patch[k]))]);
}
const marks = (n, from = 1) => Array.from({ length: n }, (_, i) => '$' + (i + from)).join(', ');

/* ---------- settings, permissions, revision ---------- */
export async function getSettings(q) { const r = await q.query("SELECT data FROM settings WHERE id='school'"); return r[0] ? r[0].data : {}; }
export async function saveSettings(q, data) { await q.query("INSERT INTO settings(id, data) VALUES ('school', $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data", [JSON.stringify(data)]); }
export async function getPermissions(q) {
  const out = {};
  for (const r of await q.query('SELECT role, capability, allowed FROM role_permissions')) (out[r.role] ||= {})[r.capability] = r.allowed;
  return out;
}
export async function setPermission(q, role, capability, allowed) {
  await q.query('INSERT INTO role_permissions(role, capability, allowed) VALUES ($1, $2, $3) ON CONFLICT (role, capability) DO UPDATE SET allowed = EXCLUDED.allowed', [role, capability, allowed]);
}
export async function getRevision(q) { const r = await q.query("SELECT value FROM app_meta WHERE id='revision'"); return r[0] ? r[0].value : 0; }
export async function bumpRevision(q) {
  const r = await q.query("INSERT INTO app_meta(id, value) VALUES ('revision', 1) ON CONFLICT (id) DO UPDATE SET value = app_meta.value + 1 RETURNING value");
  return r[0].value;
}

/* ---------- levels, staff, users, persons, students ---------- */
export const listLevels = async (q) => all(await q.query('SELECT * FROM levels ORDER BY position'));
export const listStaff = async (q) => all(await q.query('SELECT * FROM staff ORDER BY id'));
export const getStaff = async (q, id) => one(await q.query('SELECT * FROM staff WHERE id=$1', [id]));
export const listUsers = async (q) => all(await q.query('SELECT * FROM users WHERE active ORDER BY kind DESC, id'));
export const getUser = async (q, id) => one(await q.query('SELECT * FROM users WHERE id=$1', [id]));
export const getPerson = async (q, id) => one(await q.query('SELECT * FROM persons WHERE id=$1', [id]));
export const listPersons = async (q) => all(await q.query('SELECT * FROM persons ORDER BY id'));

/* `titulares` used to be a second, unfiltered `SELECT * FROM guardianships` -- every `getStudent`
   (create_salida calls it ~8 times) or `studentsOfPerson` read all 1 000+ rows of the table just to
   pick out one student's guardians (R2). A `LEFT JOIN … array_agg` folds that into the same query as
   the student row(s), so a single lookup is one query instead of two, and a batch (`listStudents`)
   stays one query regardless of how many students it returns -- `GROUP BY s.id` is enough for
   Postgres to allow every other `s.*` column by primary-key functional dependency. */
const TITULARES_AGG = "COALESCE(array_agg(g.person_id ORDER BY g.person_id) FILTER (WHERE g.person_id IS NOT NULL), '{}') AS titulares";
const rowsWithTitulares = (rows) => rows.map((r) => { const s = camel(r); return { ...s, titulares: s.titulares || [] }; });
export const listStudents = async (q) => rowsWithTitulares(await q.query(
  `SELECT s.*, ${TITULARES_AGG} FROM students s LEFT JOIN guardianships g ON g.student_id = s.id GROUP BY s.id ORDER BY s.id`));
export async function getStudent(q, id) {
  const rows = await q.query(`SELECT s.*, ${TITULARES_AGG} FROM students s LEFT JOIN guardianships g ON g.student_id = s.id WHERE s.id=$1 GROUP BY s.id`, [id]);
  return rows.length ? rowsWithTitulares(rows)[0] : null;
}
export async function studentsOfPerson(q, personId) {
  return rowsWithTitulares(await q.query(
    `SELECT s.*, ${TITULARES_AGG} FROM students s JOIN guardianships own ON own.student_id = s.id AND own.person_id=$1
     LEFT JOIN guardianships g ON g.student_id = s.id GROUP BY s.id ORDER BY s.id`, [personId]));
}

/* ---------- requests ---------- */
export async function hydrateRequests(q, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const events = await q.query(`SELECT request_id, at, text FROM request_events WHERE request_id IN (${marks(ids.length)}) ORDER BY id`, ids);
  const confs = await q.query(`SELECT * FROM pickup_confirmations WHERE request_id IN (${marks(ids.length)})`, ids);
  const hist = {}, conf = {};
  for (const e of events) (hist[e.request_id] ||= []).push({ ts: new Date(e.at).getTime(), text: e.text });
  for (const c of confs) conf[c.request_id] = { status: c.status, by: c.requested_by_staff, requestedAt: c.requested_at ? new Date(c.requested_at).getTime() : null, byPerson: c.answered_by_person, at: c.answered_at ? new Date(c.answered_at).getTime() : null };
  return rows.map(camel).map((r) => ({ ...r, history: hist[r.id] || [], confirmation: conf[r.id] || null }));
}
export const insertRequest = (q, r) => insertRow(q, 'requests', r);
export async function getRequest(q, id) { return (await hydrateRequests(q, await q.query('SELECT * FROM requests WHERE id=$1', [id])))[0] || null; }
/* `hydrate: false` skips the history/confirmation batch (2 extra queries) for callers that only
   need `code`/`status`/`date`/etc -- `uniqueCode` and the duplicate/rejected checks in
   `autoapprove.js` (R2) -- and never touch `.history`/`.confirmation` on the result.
   `since` (R3) trims the Recepción/Admin/padre views to "hoy + pendientes + últimos 14 días":
   any `pendiente` request stays visible regardless of its date (it still needs action), everything
   else must have `date >= since`. Older history beyond that window is reached through
   `searchRequests` instead of being loaded into every view. */
export async function listRequests(q, { studentIds, date, kind, status, since, hydrate = true } = {}) {
  const where = [], params = [];
  if (studentIds) { if (!studentIds.length) return []; where.push(`student_id IN (${marks(studentIds.length, params.length + 1)})`); params.push(...studentIds); }
  if (date) { params.push(date); where.push(`date=$${params.length}`); }
  if (kind) { params.push(kind); where.push(`kind=$${params.length}`); }
  if (status) { params.push(status); where.push(`status=$${params.length}`); }
  if (since) { params.push(since); where.push(`(date >= $${params.length} OR status='pendiente')`); }
  const sql = 'SELECT * FROM requests' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC, id DESC';
  const rows = await q.query(sql, params);
  return hydrate ? hydrateRequests(q, rows) : all(rows);
}
/* The historical counterpart of `listRequests`: a free-text `search_requests` command reaches past
   the 14-day window on demand instead of every view paying for the whole table. `text` matches the
   student's name, the requester's/pickup person's name/cédula/phone, or the salida `code` --
   whatever a receptionist would actually type into the search box. Capped at `limit` (the command
   enforces 200) so a broad query can never return the whole history either. */
export async function searchRequests(q, { studentIds, text, from, to, status, kind, limit = 200 } = {}) {
  const where = [], params = [];
  if (studentIds) { if (!studentIds.length) return []; where.push(`r.student_id IN (${marks(studentIds.length, params.length + 1)})`); params.push(...studentIds); }
  if (from) { params.push(from); where.push(`r.date >= $${params.length}`); }
  if (to) { params.push(to); where.push(`r.date <= $${params.length}`); }
  if (kind) { params.push(kind); where.push(`r.kind=$${params.length}`); }
  if (status) { params.push(status); where.push(`r.status=$${params.length}`); }
  if (text) {
    params.push('%' + text + '%');
    const p = params.length;
    where.push(`(s.name ILIKE $${p} OR rp.name ILIKE $${p} OR pk.name ILIKE $${p} OR rp.cedula ILIKE $${p} OR pk.cedula ILIKE $${p} OR rp.phone ILIKE $${p} OR pk.phone ILIKE $${p} OR r.code ILIKE $${p})`);
  }
  params.push(Math.max(1, Math.min(200, limit || 200)));
  const sql = `SELECT r.* FROM requests r
    JOIN students s ON s.id = r.student_id
    LEFT JOIN persons rp ON rp.id = r.requested_by
    LEFT JOIN persons pk ON pk.id = r.pickup_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length}`;
  return hydrateRequests(q, await q.query(sql, params));
}
export const addRequestEvent = (q, requestId, at, text) => insertRow(q, 'request_events', { requestId, at, text });
export async function upsertConfirmation(q, row) {
  await q.query(`INSERT INTO pickup_confirmations(request_id, status, requested_by_staff, requested_at, answered_by_person, answered_at) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (request_id) DO UPDATE SET status=EXCLUDED.status, requested_by_staff=COALESCE(EXCLUDED.requested_by_staff, pickup_confirmations.requested_by_staff),
    requested_at=COALESCE(EXCLUDED.requested_at, pickup_confirmations.requested_at), answered_by_person=EXCLUDED.answered_by_person, answered_at=EXCLUDED.answered_at`,
  [row.requestId, row.status, row.requestedByStaff || null, param(row.requestedAt), row.answeredByPerson || null, param(row.answeredAt)]);
}

/* ---------- authorizations ---------- */
export async function listAuthorizations(q, { studentIds, personId, includeRevoked = true } = {}) {
  const where = [], params = [];
  if (studentIds) { if (!studentIds.length) return []; where.push(`student_id IN (${marks(studentIds.length, 1)})`); params.push(...studentIds); }
  if (personId) { params.push(personId); where.push(`person_id=$${params.length}`); }
  if (!includeRevoked) where.push('revoked_at IS NULL');
  return all(await q.query('SELECT * FROM authorizations' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at, id', params));
}
export const getAuthorization = async (q, id) => one(await q.query('SELECT * FROM authorizations WHERE id=$1', [id]));

/* ---------- notifications ---------- */
export const insertNotification = (q, n, at) => insertRow(q, 'notifications', { ...n, createdAt: at });
function targetWhere(target, params) {
  if (target.personId) { params.push(target.personId); return `person_id=$${params.length}`; }
  if (target.staffId) { params.push(target.staffId); return `staff_id=$${params.length}`; }
  params.push(target.role); return `role=$${params.length}`;
}
/* `limit` (R3, "avisos: últimos 100") caps the notices a view carries. The cap must keep the most
   recent ones, so it orders `DESC ... LIMIT` first and re-sorts ascending in an outer query --
   `unread`/toast logic downstream (state.js) still expects oldest-first. */
export async function listNotifications(q, target, { limit } = {}) {
  const params = []; const w = targetWhere(target, params);
  let sql = `SELECT * FROM notifications WHERE ${w} ORDER BY seq`;
  if (limit) { params.push(limit); sql = `SELECT * FROM (SELECT * FROM notifications WHERE ${w} ORDER BY seq DESC LIMIT $${params.length}) sub ORDER BY seq`; }
  return all(await q.query(sql, params)).map((n) => ({ ...n, ts: n.createdAt, read: !!n.readAt }));
}
/* Personal notices (`personId`/`staffId` target) are only ever seen by one user, so "read" is still
   the shared `read_at` column. Role notices are shared by everyone in the role (L10): marking one
   read must not silence it for the rest, so it's recorded per `userId` in `notification_reads`
   instead of touching the notification row. `userId` is required whenever `target.role` is set. */
export async function markNotificationsRead(q, target, at, userId) {
  if (target.role) {
    await q.query(
      `INSERT INTO notification_reads(notification_id, user_id, read_at)
       SELECT id, $2, $3 FROM notifications WHERE role=$1
       ON CONFLICT (notification_id, user_id) DO NOTHING`,
      [target.role, userId, at.toISOString()]);
    return;
  }
  const params = [at.toISOString()]; const w = targetWhere(target, params);
  await q.query(`UPDATE notifications SET read_at=$1 WHERE read_at IS NULL AND ${w}`, params);
}
/* Staff views need both "notices for my role" and "notices for me by staff id" -- two separate
   `listNotifications` calls before. One `role=$1 OR staff_id=$2` query returns the same rows.
   `userId` (the caller's `users.id`) is joined against `notification_reads` to compute `read` for
   role notices per user (L10); staff-targeted notices keep using their own `read_at`. */
export async function listNotificationsForStaff(q, role, staffId, userId, { limit } = {}) {
  const base = `SELECT n.*, nr.read_at AS role_read_at FROM notifications n
     LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $3
     WHERE n.role=$1 OR n.staff_id=$2`;
  const params = [role, staffId, userId];
  let sql = base + ' ORDER BY n.seq';
  if (limit) { params.push(limit); sql = `SELECT * FROM (${base} ORDER BY n.seq DESC LIMIT $${params.length}) sub ORDER BY seq`; }
  return all(await q.query(sql, params)).map((n) => ({ ...n, ts: n.createdAt, read: n.role ? !!n.roleReadAt : !!n.readAt }));
}

/* ---------- chat & conversation ---------- */
const chatRow = (m) => ({ id: m.id, from: m.direction === 'in' ? 'user' : 'bot', text: m.text, buttons: m.buttons, location: m.location, ts: m.createdAt, pendingUntil: m.pendingUntil });
export const insertChat = (q, m, at) => insertRow(q, 'chat_messages', { ...m, createdAt: at });
export const listChat = async (q, chatKey) => all(await q.query('SELECT * FROM chat_messages WHERE chat_key=$1 ORDER BY id', [chatKey])).map(chatRow);
export async function listAllChats(q) {
  const out = {};
  for (const m of all(await q.query('SELECT * FROM chat_messages ORDER BY id'))) (out[m.chatKey] ||= []).push(chatRow(m));
  return out;
}
/* R3: the admin view used to embed every WhatsApp message of every family (`listAllChats`) just so
   the sidebar could show a last-message preview -- with months of use that is the single biggest
   contributor to view size. A summary per `chat_key` (count, last message, and "unread" = messages
   received since the school's last reply) is enough for the chat list; the full transcript for
   whichever phone is selected loads on demand through `get_chat`/`listChat`. Three small aggregate
   queries (none scanning per-chat in JS) instead of one that returns every row. */
export async function listChatSummaries(q) {
  const counts = all(await q.query('SELECT chat_key, count(*)::int AS c FROM chat_messages GROUP BY chat_key'));
  if (!counts.length) return {};
  const last = all(await q.query('SELECT DISTINCT ON (chat_key) chat_key, text, created_at FROM chat_messages ORDER BY chat_key, id DESC'));
  const unread = all(await q.query(
    `SELECT chat_key, count(*)::int AS c FROM chat_messages m WHERE direction='in' AND created_at >
       COALESCE((SELECT max(o.created_at) FROM chat_messages o WHERE o.chat_key = m.chat_key AND o.direction='out'), '-infinity')
     GROUP BY chat_key`));
  const lastByKey = Object.fromEntries(last.map((r) => [r.chatKey, r]));
  const unreadByKey = Object.fromEntries(unread.map((r) => [r.chatKey, r.c]));
  const out = {};
  for (const r of counts) {
    const l = lastByKey[r.chatKey] || {};
    out[r.chatKey] = { count: r.c, lastText: l.text || null, lastAt: l.createdAt ? new Date(l.createdAt).getTime() : null, unread: unreadByKey[r.chatKey] || 0 };
  }
  return out;
}
export async function countPendingOut(q, chatKey, at) {
  const r = await q.query("SELECT count(*)::int AS c FROM chat_messages WHERE chat_key=$1 AND direction='out' AND pending_until > $2", [chatKey, at.toISOString()]);
  return r[0].c;
}
/* `ctx` (optional) is `{ now, tz }`: a state whose `updated_at` is more than 2 h old, or from a
   different calendar day in the school's timezone, is treated as gone (and dropped) instead of
   resurrecting a stale draft or alert for a later, unrelated message (L8). Callers without a `ctx`
   (rare: low-level tooling) skip the TTL check. */
export async function getConversation(q, key, ctx = {}) {
  const r = one(await q.query('SELECT * FROM conversation_state WHERE chat_key=$1', [key]));
  if (!r) return null;
  if (ctx.now) {
    const updated = new Date(r.updatedAt);
    const stale = ctx.now.getTime() - updated.getTime() > 2 * 3600 * 1000 || (ctx.tz && todayISO(ctx.now, ctx.tz) !== todayISO(updated, ctx.tz));
    if (stale) { await clearConversation(q, key); return null; }
  }
  return { step: r.step, requestId: r.requestId, draft: r.draft, alerts: r.alerts || [] };
}
export async function setConversation(q, key, state, at) {
  await q.query('INSERT INTO conversation_state(chat_key, step, request_id, draft, alerts, updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (chat_key) DO UPDATE SET step=EXCLUDED.step, request_id=EXCLUDED.request_id, draft=EXCLUDED.draft, alerts=EXCLUDED.alerts, updated_at=EXCLUDED.updated_at',
    [key, state.step, state.requestId || null, JSON.stringify(state.draft || null), JSON.stringify(state.alerts || []), at.toISOString()]);
}
export const clearConversation = (q, key) => q.query('DELETE FROM conversation_state WHERE chat_key=$1', [key]);
export async function listConversations(q) {
  const out = {};
  for (const r of all(await q.query('SELECT * FROM conversation_state'))) out[r.chatKey] = { step: r.step, requestId: r.requestId, draft: r.draft, alerts: r.alerts || [] };
  return out;
}

/* ---------- audit ---------- */
export const insertAudit = (q, row) => insertRow(q, 'audit_log', row);
/* The visible bitácora: only rows written by logEvent (summary), not the per-command rows the runner adds. */
export const listAudit = async (q, limit = 500) => all(await q.query('SELECT * FROM audit_log WHERE summary IS NOT NULL ORDER BY id DESC LIMIT $1', [limit])).map((a) => ({ ...a, ts: a.at, actor: a.actorName, text: a.summary }));

/* ---------- bus ---------- */
/* `getRoute` used to build the full route list (routes + all stops) just to `find` one by id (R2).
   A `LEFT JOIN … json_agg` folds routes and their stops into one query, shared by `listRoutes`
   (still every route, still one query) and `getRoute` (`WHERE id=$1`, one query, no full scan). */
const ROUTE_WITH_STOPS = `SELECT r.*, COALESCE(
    json_agg(json_build_object('id', st.id, 'route_id', st.route_id, 'position', st.position, 'name', st.name, 'lat', st.lat, 'lng', st.lng) ORDER BY st.position) FILTER (WHERE st.id IS NOT NULL),
    '[]'
  ) AS stops FROM routes r LEFT JOIN stops st ON st.route_id = r.id`;
const routeRow = (r) => { const c = camel(r); return { ...c, monitorId: c.monitorStaffId, stops: (c.stops || []).map(camel) }; };
export async function listRoutes(q) { return (await q.query(ROUTE_WITH_STOPS + ' GROUP BY r.id ORDER BY r.id')).map(routeRow); }
export async function getRoute(q, id) {
  const rows = await q.query(ROUTE_WITH_STOPS + ' WHERE r.id=$1 GROUP BY r.id', [id]);
  return rows.length ? routeRow(rows[0]) : null;
}
/* Boardings and opt-outs used to be two separate `IN (...)` batch queries per call (findTrip,
   listTripsOn, ensureTrip). A `UNION ALL` with a discriminator column returns both in one query;
   the row shapes differ (opt-outs have no status/stop/staff), so the unused columns are padded with
   NULL/'' on each side. */
async function hydrateTrips(q, rows) {
  if (!rows.length) return [];
  const ids = rows.map((t) => t.id);
  const events = await q.query(
    `SELECT 'board' AS src, trip_id, student_id, status, stop_id, by_staff_id, at, NULL::text AS by_person_id FROM trip_boardings WHERE trip_id = ANY($1)
     UNION ALL
     SELECT 'opt' AS src, trip_id, student_id, NULL, NULL, NULL, at, by_person_id FROM bus_opt_outs WHERE trip_id = ANY($1) ORDER BY at`, [ids]);
  const b = events.filter((x) => x.src === 'board');
  const o = events.filter((x) => x.src === 'opt');
  return rows.map(camel).map((t) => ({
    ...t,
    boarded: Object.fromEntries(b.filter((x) => x.trip_id === t.id).map((x) => [x.student_id, { status: x.status, ts: new Date(x.at).getTime(), by: x.by_staff_id, stopId: x.stop_id }])),
    noBus: o.filter((x) => x.trip_id === t.id).map((x) => x.student_id),
  }));
}
export async function findTrip(q, date, routeId, leg) { return (await hydrateTrips(q, await q.query('SELECT * FROM trips WHERE date=$1 AND route_id=$2 AND leg=$3', [date, routeId, leg])))[0] || null; }
export async function ensureTrip(q, date, routeId, leg) {
  const found = await findTrip(q, date, routeId, leg);
  if (found) return found;
  await insertRow(q, 'trips', { id: `${date}_${routeId}_${leg}`, date, routeId, leg, status: 'programado' });
  return findTrip(q, date, routeId, leg);
}
export const listTripsOn = async (q, date) => hydrateTrips(q, await q.query('SELECT * FROM trips WHERE date=$1 ORDER BY id', [date]));
export async function upsertBoarding(q, tripId, studentId, rec) {
  await q.query('INSERT INTO trip_boardings(trip_id, student_id, status, stop_id, by_staff_id, at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (trip_id, student_id) DO UPDATE SET status=EXCLUDED.status, stop_id=EXCLUDED.stop_id, by_staff_id=EXCLUDED.by_staff_id, at=EXCLUDED.at',
    [tripId, studentId, rec.status, rec.stopId || null, rec.by, param(rec.at)]);
}
export async function insertOptOut(q, tripId, studentId, personId, at) {
  await q.query('INSERT INTO bus_opt_outs(trip_id, student_id, by_person_id, at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [tripId, studentId, personId, at.toISOString()]);
}

/* ---------- attachments ---------- */
export const insertAttachment = (q, a) => insertRow(q, 'attachments', a);
export const getAttachment = async (q, id) => one(await q.query('SELECT * FROM attachments WHERE id=$1', [id]));
/* `canSeeAttachment` used to re-run `listRequests` (hydrated, with history/confirmations) for the
   whole day or the whole school just to `.some`/`.filter` one boolean out of it -- once per image
   the gate/teacher screen shows (R2). These answer the same question with a single `EXISTS`. */
export async function existsApprovedPickupToday(q, date, pickupBy) {
  const r = await q.query("SELECT 1 FROM requests WHERE date=$1 AND kind='salida' AND status IN ('aprobada','retirado') AND pickup_by=$2 LIMIT 1", [date, pickupBy]);
  return r.length > 0;
}
export async function existsExcusaForTeacher(q, attachmentId, grades) {
  if (!grades || !grades.length) return false;
  const r = await q.query("SELECT 1 FROM requests r JOIN students s ON s.id = r.student_id WHERE r.kind='excusa' AND r.attachment_id=$1 AND s.grade = ANY($2) LIMIT 1", [attachmentId, grades]);
  return r.length > 0;
}

/* ---------- activity (registro técnico, append-only) ---------- */
export const insertActivity = (q, row) => insertRow(q, 'activity_events', row);
export const purgeActivity = async (q, before) => (await q.query('DELETE FROM activity_events WHERE at < $1 RETURNING id', [before.toISOString()])).length;
