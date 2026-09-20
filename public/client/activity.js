/* Panel "Actividad" (solo super admin): qué hace cada probador, cuánto tiempo, dónde se atasca.
   Lee GET /api/activity/* por su cuenta (no viaja en la vista) y refresca cada 10 s mientras está abierto. */
const ACT = { range: 'today', from: '', to: '', testerId: '', userId: '', role: '', errorsOnly: false, q: '', sid: '', kind: '',
  summary: null, events: [], nextBefore: null, loading: false, seq: 0, error: null, timer: null, newPin: null, showTesters: false, testers: null };
const ACT_KINDS = ['', 'command', 'view', 'login', 'login_failed', 'switch_user', 'logout', 'attachment', 'screen_enter', 'screen_leave', 'modal_open', 'modal_close', 'click', 'form_submit', 'form_abandon', 'js_error', 'promise_rejection', 'visibility', 'session_start', 'session_end'];

function actRange() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (ACT.range === 'today') return { from: d.toISOString(), to: '' };
  if (ACT.range === '7d') return { from: new Date(d.getTime() - 6 * 86400000).toISOString(), to: '' };
  if (ACT.range === '30d') return { from: new Date(d.getTime() - 29 * 86400000).toISOString(), to: '' };
  return { from: ACT.from ? new Date(ACT.from + 'T00:00:00').toISOString() : '', to: ACT.to ? new Date(ACT.to + 'T23:59:59').toISOString() : '' };
}
function actParams(extra = {}) {
  const r = actRange();
  const p = { from: r.from, to: r.to, testerId: ACT.testerId, userId: ACT.userId, role: ACT.role, errorsOnly: ACT.errorsOnly ? '1' : '', ...extra };
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== '' && v != null) u.set(k, v);
  return u;
}
function actTyping() { const a = document.activeElement; return !!(a && a.closest && a.closest('#actPanel') && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)); }
async function activityLoad(more = false) {
  if (!ME || !ME.super) return;
  const seq = ++ACT.seq; ACT.loading = true;
  try {
    const timeline = actParams({ q: ACT.q, sid: ACT.sid, kind: ACT.kind, limit: 100, before: more ? ACT.nextBefore : '' });
    const [s, e, testers] = await Promise.all([api.activity('summary', actParams()), api.activity('events', timeline), ACT.showTesters ? api.activity('testers') : Promise.resolve(ACT.testers)]);
    if (seq !== ACT.seq) return;
    ACT.summary = s; ACT.testers = testers;
    ACT.events = more ? ACT.events.concat(e.events) : e.events; ACT.nextBefore = e.nextBefore; ACT.error = null;
  } catch (err) { if (seq === ACT.seq) ACT.error = err.message; }
  finally { if (seq !== ACT.seq) return; ACT.loading = false; if (UI.view === 'school' && UI.schoolTab === 'actividad' && !formOpen() && !actTyping()) render(); }
}
function activityTimer(on) {
  if (on && !ACT.timer) ACT.timer = setInterval(() => { if (UI.view === 'school' && UI.schoolTab === 'actividad' && !document.hidden) activityLoad(); }, 10000);
  if (!on && ACT.timer) { clearInterval(ACT.timer); ACT.timer = null; }
}
const fmtDur = (ms) => {
  ms = Math.max(0, Math.round(ms || 0));
  if (ms < 1000) return ms + ' ms';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ' + pad(s % 60) + ' s';
  return Math.floor(m / 60) + ' h ' + pad(m % 60) + ' min';
};
const fmtAgo = (iso) => {
  if (!iso) return 'nunca';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'hace ' + s + ' s';
  if (s < 3600) return 'hace ' + Math.floor(s / 60) + ' min';
  if (s < 86400) return 'hace ' + Math.floor(s / 3600) + ' h';
  return fmtTs(iso);
};
const fmtClockS = (iso) => { const d = new Date(iso); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
const actUserName = (id) => { const u = (V.users || []).find((x) => x.id === id); return u ? u.name : id || '—'; };
const bar = (v, max, cls = '') => '<div class="bar"><div class="bar-fill ' + cls + '" style="width:' + (max ? Math.max(2, Math.round(100 * v / max)) : 0) + '%"></div></div>';
const KIND_ICON = { command: '⚡', view: '👁', login: '🔑', login_failed: '⛔', switch_user: '🔁', logout: '🚪', attachment: '🖼', screen_enter: '➡️', screen_leave: '⬅️', modal_open: '🗔', modal_close: '🗙', click: '🖱', form_submit: '✅', form_abandon: '🚫', js_error: '💥', promise_rejection: '💥', visibility: '👀', session_start: '▶', session_end: '⏹', pin: '🔢', other: '·' };

function activityView() {
  activityTimer(true);
  if (!ACT.summary && !ACT.loading && !ACT.error) activityLoad();
  const s = ACT.summary;
  const chip = (k, l) => '<button class="chip' + (ACT.range === k ? ' active' : '') + '" data-action="actRange" data-range="' + k + '">' + l + '</button>';
  const sel = (name, value, options, all) => '<select data-change="' + name + '"><option value="">' + all + '</option>' + options.map(([v, l]) => '<option value="' + esc(v) + '"' + (value === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>';
  const testerOpts = (s ? s.testers : []).map((t) => [t.id, t.name]);
  const userOpts = (V.users || []).map((u) => [u.id, u.name + ' · ' + roleName(u.role)]);
  const roleOpts = ['parent', 'admin', 'recepcion', 'profesor', 'garita', 'monitora'].map((r) => [r, roleName(r)]);
  let h = '<div id="actPanel"><h2>📊 Actividad <span class="muted small">' + (ACT.loading ? 'actualizando…' : s ? 'actualizado ' + fmtClockS(s.generatedAt) : '') + '</span>' +
    '<span class="right"><button class="btn small" data-action="actRefresh">↻ Actualizar</button> <button class="btn small" data-action="actExport">⬇ Exportar CSV</button> <button class="btn small' + (ACT.showTesters ? ' primary' : '') + '" data-action="actTesters">🔐 Probadores y PINs</button></span></h2>' +
    '<div class="filters">' + chip('today', 'Hoy') + chip('7d', '7 días') + chip('30d', '30 días') + chip('custom', 'Rango') +
    (ACT.range === 'custom' ? ' <input type="date" data-change="actFrom" value="' + esc(ACT.from) + '"> <input type="date" data-change="actTo" value="' + esc(ACT.to) + '">' : '') +
    sel('actTester', ACT.testerId, testerOpts, 'Todos los probadores') + sel('actUser', ACT.userId, userOpts, 'Todos los usuarios') + sel('actRole', ACT.role, roleOpts, 'Todos los roles') +
    '<label class="check small"><input type="checkbox" data-change="actErrors"' + (ACT.errorsOnly ? ' checked' : '') + '> Solo errores</label></div>';
  if (ACT.error) h += '<div class="empty danger-text">No se pudo cargar la actividad: ' + esc(ACT.error) + '</div>';
  if (ACT.showTesters) h += actTestersBlock();
  if (!s) return h + (ACT.loading ? '<div class="empty">Cargando…</div>' : '') + '</div>';
  const errs = s.errors.reduce((a, e) => a + e.count, 0);
  h += '<div class="kpis">' + kpi('eventos', s.totals.events) + kpi('sesiones', s.totals.sessions) + kpi('tiempo activo total', fmtDur(s.totals.activeMs)) + kpi('errores', errs, errs ? 'warn' : 'ok') + '</div>';
  h += actTestersCards(s) + actHotspots(s) + actSessions(s) + actTimeline();
  return h + '</div>';
}
function actTestersCards(s) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return '<div class="section-title">Probadores</div><div class="act-grid">' + s.testers.map((t) => {
    const state = t.online ? 'on' : t.lastAt && new Date(t.lastAt) >= today ? 'today' : 'off';
    const label = t.online ? 'activo ahora' : t.lastAt ? 'última actividad ' + fmtAgo(t.lastAt) : 'sin actividad';
    return '<div class="card act-card' + (ACT.testerId === t.id ? ' selected' : '') + '" data-action="actFocus" data-id="' + esc(t.id) + '"><div class="act-head"><span class="act-dot ' + state + '"></span><b>' + esc(t.name) + '</b>' + (t.super ? ' <span class="badge">super</span>' : '') + '</div>' +
      '<div class="small muted">' + label + '</div><div class="act-stats"><span><b>' + t.sessions + '</b> ses.</span><span><b>' + fmtDur(t.activeMs) + '</b></span><span><b>' + t.actions + '</b> acciones</span><span class="' + (t.errors ? 'danger-text' : '') + '"><b>' + t.errors + '</b> errores</span></div></div>';
  }).join('') + '</div>';
}
function actHotspots(s) {
  const maxScreen = Math.max(0, ...s.screens.map((x) => x.totalMs));
  const maxClick = Math.max(0, ...s.clicks.map((x) => x.count));
  const screens = s.screens.length ? '<table class="tbl"><tr><th>Pantalla</th><th>Tiempo</th><th>Visitas</th></tr>' + s.screens.slice(0, 15).map((x) => '<tr><td class="mono small">' + esc(x.screen) + bar(x.totalMs, maxScreen) + '</td><td>' + fmtDur(x.totalMs) + '</td><td>' + x.visits + '</td></tr>').join('') + '</table>' : '<div class="empty">Sin datos de pantallas todavía.</div>';
  const actions = s.actions.length ? '<table class="tbl"><tr><th>Acción</th><th>#</th><th>p50</th><th>p95</th><th>máx</th><th>err</th></tr>' + s.actions.slice(0, 15).map((x) => '<tr><td class="mono small">' + esc(x.name) + '</td><td>' + x.count + '</td><td>' + x.p50 + ' ms</td><td class="' + (x.p95 > 2000 ? 'danger-text' : '') + '">' + x.p95 + ' ms</td><td>' + x.max + ' ms</td><td class="' + (x.errors ? 'danger-text' : '') + '">' + x.errors + '</td></tr>').join('') + '</table>' : '<div class="empty">Sin comandos en el rango.</div>';
  const clicks = s.clicks.length ? '<table class="tbl"><tr><th>Botón</th><th>Clics</th></tr>' + s.clicks.slice(0, 12).map((x) => '<tr><td class="mono small">' + esc(x.name) + bar(x.count, maxClick, 'info') + '</td><td>' + x.count + '</td></tr>').join('') + '</table>' : '<div class="empty">Sin clics registrados.</div>';
  const errors = s.errors.length ? '<table class="tbl"><tr><th>Error</th><th>Dónde</th><th>#</th><th>Último</th><th>Quién</th></tr>' + s.errors.slice(0, 15).map((x) => '<tr><td class="danger-text mono small">' + esc(x.error) + '</td><td class="mono small">' + esc(x.kind) + ' · ' + esc(x.name || '') + '</td><td>' + x.count + '</td><td class="small">' + fmtAgo(x.lastAt) + '</td><td class="small">' + esc(x.testers.join(', ')) + '</td></tr>').join('') + '</table>' : '<div class="empty ok-text">Sin errores en el rango 🎉</div>';
  const abandons = s.abandons.length ? '<table class="tbl"><tr><th>Formulario abandonado</th><th>Veces</th></tr>' + s.abandons.map((x) => '<tr><td class="mono small">' + esc(x.name) + '</td><td>' + x.count + '</td></tr>').join('') + '</table>' : '';
  return '<div class="section-title">Zonas calientes</div><div class="act-cols"><div><h3>Pantallas por tiempo</h3>' + screens + '<h3>Botones más usados</h3>' + clicks + abandons + '</div>' +
    '<div><h3>Acciones y latencia del servidor</h3>' + actions + '<h3>Errores</h3>' + errors + '</div></div>';
}
function actSessions(s) {
  if (!s.sessions.length) return '';
  return '<div class="section-title">Sesiones (corte a ' + s.sessionGapMin + ' min sin actividad)</div><table class="tbl"><tr><th>Probador</th><th>Usuarios</th><th>Inicio</th><th>Duración</th><th>Eventos</th><th></th></tr>' +
    s.sessions.slice(0, 30).map((x) => '<tr class="' + (ACT.sid === x.sid ? 'selected' : '') + '"><td>' + esc(x.tester) + '</td><td class="small">' + esc(x.users.map(actUserName).join(', ')) + '</td><td class="mono small">' + fmtTs(x.started) + '</td><td>' + fmtDur(x.activeMs) + '</td><td>' + x.events + '</td><td><button class="btn tiny" data-action="actSession" data-sid="' + esc(x.sid) + '">' + (ACT.sid === x.sid ? 'Quitar filtro' : 'Ver línea de tiempo') + '</button></td></tr>').join('') + '</table>';
}
function actTimeline() {
  const kinds = ACT_KINDS.map((k) => '<option value="' + k + '"' + (ACT.kind === k ? ' selected' : '') + '>' + (k || 'Todos los tipos') + '</option>').join('');
  let h = '<div class="section-title">Línea de tiempo' + (ACT.sid ? ' · sesión <span class="mono">' + esc(ACT.sid) + '</span>' : '') + '</div>' +
    '<div class="filters"><input type="search" placeholder="Buscar (acción, pantalla, error, usuario, datos…)" data-change="actQ" value="' + esc(ACT.q) + '" style="min-width:280px"><select data-change="actKind">' + kinds + '</select></div>';
  if (!ACT.events.length) return h + '<div class="empty">Sin eventos con estos filtros.</div>';
  h += '<table class="tbl act-events"><tr><th>Hora</th><th>Probador</th><th>Usuario</th><th>Evento</th><th>Pantalla</th><th>Duración</th><th>Resultado</th><th></th></tr>' + ACT.events.map((e) => {
    const bad = e.ok === false || /error|rejection/.test(e.kind);
    const testerName = (ACT.summary.testers.find((t) => t.id === (e.testerId || 'shared')) || {}).name || e.testerId || 'Compartido';
    return '<tr class="' + (bad ? 'bad' : '') + '"><td class="mono small" title="' + esc(e.at) + '">' + fmtClockS(e.at) + '</td><td class="small">' + esc(testerName) + '</td><td class="small">' + esc(actUserName(e.userId)) + (e.role ? '<br><span class="muted">' + esc(roleName(e.role)) + '</span>' : '') + '</td>' +
      '<td class="small">' + (KIND_ICON[e.kind] || '·') + ' <span class="mono">' + esc(e.kind) + '</span> <b>' + esc(e.name || '') + '</b>' + (e.target ? ' <span class="muted">→ ' + esc(e.target) + '</span>' : '') + '</td>' +
      '<td class="mono small">' + esc(e.screen || '') + '</td><td class="small">' + (e.durationMs != null ? fmtDur(e.durationMs) : '') + '</td>' +
      '<td class="small">' + (e.status ? '<span class="mono">' + e.status + '</span> ' : '') + (e.error ? '<span class="danger-text">' + esc(e.error) + '</span>' : e.ok === true ? '✓' : '') + '</td>' +
      '<td><button class="btn tiny" data-action="actCopy" data-id="' + e.id + '" title="Copiar JSON del evento">📋</button></td></tr>';
  }).join('') + '</table>';
  if (ACT.nextBefore) h += '<div class="actions"><button class="btn" data-action="actMore">Cargar más</button></div>';
  return h;
}
function actTestersBlock() {
  const list = ACT.testers || [];
  let h = '<div class="card"><h3>🔐 Probadores y PINs</h3><p class="small muted">Cada probador tiene un PIN de 6 dígitos. El PIN nunca se guarda en claro: al regenerarlo se muestra <b>una sola vez</b>.</p>';
  if (ACT.newPin) h += '<div class="pin-box">Nuevo PIN de <b>' + esc(ACT.newPin.name) + '</b>: <span class="mono big">' + esc(ACT.newPin.pin) + '</span> <button class="btn tiny" data-action="actCopyPin">Copiar</button> <button class="btn tiny" data-action="actHidePin">Ocultar</button></div>';
  h += list.length ? '<table class="tbl"><tr><th>Id</th><th>Nombre</th><th></th><th>Creado</th><th></th></tr>' + list.map((t) => '<tr><td class="mono">' + esc(t.id) + '</td><td><b>' + esc(t.name) + '</b></td><td>' + (t.super ? '<span class="badge">super</span>' : '') + '</td><td class="small">' + fmtTs(t.createdAt) + '</td>' +
    '<td><button class="btn tiny" data-action="actRename" data-id="' + esc(t.id) + '">✏️ Renombrar</button> <button class="btn tiny danger" data-action="actRegen" data-id="' + esc(t.id) + '">🔑 Nuevo PIN</button></td></tr>').join('') + '</table>' : '<div class="empty">Cargando…</div>';
  return h + '<div class="actions"><button class="btn small danger" data-action="actPurge">🧹 Borrar actividad de más de 30 días</button></div></div>';
}
const ACTIVITY_ACTIONS = {
  actRange(el) { ACT.range = el.dataset.range; activityLoad(); },
  actRefresh() { activityLoad(); },
  actFocus(el) { ACT.testerId = ACT.testerId === el.dataset.id ? '' : el.dataset.id; ACT.sid = ''; activityLoad(); },
  actSession(el) { ACT.sid = ACT.sid === el.dataset.sid ? '' : el.dataset.sid; activityLoad(); },
  actMore() { activityLoad(true); },
  actExport() { window.open('/api/activity/export.csv?' + actParams({ q: ACT.q, sid: ACT.sid, kind: ACT.kind }).toString(), '_blank'); },
  actTesters() { ACT.showTesters = !ACT.showTesters; if (ACT.showTesters) activityLoad(); },
  actCopy(el) {
    const e = ACT.events.find((x) => String(x.id) === el.dataset.id);
    if (e) navigator.clipboard.writeText(JSON.stringify(e, null, 2)).then(() => toast('Evento copiado como JSON', 'ok'), () => toast('No se pudo copiar', 'error'));
  },
  actCopyPin() { if (ACT.newPin) navigator.clipboard.writeText(ACT.newPin.pin).then(() => toast('PIN copiado', 'ok'), () => {}); },
  actHidePin() { ACT.newPin = null; },
  actRename(el) {
    const t = (ACT.testers || []).find((x) => x.id === el.dataset.id);
    const name = prompt('Nuevo nombre para ' + (t ? t.name : el.dataset.id) + ':', t ? t.name : '');
    if (name && name.trim()) run('rename_tester', { testerId: el.dataset.id, name: name.trim() }, 'Probador renombrado').then((r) => { if (r) activityLoad(); });
  },
  actRegen(el) {
    const t = (ACT.testers || []).find((x) => x.id === el.dataset.id);
    if (!confirm('¿Generar un PIN nuevo para ' + (t ? t.name : el.dataset.id) + '? El PIN actual dejará de funcionar.')) return;
    run('regenerate_tester_pin', { testerId: el.dataset.id }).then((r) => { if (r) { ACT.newPin = r; render(); } });
  },
  actPurge() { if (confirm('¿Borrar los eventos de actividad de más de 30 días?')) run('purge_activity', { beforeDays: 30 }).then((r) => { if (r) { toast('Borrados ' + r.deleted + ' eventos', 'ok'); activityLoad(); } }); },
};
function activityChange(el) {
  const k = el.dataset.change;
  if (k === 'actFrom') ACT.from = el.value; else if (k === 'actTo') ACT.to = el.value;
  else if (k === 'actTester') ACT.testerId = el.value; else if (k === 'actUser') ACT.userId = el.value; else if (k === 'actRole') ACT.role = el.value;
  else if (k === 'actErrors') ACT.errorsOnly = el.checked; else if (k === 'actQ') ACT.q = el.value.trim(); else if (k === 'actKind') ACT.kind = el.value;
  activityLoad();
}
