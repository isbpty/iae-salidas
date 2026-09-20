/* Página /super: panel del super admin, fuera de la app. Acceso propio con PIN de super admin + clave
   (SUPER_KEY), cookie aparte de una hora. Lee GET /api/activity/* y gestiona probadores por /api/super/*. */
const SUP = { tester: null, users: [], range: 'today', from: '', to: '', testerId: '', userId: '', role: '', errorsOnly: false, q: '', sid: '', kind: '',
  summary: null, events: [], nextBefore: null, loading: false, seq: 0, error: null, timer: null, newPin: null, showTesters: false, testers: null };
const ACT_KINDS = ['', 'command', 'view', 'login', 'login_failed', 'switch_user', 'logout', 'attachment', 'super_login', 'super_action', 'screen_enter', 'screen_leave', 'modal_open', 'modal_close', 'click', 'form_submit', 'form_abandon', 'js_error', 'promise_rejection', 'visibility', 'session_start', 'session_end'];
const KIND_ICON = { command: '⚡', view: '👁', login: '🔑', login_failed: '⛔', switch_user: '🔁', logout: '🚪', attachment: '🖼', screen_enter: '➡️', screen_leave: '⬅️', modal_open: '🗔', modal_close: '🗙', click: '🖱', form_submit: '✅', form_abandon: '🚫', js_error: '💥', promise_rejection: '💥', visibility: '👀', session_start: '▶', session_end: '⏹', pin: '🔢', super_login: '🛡️', super_logout: '🛡️', super_action: '🛠', other: '·' };

/* ---------- red ---------- */
async function req(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const value = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(value.message || value.error || String(res.status)); e.status = res.status; e.code = value.error; throw e; }
  return value;
}
const getJ = (what, params) => req('/api/activity/' + what + (params && params.toString() ? '?' + params.toString() : ''));
const postJ = (path, body) => req(path, { method: 'POST', body: JSON.stringify(body || {}) });
function toast(text, kind = 'info') {
  const box = document.getElementById('toasts'); const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = text; box.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10); setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 6000);
}
const setStatus = (t) => { document.getElementById('superStatus').textContent = t; };

/* ---------- filtros y carga ---------- */
function actRange() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (SUP.range === 'today') return { from: d.toISOString(), to: '' };
  if (SUP.range === '7d') return { from: new Date(d.getTime() - 6 * 86400000).toISOString(), to: '' };
  if (SUP.range === '30d') return { from: new Date(d.getTime() - 29 * 86400000).toISOString(), to: '' };
  return { from: SUP.from ? new Date(SUP.from + 'T00:00:00').toISOString() : '', to: SUP.to ? new Date(SUP.to + 'T23:59:59').toISOString() : '' };
}
function actParams(extra = {}) {
  const r = actRange();
  const p = { from: r.from, to: r.to, testerId: SUP.testerId, userId: SUP.userId, role: SUP.role, errorsOnly: SUP.errorsOnly ? '1' : '', ...extra };
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== '' && v != null) u.set(k, v);
  return u;
}
function typing() { const a = document.activeElement; return !!(a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)); }
async function load(more = false) {
  if (!SUP.tester) return;
  const seq = ++SUP.seq; SUP.loading = true;
  try {
    const timeline = actParams({ q: SUP.q, sid: SUP.sid, kind: SUP.kind, limit: 100, before: more ? SUP.nextBefore : '' });
    const [s, e, testers] = await Promise.all([getJ('summary', actParams()), getJ('events', timeline), SUP.showTesters ? getJ('testers') : Promise.resolve(SUP.testers)]);
    if (seq !== SUP.seq) return;
    SUP.summary = s; SUP.testers = testers;
    SUP.events = more ? SUP.events.concat(e.events) : e.events; SUP.nextBefore = e.nextBefore; SUP.error = null;
    setStatus('conectado · ' + SUP.tester.name + ' · actualizado ' + fmtClockS(s.generatedAt));
  } catch (err) {
    if (seq !== SUP.seq) return;
    if (err.status === 401) { SUP.tester = null; showLogin('La sesión de super admin caducó. Vuelve a entrar.'); return; }
    SUP.error = err.message; setStatus('sin conexión');
  } finally { if (seq === SUP.seq) { SUP.loading = false; if (SUP.tester && !typing()) render(); } }
}

/* ---------- formato ---------- */
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
const userName = (id) => { const u = SUP.users.find((x) => x.id === id); return u ? u.name : id || '—'; };
const bar = (v, max, cls = '') => '<div class="bar"><div class="bar-fill ' + cls + '" style="width:' + (max ? Math.max(2, Math.round(100 * v / max)) : 0) + '%"></div></div>';
const kpi = (label, value, cls = '') => '<div class="kpi ' + cls + '"><div class="kpi-v">' + value + '</div><div class="kpi-l">' + label + '</div></div>';

