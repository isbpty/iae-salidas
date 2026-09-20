/* Lecturas del registro de actividad para el panel del super admin: resumen agregado, línea de
   tiempo paginada y exportación CSV. Todo sale de activity_events con SQL; nada se agrega en memoria
   salvo la lista final. */
import { listTesters } from './testers.js';

export const SESSION_GAP_MIN = 10;
export const ONLINE_MS = 2 * 60 * 1000;
const MAX_EVENTS = 200;
const MAX_EXPORT = 20000;

/* Filtros comunes → cláusula WHERE parametrizada. `testerId: 'shared'` = sesiones con el PIN compartido. */
function where(f = {}, params = [], alias = '') {
  const c = ['1=1'];
  const add = (sql, v) => { params.push(v); c.push(sql.replace('?', '$' + params.length)); };
  const col = (name) => alias + name;
  if (f.from) add(col('at') + ' >= ?', new Date(f.from).toISOString());
  if (f.to) add(col('at') + ' <= ?', new Date(f.to).toISOString());
  if (f.testerId === 'shared') c.push(col('tester_id') + ' IS NULL');
  else if (f.testerId) add(col('tester_id') + ' = ?', f.testerId);
  if (f.userId) add(col('user_id') + ' = ?', f.userId);
  if (f.role) add(col('role') + ' = ?', f.role);
  if (f.sid) add(col('sid') + ' = ?', f.sid);
  if (f.kind) add(col('kind') + ' = ?', f.kind);
  if (f.source) add(col('source') + ' = ?', f.source);
  if (f.errorsOnly) c.push(`(${col('ok')} = false OR ${col('kind')} IN ('js_error','promise_rejection'))`);
  if (f.q) {
    params.push('%' + String(f.q).replace(/[%_\\]/g, (m) => '\\' + m) + '%');
    const n = '$' + params.length;
    c.push(`(${col('name')} ILIKE ${n} OR ${col('screen')} ILIKE ${n} OR ${col('error')} ILIKE ${n} OR ${col('user_id')} ILIKE ${n} OR ${col('data')}::text ILIKE ${n})`);
  }
  return c.join(' AND ');
}
const num = (v) => (v == null ? 0 : Number(v));
const ms = (v) => Math.round(num(v));

/* Sesiones: un `sid` se parte en segmentos cuando pasan más de SESSION_GAP_MIN minutos sin eventos. */
async function sessionRows(q, f) {
  const params = [];
  const w = where(f, params);
  return q.query(`
    WITH e AS (
      SELECT tester_id, sid, user_id, at, lag(at) OVER (PARTITION BY sid ORDER BY at, id) AS prev
      FROM activity_events WHERE ${w} AND sid IS NOT NULL),
    s AS (
      SELECT tester_id, sid, user_id, at,
        sum(CASE WHEN prev IS NULL OR at - prev > interval '${SESSION_GAP_MIN} minutes' THEN 1 ELSE 0 END) OVER (PARTITION BY sid ORDER BY at, at) AS seg
      FROM e)
    SELECT tester_id, sid, seg::int AS seg, min(at) AS started, max(at) AS ended, count(*)::int AS events,
      (EXTRACT(EPOCH FROM (max(at) - min(at))) * 1000)::bigint AS active_ms,
      array_agg(DISTINCT user_id) AS users
    FROM s GROUP BY tester_id, sid, seg ORDER BY started DESC`, params);
}

