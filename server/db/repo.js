import { camel, snake } from './rows.js';

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

async function withTitulares(q, rows) {
  if (!rows.length) return [];
  const map = {};
  for (const g of await q.query('SELECT student_id, person_id FROM guardianships ORDER BY person_id')) (map[g.student_id] ||= []).push(g.person_id);
  return rows.map(camel).map((s) => ({ ...s, titulares: map[s.id] || [] }));
}
export const listStudents = async (q) => withTitulares(q, await q.query('SELECT * FROM students ORDER BY id'));
export async function getStudent(q, id) { return (await withTitulares(q, await q.query('SELECT * FROM students WHERE id=$1', [id])))[0] || null; }
export async function studentsOfPerson(q, personId) {
  return withTitulares(q, await q.query('SELECT s.* FROM students s JOIN guardianships g ON g.student_id = s.id WHERE g.person_id=$1 ORDER BY s.id', [personId]));
}

/* ---------- requests ---------- */
async function hydrateRequests(q, rows) {
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
export async function listRequests(q, { studentIds, date, kind, status } = {}) {
  const where = [], params = [];
  if (studentIds) { if (!studentIds.length) return []; where.push(`student_id IN (${marks(studentIds.length, params.length + 1)})`); params.push(...studentIds); }
  if (date) { params.push(date); where.push(`date=$${params.length}`); }
  if (kind) { params.push(kind); where.push(`kind=$${params.length}`); }
  if (status) { params.push(status); where.push(`status=$${params.length}`); }
  const sql = 'SELECT * FROM requests' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC, id DESC';
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
export async function listNotifications(q, target) {
  const params = []; const w = targetWhere(target, params);
  return all(await q.query(`SELECT * FROM notifications WHERE ${w} ORDER BY created_at, seq`, params)).map((n) => ({ ...n, ts: n.createdAt, read: !!n.readAt }));
}
export async function markNotificationsRead(q, target, at) {
  const params = [at.toISOString()]; const w = targetWhere(target, params);
  await q.query(`UPDATE notifications SET read_at=$1 WHERE read_at IS NULL AND ${w}`, params);
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
export async function countPendingOut(q, chatKey, at) {
  const r = await q.query("SELECT count(*)::int AS c FROM chat_messages WHERE chat_key=$1 AND direction='out' AND pending_until > $2", [chatKey, at.toISOString()]);
  return r[0].c;
}
export async function getConversation(q, key) { const r = one(await q.query('SELECT * FROM conversation_state WHERE chat_key=$1', [key])); return r ? { step: r.step, requestId: r.requestId, draft: r.draft } : null; }
export async function setConversation(q, key, state, at) {
  await q.query('INSERT INTO conversation_state(chat_key, step, request_id, draft, updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (chat_key) DO UPDATE SET step=EXCLUDED.step, request_id=EXCLUDED.request_id, draft=EXCLUDED.draft, updated_at=EXCLUDED.updated_at',
    [key, state.step, state.requestId || null, JSON.stringify(state.draft || null), at.toISOString()]);
}
export const clearConversation = (q, key) => q.query('DELETE FROM conversation_state WHERE chat_key=$1', [key]);
export async function listConversations(q) {
  const out = {};
  for (const r of all(await q.query('SELECT * FROM conversation_state'))) out[r.chatKey] = { step: r.step, requestId: r.requestId, draft: r.draft };
  return out;
}

/* ---------- audit ---------- */
export const insertAudit = (q, row) => insertRow(q, 'audit_log', row);
/* The visible bitácora: only rows written by logEvent (summary), not the per-command rows the runner adds. */
export const listAudit = async (q, limit = 500) => all(await q.query('SELECT * FROM audit_log WHERE summary IS NOT NULL ORDER BY id DESC LIMIT $1', [limit])).map((a) => ({ ...a, ts: a.at, actor: a.actorName, text: a.summary }));

/* ---------- bus ---------- */
export async function listRoutes(q) {
  const routes = all(await q.query('SELECT * FROM routes ORDER BY id'));
  const stops = all(await q.query('SELECT * FROM stops ORDER BY route_id, position'));
  return routes.map((r) => ({ ...r, monitorId: r.monitorStaffId, stops: stops.filter((s) => s.routeId === r.id) }));
}
export async function getRoute(q, id) { return (await listRoutes(q)).find((r) => r.id === id) || null; }
async function hydrateTrips(q, rows) {
  if (!rows.length) return [];
  const ids = rows.map((t) => t.id);
  const b = await q.query(`SELECT * FROM trip_boardings WHERE trip_id IN (${marks(ids.length)})`, ids);
  const o = await q.query(`SELECT * FROM bus_opt_outs WHERE trip_id IN (${marks(ids.length)}) ORDER BY at`, ids);
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