/* ---------- vistas ---------- */
function render() {
  const main = document.getElementById('main');
  main.innerHTML = '<div class="page">' + panel() + '</div>';
}
function panel() {
  const s = SUP.summary;
  const chip = (k, l) => '<button class="chip' + (SUP.range === k ? ' active' : '') + '" data-action="range" data-range="' + k + '">' + l + '</button>';
  const sel = (name, value, options, all) => '<select data-change="' + name + '"><option value="">' + all + '</option>' + options.map(([v, l]) => '<option value="' + esc(v) + '"' + (value === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>';
  const testerOpts = (s ? s.testers : []).map((t) => [t.id, t.name]);
  const userOpts = SUP.users.map((u) => [u.id, u.name + ' · ' + roleName(u.role)]);
  const roleOpts = ['parent', 'admin', 'recepcion', 'profesor', 'garita', 'monitora'].map((r) => [r, roleName(r)]);
  let h = '<h2>📊 Actividad de los probadores <span class="muted small">' + (SUP.loading ? 'actualizando…' : '') + '</span>' +
    '<span class="right"><button class="btn small" data-action="refresh">↻ Actualizar</button> <button class="btn small" data-action="export">⬇ Exportar CSV</button> <button class="btn small' + (SUP.showTesters ? ' primary' : '') + '" data-action="testers">🔐 Probadores y PINs</button></span></h2>' +
    '<div class="filters">' + chip('today', 'Hoy') + chip('7d', '7 días') + chip('30d', '30 días') + chip('custom', 'Rango') +
    (SUP.range === 'custom' ? ' <input type="date" data-change="from" value="' + esc(SUP.from) + '"> <input type="date" data-change="to" value="' + esc(SUP.to) + '">' : '') +
    sel('tester', SUP.testerId, testerOpts, 'Todos los probadores') + sel('user', SUP.userId, userOpts, 'Todos los usuarios') + sel('role', SUP.role, roleOpts, 'Todos los roles') +
    '<label class="check small"><input type="checkbox" data-change="errors"' + (SUP.errorsOnly ? ' checked' : '') + '> Solo errores</label></div>';
  if (SUP.error) h += '<div class="empty danger-text">No se pudo cargar la actividad: ' + esc(SUP.error) + '</div>';
  if (SUP.showTesters) h += testersBlock();
  if (!s) return h + (SUP.loading ? '<div class="empty">Cargando…</div>' : '');
  const errs = s.errors.reduce((a, e) => a + e.count, 0);
  h += '<div class="kpis">' + kpi('eventos', s.totals.events) + kpi('sesiones', s.totals.sessions) + kpi('tiempo activo total', fmtDur(s.totals.activeMs)) + kpi('errores', errs, errs ? 'warn' : 'ok') + '</div>';
  return h + testerCards(s) + hotspots(s) + sessions(s) + timeline();
}
function testerCards(s) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return '<div class="section-title">Probadores</div><div class="act-grid">' + s.testers.map((t) => {
    const state = t.online ? 'on' : t.lastAt && new Date(t.lastAt) >= today ? 'today' : 'off';
    const label = t.online ? 'activo ahora' : t.lastAt ? 'última actividad ' + fmtAgo(t.lastAt) : 'sin actividad';
    return '<div class="card act-card' + (SUP.testerId === t.id ? ' selected' : '') + '" data-action="focus" data-id="' + esc(t.id) + '"><div class="act-head"><span class="act-dot ' + state + '"></span><b>' + esc(t.name) + '</b>' + (t.super ? ' <span class="badge">super</span>' : '') + '</div>' +
      '<div class="small muted">' + label + '</div><div class="act-stats"><span><b>' + t.sessions + '</b> ses.</span><span><b>' + fmtDur(t.activeMs) + '</b></span><span><b>' + t.actions + '</b> acciones</span><span class="' + (t.errors ? 'danger-text' : '') + '"><b>' + t.errors + '</b> errores</span></div></div>';
  }).join('') + '</div>';
}
function hotspots(s) {
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
function sessions(s) {
  if (!s.sessions.length) return '';
  return '<div class="section-title">Sesiones (corte a ' + s.sessionGapMin + ' min sin actividad)</div><table class="tbl"><tr><th>Probador</th><th>Usuarios</th><th>Inicio</th><th>Duración</th><th>Eventos</th><th></th></tr>' +
    s.sessions.slice(0, 30).map((x) => '<tr class="' + (SUP.sid === x.sid ? 'selected' : '') + '"><td>' + esc(x.tester) + '</td><td class="small">' + esc(x.users.map(userName).join(', ')) + '</td><td class="mono small">' + fmtTs(x.started) + '</td><td>' + fmtDur(x.activeMs) + '</td><td>' + x.events + '</td><td><button class="btn tiny" data-action="session" data-sid="' + esc(x.sid) + '">' + (SUP.sid === x.sid ? 'Quitar filtro' : 'Ver línea de tiempo') + '</button></td></tr>').join('') + '</table>';
}
function timeline() {
  const kinds = ACT_KINDS.map((k) => '<option value="' + k + '"' + (SUP.kind === k ? ' selected' : '') + '>' + (k || 'Todos los tipos') + '</option>').join('');
  let h = '<div class="section-title">Línea de tiempo' + (SUP.sid ? ' · sesión <span class="mono">' + esc(SUP.sid) + '</span>' : '') + '</div>' +
    '<div class="filters"><input type="search" placeholder="Buscar (acción, pantalla, error, usuario, datos…)" data-change="q" value="' + esc(SUP.q) + '" style="min-width:280px"><select data-change="kind">' + kinds + '</select></div>';
  if (!SUP.events.length) return h + '<div class="empty">Sin eventos con estos filtros.</div>';
  h += '<table class="tbl act-events"><tr><th>Hora</th><th>Probador</th><th>Usuario</th><th>Evento</th><th>Pantalla</th><th>Duración</th><th>Resultado</th><th></th></tr>' + SUP.events.map((e) => {
    const bad = e.ok === false || /error|rejection/.test(e.kind);
    const testerName = (SUP.summary.testers.find((t) => t.id === (e.testerId || 'shared')) || {}).name || e.testerId || 'Compartido';
    return '<tr class="' + (bad ? 'bad' : '') + '"><td class="mono small" title="' + esc(e.at) + '">' + fmtClockS(e.at) + '</td><td class="small">' + esc(testerName) + '</td><td class="small">' + esc(userName(e.userId)) + (e.role ? '<br><span class="muted">' + esc(roleName(e.role)) + '</span>' : '') + '</td>' +
      '<td class="small">' + (KIND_ICON[e.kind] || '·') + ' <span class="mono">' + esc(e.kind) + '</span> <b>' + esc(e.name || '') + '</b>' + (e.target ? ' <span class="muted">→ ' + esc(e.target) + '</span>' : '') + '</td>' +
      '<td class="mono small">' + esc(e.screen || '') + '</td><td class="small">' + (e.durationMs != null ? fmtDur(e.durationMs) : '') + '</td>' +
      '<td class="small">' + (e.status ? '<span class="mono">' + e.status + '</span> ' : '') + (e.error ? '<span class="danger-text">' + esc(e.error) + '</span>' : e.ok === true ? '✓' : '') + '</td>' +
      '<td><button class="btn tiny" data-action="copy" data-id="' + e.id + '" title="Copiar JSON del evento">📋</button></td></tr>';
  }).join('') + '</table>';
  if (SUP.nextBefore) h += '<div class="actions"><button class="btn" data-action="more">Cargar más</button></div>';
  return h;
}
function testersBlock() {
  const list = SUP.testers || [];
  let h = '<div class="card"><h3>🔐 Probadores y PINs</h3><p class="small muted">Cada probador tiene un PIN de 6 dígitos. El PIN nunca se guarda en claro: al regenerarlo se muestra <b>una sola vez</b>.</p>';
  if (SUP.newPin) h += '<div class="pin-box">Nuevo PIN de <b>' + esc(SUP.newPin.name) + '</b>: <span class="mono big">' + esc(SUP.newPin.pin) + '</span> <button class="btn tiny" data-action="copyPin">Copiar</button> <button class="btn tiny" data-action="hidePin">Ocultar</button></div>';
  h += list.length ? '<table class="tbl"><tr><th>Id</th><th>Nombre</th><th></th><th>Creado</th><th></th></tr>' + list.map((t) => '<tr><td class="mono">' + esc(t.id) + '</td><td><b>' + esc(t.name) + '</b></td><td>' + (t.super ? '<span class="badge">super</span>' : '') + '</td><td class="small">' + fmtTs(t.createdAt) + '</td>' +
    '<td><button class="btn tiny" data-action="rename" data-id="' + esc(t.id) + '">✏️ Renombrar</button> <button class="btn tiny danger" data-action="regen" data-id="' + esc(t.id) + '">🔑 Nuevo PIN</button></td></tr>').join('') + '</table>' : '<div class="empty">Cargando…</div>';
  return h + '<div class="actions"><button class="btn small danger" data-action="purge">🧹 Borrar actividad de más de 30 días</button></div></div>';
}

/* ---------- acciones ---------- */
const ACTIONS = {
  range(el) { SUP.range = el.dataset.range; load(); },
  refresh() { load(); },
  focus(el) { SUP.testerId = SUP.testerId === el.dataset.id ? '' : el.dataset.id; SUP.sid = ''; load(); },
  session(el) { SUP.sid = SUP.sid === el.dataset.sid ? '' : el.dataset.sid; load(); },
  more() { load(true); },
  export() { window.open('/api/activity/export.csv?' + actParams({ q: SUP.q, sid: SUP.sid, kind: SUP.kind }).toString(), '_blank'); },
  testers() { SUP.showTesters = !SUP.showTesters; load(); },
  copy(el) {
    const e = SUP.events.find((x) => String(x.id) === el.dataset.id);
    if (e) navigator.clipboard.writeText(JSON.stringify(e, null, 2)).then(() => toast('Evento copiado como JSON', 'ok'), () => toast('No se pudo copiar', 'error'));
  },
  copyPin() { if (SUP.newPin) navigator.clipboard.writeText(SUP.newPin.pin).then(() => toast('PIN copiado', 'ok'), () => {}); },
  hidePin() { SUP.newPin = null; },
  rename(el) {
    const t = (SUP.testers || []).find((x) => x.id === el.dataset.id);
    const name = prompt('Nuevo nombre para ' + (t ? t.name : el.dataset.id) + ':', t ? t.name : '');
    if (name && name.trim()) postJ('/api/super/rename', { testerId: el.dataset.id, name: name.trim() }).then(() => { toast('Probador renombrado', 'ok'); load(); }, (e) => toast('No se pudo renombrar: ' + e.message, 'error'));
  },
  regen(el) {
    const t = (SUP.testers || []).find((x) => x.id === el.dataset.id);
    if (!confirm('¿Generar un PIN nuevo para ' + (t ? t.name : el.dataset.id) + '? El PIN actual dejará de funcionar.')) return;
    postJ('/api/super/regenerate', { testerId: el.dataset.id }).then((r) => { SUP.newPin = r; render(); }, (e) => toast('No se pudo regenerar: ' + e.message, 'error'));
  },
  purge() { if (confirm('¿Borrar los eventos de actividad de más de 30 días?')) postJ('/api/super/purge', { beforeDays: 30 }).then((r) => { toast('Borrados ' + r.deleted + ' eventos', 'ok'); load(); }, (e) => toast('No se pudo borrar: ' + e.message, 'error')); },
};
function onChange(el) {
  const k = el.dataset.change;
  if (k === 'from') SUP.from = el.value; else if (k === 'to') SUP.to = el.value;
  else if (k === 'tester') SUP.testerId = el.value; else if (k === 'user') SUP.userId = el.value; else if (k === 'role') SUP.role = el.value;
  else if (k === 'errors') SUP.errorsOnly = el.checked; else if (k === 'q') SUP.q = el.value.trim(); else if (k === 'kind') SUP.kind = el.value;
  load();
}

/* ---------- acceso ---------- */
function showLogin(message) {
  setStatus('acceso restringido');
  document.getElementById('superLogout').style.display = 'none';
  document.getElementById('main').innerHTML = '<div class="page"><div class="card" style="max-width:420px;margin:40px auto"><h2>🛡️ Super admin</h2><p class="muted small">Esta página no forma parte de la app. Hacen falta el PIN de super admin y la clave de super admin.</p>' +
    '<form id="superForm" class="form"><label>PIN de super admin<input name="pin" type="password" inputmode="numeric" autocomplete="off" required autofocus></label>' +
    '<label>Clave<input name="key" type="password" autocomplete="off" required></label><button class="btn primary big">Entrar</button><div id="superError" class="danger-text small">' + esc(message || '') + '</div></form></div></div>';
  document.getElementById('superForm').onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    try { const r = await postJ('/api/auth/super', { pin: d.pin, key: d.key }); start(r.tester); }
    catch (err) { document.getElementById('superError').textContent = err.status === 429 ? 'Demasiados intentos. Espera 15 minutos.' : err.status === 401 ? 'PIN o clave incorrectos.' : 'Sin conexión.'; }
  };
}
async function start(tester) {
  try { const me = await getJ('me'); SUP.tester = me.tester; SUP.users = me.users; }
  catch (err) { showLogin(tester ? 'No se pudo abrir la sesión.' : ''); return; }
  document.getElementById('superLogout').style.display = '';
  setStatus('conectado · ' + SUP.tester.name);
  render();
  load();
  if (!SUP.timer) SUP.timer = setInterval(() => { if (SUP.tester && !document.hidden) load(); }, 10000);
}
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !SUP.tester) return;
    const fn = ACTIONS[el.dataset.action];
    if (fn) { fn(el); render(); }
  });
  document.addEventListener('change', (e) => { const el = e.target.closest('[data-change]'); if (el && SUP.tester) onChange(el); });
  document.getElementById('superLogout').onclick = async () => { try { await postJ('/api/auth/super/logout'); } finally { SUP.tester = null; SUP.summary = null; showLogin('Sesión cerrada.'); } };
  start(null);
});
