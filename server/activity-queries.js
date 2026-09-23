/* Lecturas del registro de actividad para el panel del super admin: resumen agregado, línea de
   tiempo paginada y exportación CSV. Todo sale de activity_events con SQL; nada se agrega en memoria
   salvo la lista final. */
import { listTesters } from './testers.js';
import { HttpError } from './domain/errors.js';

export const SESSION_GAP_MIN = 10;
export const ONLINE_MS = 2 * 60 * 1000;
const MAX_EVENTS = 200;
const MAX_EXPORT = 20000;

/* S12: `new Date(f.from).toISOString()` lanzaba RangeError (→ 500) con una fecha inválida; ahora es un
   400 invalid_range explícito, igual que cualquier otro dato de entrada mal formado. */
function parseFilterDate(v) {
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new HttpError(400, 'invalid_range');
  return d.toISOString();
}
/* Filtros comunes → cláusula WHERE parametrizada. `testerId: 'shared'` = sesiones con el PIN compartido. */
function where(f = {}, params = [], alias = '') {
  const c = ['1=1'];
  const add = (sql, v) => { params.push(v); c.push(sql.replace('?', '$' + params.length)); };
  const col = (name) => alias + name;
  if (f.from) add(col('at') + ' >= ?', parseFilterDate(f.from));
  if (f.to) add(col('at') + ' <= ?', parseFilterDate(f.to));
  if (f.testerId === 'shared') c.push(col('tester_id') + ' IS NULL');
  else if (f.testerId) add(col('tester_id') + ' = ?', f.testerId);
  if (f.userId) add(col('user_id') + ' = ?', f.userId);
  if (f.role) add(col('role') + ' = ?', f.role);
  if (f.sid) add(col('sid') + ' = ?', f.sid);
  if (f.kind) add(col('kind') + ' = ?', f.kind);
  if (f.source) add(col('source') + ' = ?', f.source);
  /* S12: `errorsOnly=false` (string) es verdadero para cualquier string no vacío; solo 'true'/'1' activan
     el filtro. S7: el lado "ok = false" solo cuenta si el evento es del servidor -- un cliente ya no puede
     mandar `kind: 'command'` (lista blanca en activity.js), pero una fila `ok: false` de otro kind de
     cliente tampoco debe aparecer como error del servidor. */
  if (f.errorsOnly === 'true' || f.errorsOnly === '1') c.push(`((${col('ok')} = false AND ${col('source')} = 'server') OR ${col('kind')} IN ('js_error','promise_rejection'))`);
  if (f.q) {
    params.push('%' + String(f.q).replace(/[%_\\]/g, (m) => '\\' + m) + '%');
    const n = '$' + params.length;
    c.push(`(${col('name')} ILIKE ${n} OR ${col('screen')} ILIKE ${n} OR ${col('error')} ILIKE ${n} OR ${col('user_id')} ILIKE ${n} OR ${col('data')}::text ILIKE ${n})`);
  }
  return c.join(' AND ');
}
const num = (v) => (v == null ? 0 : Number(v));
const ms = (v) => Math.round(num(v));

/* Sesiones: un `sid` se parte en segmentos cuando pasan más de SESSION_GAP_MIN minutos sin eventos. Arrastra
   también la última IP/geolocalización del segmento y la huella (`session_start`) más reciente, para que
   /super pueda mostrar desde dónde y con qué se conectó cada sesión (Task 15). */
async function sessionRows(q, f) {
  const params = [];
  const w = where(f, params);
  return q.query(`
    WITH e AS (
      SELECT tester_id, sid, user_id, at, ip, ua, data, kind,
        lag(at) OVER (PARTITION BY sid ORDER BY at, id) AS prev
      FROM activity_events WHERE ${w} AND sid IS NOT NULL),
    s AS (
      SELECT tester_id, sid, user_id, at, ip, ua, data, kind,
        sum(CASE WHEN prev IS NULL OR at - prev > interval '${SESSION_GAP_MIN} minutes' THEN 1 ELSE 0 END) OVER (PARTITION BY sid ORDER BY at, at) AS seg
      FROM e)
    SELECT tester_id, sid, seg::int AS seg, min(at) AS started, max(at) AS ended, count(*)::int AS events,
      (EXTRACT(EPOCH FROM (max(at) - min(at))) * 1000)::bigint AS active_ms,
      array_agg(DISTINCT user_id) AS users,
      (array_agg(ip ORDER BY at DESC) FILTER (WHERE ip IS NOT NULL))[1] AS last_ip,
      (array_agg(data->'geo' ORDER BY at DESC) FILTER (WHERE data->'geo' IS NOT NULL))[1] AS last_geo,
      (array_agg(ua ORDER BY at DESC) FILTER (WHERE kind = 'session_start'))[1] AS device_ua,
      (array_agg(data ORDER BY at DESC) FILTER (WHERE kind = 'session_start'))[1] AS device_data
    FROM s GROUP BY tester_id, sid, seg ORDER BY started DESC`, params);
}