export async function summary(q, f = {}, now = new Date()) {
  const sessions = await sessionRows(q, f);
  const testers = await listTesters(q);
  const names = new Map(testers.map((t) => [t.id, t.name]));
  const testerName = (id) => (id ? names.get(id) || id : 'Compartido');

  const params = [];
  const w = where(f, params);
  const [last] = [await q.query(`SELECT coalesce(tester_id, '') AS tid, max(at) AS last_at,
      sum(CASE WHEN kind = 'command' AND ok THEN 1 ELSE 0 END)::int AS actions,
      sum(CASE WHEN ok = false OR kind IN ('js_error','promise_rejection') THEN 1 ELSE 0 END)::int AS errors,
      count(*)::int AS events
    FROM activity_events WHERE ${w} GROUP BY 1`, params)];
  const byTester = new Map(last.map((r) => [r.tid, r]));
  const sessionsOf = new Map();
  for (const s of sessions) {
    const key = s.tester_id || '';
    const cur = sessionsOf.get(key) || { sessions: 0, activeMs: 0 };
    cur.sessions += 1; cur.activeMs += ms(s.active_ms);
    sessionsOf.set(key, cur);
  }
  const ids = new Set([...testers.map((t) => t.id), ...byTester.keys()]);
  if (!f.testerId || f.testerId === 'shared') ids.add('');
  const testerList = [...ids].map((id) => {
    const l = byTester.get(id) || {}; const s = sessionsOf.get(id) || { sessions: 0, activeMs: 0 };
    const lastAt = l.last_at ? new Date(l.last_at) : null;
    const t = testers.find((x) => x.id === id);
    return { id: id || 'shared', name: testerName(id || null), super: !!(t && t.super), active: t ? t.active : true, lastAt: lastAt ? lastAt.toISOString() : null,
      sessions: s.sessions, activeMs: s.activeMs, actions: num(l.actions), errors: num(l.errors), events: num(l.events), online: !!lastAt && now.getTime() - lastAt.getTime() < ONLINE_MS };
  }).sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || '') || (parseInt(a.id.slice(1), 10) || 999) - (parseInt(b.id.slice(1), 10) || 999));

  const p2 = []; const w2 = where(f, p2);
  const screens = (await q.query(`SELECT screen, count(*)::int AS visits, coalesce(sum(duration_ms), 0)::bigint AS total_ms
    FROM activity_events WHERE ${w2} AND kind IN ('screen_leave','modal_close') AND screen IS NOT NULL GROUP BY screen ORDER BY total_ms DESC LIMIT 60`, p2))
    .map((r) => ({ screen: r.screen, visits: num(r.visits), totalMs: ms(r.total_ms) }));
  const p3 = []; const w3 = where(f, p3);
  const actions = (await q.query(`SELECT name, count(*)::int AS count,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
      max(duration_ms) AS max, sum(CASE WHEN ok = false THEN 1 ELSE 0 END)::int AS errors
    FROM activity_events WHERE ${w3} AND kind = 'command' GROUP BY name ORDER BY count DESC LIMIT 100`, p3))
    .map((r) => ({ name: r.name, count: num(r.count), p50: ms(r.p50), p95: ms(r.p95), max: ms(r.max), errors: num(r.errors) }));
  const p4 = []; const w4 = where(f, p4);
  const clicks = (await q.query(`SELECT name, count(*)::int AS count FROM activity_events WHERE ${w4} AND kind = 'click' GROUP BY name ORDER BY count DESC LIMIT 60`, p4))
    .map((r) => ({ name: r.name, count: num(r.count) }));
  const p5 = []; const w5 = where(f, p5);
  const errors = (await q.query(`SELECT coalesce(error, '?') AS error, kind, name, count(*)::int AS count, max(at) AS last_at, array_agg(DISTINCT coalesce(tester_id, '')) AS testers
    FROM activity_events WHERE ${w5} AND (ok = false OR kind IN ('js_error','promise_rejection')) GROUP BY error, kind, name ORDER BY count DESC, last_at DESC LIMIT 100`, p5))
    .map((r) => ({ error: r.error, kind: r.kind, name: r.name, count: num(r.count), lastAt: new Date(r.last_at).toISOString(), testers: (r.testers || []).map((id) => testerName(id || null)) }));
  const p6 = []; const w6 = where(f, p6);
  const abandons = (await q.query(`SELECT name, count(*)::int AS count FROM activity_events WHERE ${w6} AND kind = 'form_abandon' GROUP BY name ORDER BY count DESC LIMIT 30`, p6))
    .map((r) => ({ name: r.name, count: num(r.count) }));
  const p7 = []; const w7 = where(f, p7);
  const [tot] = await q.query(`SELECT count(*)::int AS events FROM activity_events WHERE ${w7}`, p7);
  return {
    generatedAt: now.toISOString(), sessionGapMin: SESSION_GAP_MIN,
    testers: testerList, screens, actions, clicks, errors, abandons,
    sessions: sessions.slice(0, 200).map((s) => ({ testerId: s.tester_id || 'shared', tester: testerName(s.tester_id), sid: s.sid, seg: num(s.seg), started: new Date(s.started).toISOString(), ended: new Date(s.ended).toISOString(), events: num(s.events), activeMs: ms(s.active_ms), users: s.users || [] })),
    totals: { events: num(tot.events), sessions: sessions.length, activeMs: sessions.reduce((a, s) => a + ms(s.active_ms), 0) },
  };
}

const row = (r) => ({
  id: Number(r.id), at: new Date(r.at).toISOString(), testerId: r.tester_id, userId: r.user_id, role: r.role, sid: r.sid, source: r.source, kind: r.kind,
  name: r.name, screen: r.screen, target: r.target, durationMs: r.duration_ms, ok: r.ok, error: r.error, status: r.status, revision: r.revision, ip: r.ip, ua: r.ua, data: r.data,
});
export async function events(q, f = {}) {
  const params = [];
  let w = where(f, params);
  if (f.before) { params.push(Number(f.before)); w += ` AND id < $${params.length}`; }
  const limit = Math.max(1, Math.min(MAX_EVENTS, Number(f.limit) || 100));
  params.push(limit + 1);
  const rows = await q.query(`SELECT * FROM activity_events WHERE ${w} ORDER BY id DESC LIMIT $${params.length}`, params);
  const page = rows.slice(0, limit).map(row);
  return { events: page, nextBefore: rows.length > limit ? page[page.length - 1].id : null };
}

const COLS = ['id', 'at', 'testerId', 'userId', 'role', 'sid', 'source', 'kind', 'name', 'screen', 'target', 'durationMs', 'ok', 'error', 'status', 'revision', 'ip', 'data'];
const cell = (v) => { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export async function exportCsv(q, f = {}) {
  const params = [];
  const w = where(f, params);
  params.push(MAX_EXPORT);
  const rows = await q.query(`SELECT * FROM activity_events WHERE ${w} ORDER BY id LIMIT $${params.length}`, params);
  return [COLS.join(','), ...rows.map(row).map((r) => COLS.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}