/* "Chrome" / "Safari" / … a partir del user-agent; solo para una etiqueta legible en /super, nunca para
   decisiones de seguridad (por eso vive aquí y no en auth.js). */
function browserOf(ua) {
  if (!ua) return null;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/CriOS\//.test(ua)) return 'Chrome iOS';
  if (/FxiOS\//.test(ua)) return 'Firefox iOS';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari';
  return 'Navegador';
}
/* "iPhone · Safari · 390×844": plataforma + navegador + pantalla, a partir de la huella (`session_start`,
   ver activity.js/telemetry.js) y el user-agent de ese mismo evento. `null` cuando no hay ninguna huella. */
function deviceLabel(ua, data) {
  if (!ua && !data) return null;
  const d = data || {};
  const platform = d.platform || (d.uaData && d.uaData.platform) || null;
  const browser = browserOf(ua);
  const w = d.screenWidth || d.width, h = d.screenHeight || d.height;
  const screenTxt = w && h ? w + '×' + h : null;
  return [platform, browser, screenTxt].filter(Boolean).join(' · ') || null;
}

export async function summary(q, f = {}, now = new Date()) {
  const sessions = await sessionRows(q, f);
  const testers = await listTesters(q);
  const names = new Map(testers.map((t) => [t.id, t.name]));
  const testerName = (id) => (id ? names.get(id) || id : 'Compartido');

  const params = [];
  const w = where(f, params);
  /* S7: solo un evento realmente del servidor (source='server') cuenta como "acción" o como "error del
     servidor"; un `kind` de cliente falso ya no pasa la lista blanca de activity.js, pero esto además cubre
     filas antiguas y cualquier otro kind con `ok: false` que un cliente pudiera mandar. */
  const [last] = [await q.query(`SELECT coalesce(tester_id, '') AS tid, max(at) AS last_at,
      sum(CASE WHEN kind = 'command' AND ok AND source = 'server' THEN 1 ELSE 0 END)::int AS actions,
      sum(CASE WHEN (ok = false AND source = 'server') OR kind IN ('js_error','promise_rejection') THEN 1 ELSE 0 END)::int AS errors,
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
  /* Última IP/geolocalización conocida por probador (cualquier evento con IP), su última huella de
     dispositivo (el `session_start` más reciente) y la lista de huellas distintas que ha usado, con
     primera y última vez (Task 15: "Dispositivos" en /super). */
  const p9 = []; const w9 = where(f, p9);
  /* La IP más reciente y la geo más reciente no siempre vienen del mismo evento (un `session_start` puede
     ser más nuevo que el `login` que sí trae geo): cada una se toma por separado con FILTER, no con un solo
     DISTINCT ON que se quedaría con la fila más nueva aunque no tenga geo. */
  const infoByTester = new Map((await q.query(`
    SELECT coalesce(tester_id, '') AS tid,
      (array_agg(ip ORDER BY at DESC) FILTER (WHERE ip IS NOT NULL))[1] AS ip,
      (array_agg(data->'geo' ORDER BY at DESC) FILTER (WHERE data->'geo' IS NOT NULL))[1] AS geo
    FROM activity_events WHERE ${w9} GROUP BY 1`, p9))
    .map((r) => [r.tid, r]));
  const p10 = []; const w10 = where(f, p10);
  const deviceByTester = new Map((await q.query(`
    SELECT DISTINCT ON (coalesce(tester_id, '')) coalesce(tester_id, '') AS tid, ua, data
    FROM activity_events WHERE ${w10} AND kind = 'session_start' ORDER BY coalesce(tester_id, ''), at DESC`, p10))
    .map((r) => [r.tid, deviceLabel(r.ua, r.data)]));
  const p11 = []; const w11 = where(f, p11);
  const devicesByTester = new Map();
  for (const r of await q.query(`
    SELECT coalesce(tester_id, '') AS tid, fp, min(at) AS first_at, max(at) AS last_at, count(*)::int AS events,
      (array_agg(ua ORDER BY at DESC))[1] AS ua, (array_agg(data ORDER BY at DESC))[1] AS data
    FROM activity_events WHERE ${w11} AND kind = 'session_start' AND fp IS NOT NULL GROUP BY 1, 2 ORDER BY 1, last_at DESC`, p11)) {
    const list = devicesByTester.get(r.tid) || [];
    list.push({ fp: r.fp, label: deviceLabel(r.ua, r.data), firstAt: new Date(r.first_at).toISOString(), lastAt: new Date(r.last_at).toISOString(), events: num(r.events) });
    devicesByTester.set(r.tid, list);
  }

  const ids = new Set([...testers.map((t) => t.id), ...byTester.keys()]);
  if (!f.testerId || f.testerId === 'shared') ids.add('');
  const testerList = [...ids].map((id) => {
    const l = byTester.get(id) || {}; const s = sessionsOf.get(id) || { sessions: 0, activeMs: 0 };
    const lastAt = l.last_at ? new Date(l.last_at) : null;
    const t = testers.find((x) => x.id === id);
    const info = infoByTester.get(id) || {};
    return { id: id || 'shared', name: testerName(id || null), super: !!(t && t.super), active: t ? t.active : true, lastAt: lastAt ? lastAt.toISOString() : null,
      sessions: s.sessions, activeMs: s.activeMs, actions: num(l.actions), errors: num(l.errors), events: num(l.events), online: !!lastAt && now.getTime() - lastAt.getTime() < ONLINE_MS,
      lastIp: info.ip || null, lastGeo: info.geo || null, lastDevice: deviceByTester.get(id) || null, devices: devicesByTester.get(id) || [] };
  }).sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || '') || (parseInt(a.id.slice(1), 10) || 999) - (parseInt(b.id.slice(1), 10) || 999));

  const p2 = []; const w2 = where(f, p2);
  const screens = (await q.query(`SELECT screen, count(*)::int AS visits, coalesce(sum(duration_ms), 0)::bigint AS total_ms
    FROM activity_events WHERE ${w2} AND kind IN ('screen_leave','modal_close') AND screen IS NOT NULL GROUP BY screen ORDER BY total_ms DESC LIMIT 60`, p2))
    .map((r) => ({ screen: r.screen, visits: num(r.visits), totalMs: ms(r.total_ms) }));
  const p3 = []; const w3 = where(f, p3);
  const actions = (await q.query(`SELECT name, count(*)::int AS count,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
      max(duration_ms) AS max, sum(CASE WHEN ok = false THEN 1 ELSE 0 END)::int AS errors
    FROM activity_events WHERE ${w3} AND kind = 'command' AND source = 'server' GROUP BY name ORDER BY count DESC LIMIT 100`, p3))
    .map((r) => ({ name: r.name, count: num(r.count), p50: ms(r.p50), p95: ms(r.p95), max: ms(r.max), errors: num(r.errors) }));
  const p4 = []; const w4 = where(f, p4);
  const clicks = (await q.query(`SELECT name, count(*)::int AS count FROM activity_events WHERE ${w4} AND kind = 'click' GROUP BY name ORDER BY count DESC LIMIT 60`, p4))
    .map((r) => ({ name: r.name, count: num(r.count) }));
  const p5 = []; const w5 = where(f, p5);
  const errors = (await q.query(`SELECT coalesce(error, '?') AS error, kind, name, count(*)::int AS count, max(at) AS last_at, array_agg(DISTINCT coalesce(tester_id, '')) AS testers
    FROM activity_events WHERE ${w5} AND ((ok = false AND source = 'server') OR kind IN ('js_error','promise_rejection')) GROUP BY error, kind, name ORDER BY count DESC, last_at DESC LIMIT 100`, p5))
    .map((r) => ({ error: r.error, kind: r.kind, name: r.name, count: num(r.count), lastAt: new Date(r.last_at).toISOString(), testers: (r.testers || []).map((id) => testerName(id || null)) }));
  const p6 = []; const w6 = where(f, p6);
  const abandons = (await q.query(`SELECT name, count(*)::int AS count FROM activity_events WHERE ${w6} AND kind = 'form_abandon' GROUP BY name ORDER BY count DESC LIMIT 30`, p6))
    .map((r) => ({ name: r.name, count: num(r.count) }));
  const p7 = []; const w7 = where(f, p7);
  const [tot] = await q.query(`SELECT count(*)::int AS events FROM activity_events WHERE ${w7}`, p7);
  /* Uso del simulador por probador: arranques, recorridos completos, salidas a mitad, pausas, paso a paso, velocidad. */
  const p8 = []; const w8 = where(f, p8);
  const simRows = await q.query(`SELECT coalesce(tester_id, '') AS tid,
      sum(CASE WHEN name = 'start' THEN 1 ELSE 0 END)::int AS runs,
      sum(CASE WHEN name = 'end' AND data->>'completed' = 'true' THEN 1 ELSE 0 END)::int AS completed,
      sum(CASE WHEN name = 'exit' THEN 1 ELSE 0 END)::int AS exited,
      sum(CASE WHEN name = 'pause' THEN 1 ELSE 0 END)::int AS pauses,
      sum(CASE WHEN name = 'step_mode' THEN 1 ELSE 0 END)::int AS step_mode,
      sum(CASE WHEN name = 'speed' THEN 1 ELSE 0 END)::int AS speed_changes,
      sum(CASE WHEN name = 'start' AND data->>'reset' = 'true' THEN 1 ELSE 0 END)::int AS resets,
      max(CASE WHEN name = 'end' THEN (data->>'stepsDone')::int END) AS max_step,
      coalesce(sum(CASE WHEN name = 'end' THEN duration_ms ELSE 0 END), 0)::bigint AS total_ms,
      max(at) AS last_at
    FROM activity_events WHERE ${w8} AND kind = 'simulator' GROUP BY 1 ORDER BY runs DESC`, p8);
  const simulator = simRows.map((r) => ({ id: r.tid || 'shared', name: testerName(r.tid || null), runs: num(r.runs), completed: num(r.completed), exited: num(r.exited), pauses: num(r.pauses),
    stepMode: num(r.step_mode), speedChanges: num(r.speed_changes), resets: num(r.resets), maxStep: r.max_step == null ? null : num(r.max_step), totalMs: ms(r.total_ms), lastAt: new Date(r.last_at).toISOString() }));
  return {
    generatedAt: now.toISOString(), sessionGapMin: SESSION_GAP_MIN,
    testers: testerList, screens, actions, clicks, errors, abandons, simulator,
    sessions: sessions.slice(0, 200).map((s) => ({ testerId: s.tester_id || 'shared', tester: testerName(s.tester_id), sid: s.sid, seg: num(s.seg), started: new Date(s.started).toISOString(), ended: new Date(s.ended).toISOString(), events: num(s.events), activeMs: ms(s.active_ms), users: s.users || [],
      lastIp: s.last_ip || null, lastGeo: s.last_geo || null, lastDevice: deviceLabel(s.device_ua, s.device_data) })),
    totals: { events: num(tot.events), sessions: sessions.length, activeMs: sessions.reduce((a, s) => a + ms(s.active_ms), 0) },
  };
}

const row = (r) => {
  const geo = r.data && typeof r.data === 'object' && r.data.geo ? r.data.geo : null;
  return {
    id: Number(r.id), at: new Date(r.at).toISOString(), testerId: r.tester_id, userId: r.user_id, role: r.role, sid: r.sid, source: r.source, kind: r.kind,
    name: r.name, screen: r.screen, target: r.target, durationMs: r.duration_ms, ok: r.ok, error: r.error, status: r.status, revision: r.revision,
    ip: r.ip, city: geo ? geo.city : null, country: geo ? geo.country : null, fp: r.fp || null, ua: r.ua, data: r.data,
  };
};
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

const COLS = ['id', 'at', 'testerId', 'userId', 'role', 'sid', 'source', 'kind', 'name', 'screen', 'target', 'durationMs', 'ok', 'error', 'status', 'revision', 'ip', 'city', 'country', 'fp', 'data'];
/* S8: una celda que empiece con `=`, `+`, `-`, `@`, tab o CR se interpreta como fórmula al abrirla en Excel/
   Sheets (inyección de fórmulas); anteponerle un apóstrofo la deja como texto sin cambiar lo que se ve. */
const cell = (v) => {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export async function exportCsv(q, f = {}) {
  const params = [];
  const w = where(f, params);
  params.push(MAX_EXPORT);
  const rows = await q.query(`SELECT * FROM activity_events WHERE ${w} ORDER BY id LIMIT $${params.length}`, params);
  return [COLS.join(','), ...rows.map(row).map((r) => COLS.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}
