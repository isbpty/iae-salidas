/* =====================================================================
   IAE Salidas · Interfaz: núcleo
   Arranque (DOMContentLoaded), reloj, tema, buscador de Escuela, render principal y pestañas,
   insignias comunes.
   Scripts clásicos que comparten el ámbito global (ver el orden en public/index.html):
   format, api, telemetry, state, model, qr, simulator, views-core, views-parent,
   views-school, views-gate, views-bus, modals y, al final, actions.
   ===================================================================== */

/* ---------- Arranque ---------- */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('splitToggle').addEventListener('change', (e) => { UI.split = e.target.checked; render(); });
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('change', onChange);
  document.addEventListener('input', (e) => { if (e.target.id === 'schoolSearch') { UI.q = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(render, 120); } });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) || e.target.isContentEditable;
    if (e.key === '/' && !typing && UI.view === 'school' && !UI.modal) { const box = document.getElementById('schoolSearch'); if (box) { e.preventDefault(); box.focus(); box.select(); } }
    if (e.key === 'Escape' && e.target.id === 'schoolSearch') { UI.q = ''; e.target.value = ''; render(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'waInput') { e.preventDefault(); sendChat(); }
    if (e.key === 'Escape' && UI.modal) { UI.modal = null; renderModal(); }
    else if (e.key === 'Escape' && UI.view === 'tv') { UI.view = 'school'; render(); }
  });
  initTheme();
  setInterval(animateBuses, 500);
  tickClock();
  setInterval(tickClock, 15000);
  boot();
});
/* L16: la hora se calibra con el servidor (serverNow) y se formatea en la zona de la escuela, no la del
   navegador -- un móvil con otra zona u hora desfasada mostraba horas equivocadas en el reloj y en la TV. */
function tickClock() {
  const d = new Date(serverNow());
  const el = document.getElementById('clock');
  if (el) el.textContent = d.toLocaleDateString('es-PA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: schoolTZ() }) + ' · ' + nowHHMM();
  const tv = document.getElementById('tvClock');
  if (tv) tv.textContent = nowHHMM();
}
/* ---------- Tema claro / oscuro ---------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('iae_theme', t); } catch { /* sin almacenamiento */ }
  const b = document.getElementById('themeBtn'); if (b) { b.textContent = t === 'dark' ? '☀️' : '🌙'; b.title = t === 'dark' ? 'Modo claro' : 'Modo oscuro'; }
}
function initTheme() {
  let t = null;
  try { t = localStorage.getItem('iae_theme'); } catch { /* sin almacenamiento */ }
  if (!t) t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(t);
}

/* ---------- Buscador de Escuela: filtra la pestaña activa por nombre, grado, cédula, teléfono, código… ---------- */
let searchTimer = null;
const normQ = (v) => String(v == null ? '' : v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function matchQ(...fields) {
  const q = normQ(UI.q).trim();
  if (!q) return true;
  const hay = normQ(fields.flat().filter((x) => x != null).join(' '));
  return q.split(/\s+/).every((w) => hay.includes(w));
}
const personQ = (id) => { const p = person(id) || {}; return [p.name, p.relation, p.cedula, p.phone]; };
const studentQ = (s) => (s ? [s.name, s.grade, levelName(s.levelId), (s.titulares || []).map(personQ)] : []);
const requestQ = (r) => [studentQ(student(r.studentId)), personQ(r.requestedBy), r.pickupBy ? personQ(r.pickupBy) : null, r.code, r.status, STATUS[r.status], r.kind, r.excusaType, r.reason, r.pickupPoint, r.date, r.time];
const SEARCH_TABS = ['solicitudes', 'salidas_hoy', 'excusas', 'estudiantes', 'autorizados', 'personal', 'bitacora'];
function searchHint(count, total) { return UI.q ? '<div class="search-hint">🔎 ' + count + ' de ' + total + ' coinciden con «' + esc(UI.q) + '» <button class="btn tiny" data-action="clearSearch">✕ limpiar</button></div>' : ''; }

/* R3: the Salidas view only carries "hoy + pendientes + últimos 14 días" -- a search that should
   reach further back calls the `search_requests` command instead. Kept as its own tiny piece of
   state (not V, which the poll keeps replacing) so a slow reply from an old query never clobbers a
   newer one, and so typing doesn't spam the server: it's re-run only when the (query, status filter)
   pair actually changes, same debounce as the local `UI.q` filter. */
let historySearch = { key: null, status: 'idle', results: [] };
function ensureHistorySearch(q, status) {
  const text = q.trim();
  if (!text) { historySearch = { key: null, status: 'idle', results: [] }; return; }
  const key = text + '|' + status;
  if (historySearch.key === key) return;
  historySearch = { key, status: 'loading', results: [] };
  api.command('search_requests', { q: text, kind: 'salida', status: status === 'todas' ? undefined : status }).then((r) => {
    if (historySearch.key === key) { historySearch = { key, status: 'done', results: r.result || [] }; render(); }
  }).catch((e) => {
    if (historySearch.key === key) historySearch = { key: null, status: 'idle', results: [] };
    if (e && e.status === 401) showLogin();
  });
}
/* ---------- Render principal ---------- */
let pendingTimer = null;
function render() {
  if (!V) return;
  document.body.classList.toggle('tv-mode', UI.view === 'tv');
  const main = document.getElementById('main');
  const active = document.activeElement;
  const keep = active && (active.id === 'waInput' || active.id === 'schoolSearch') ? { id: active.id, value: active.value, pos: active.selectionStart } : null;
  renderTabs();
  if (UI.split && ME.role === 'admin') {
    main.className = 'split';
    main.innerHTML = '<div class="pane">' + viewWhatsapp() + '</div><div class="pane">' + viewSchool() + '</div>';
  } else {
    main.className = 'single ' + UI.view;
    main.innerHTML = { parents: viewParents, whatsapp: viewWhatsapp, school: viewSchool, log: viewLog, tv: viewTv }[UI.view]();
  }
  renderModal();
  drawQRs();
  if (keep) { const el = document.getElementById(keep.id); if (el) { el.value = keep.value; el.focus(); if (keep.pos != null) try { el.setSelectionRange(keep.pos, keep.pos); } catch { /* no aplica */ } } }
  const chat = document.getElementById('waChat');
  if (chat) chat.scrollTop = chat.scrollHeight;
  T.screen(currentScreen());
  const now = serverNow();
  /* R3: admin no longer holds every family's messages (`V.chats` is a summary) -- the "bot is
     typing…" refresh only needs to watch whichever single conversation is actually on screen. */
  const showingChat = UI.view === 'whatsapp' || (UI.split && ME.role === 'admin');
  const chatKey = ME.role === 'parent' ? V.me.id : UI.phoneId;
  const pend = showingChat ? chatMessages(chatKey).filter((m) => m.pendingUntil && m.pendingUntil > now).map((m) => m.pendingUntil) : [];
  clearTimeout(pendingTimer);
  if (pend.length) pendingTimer = setTimeout(() => { if (!formOpen()) render(); }, Math.min(...pend) - now + 20);
}
function currentScreen() {
  if (UI.split && ME.role === 'admin') return 'split:' + UI.schoolTab;
  if (UI.view === 'parents') return 'parent:' + UI.parentTab;
  if (UI.view === 'school') return 'school:' + UI.schoolTab;
  return UI.view;
}
function renderTabs() {
  const all = [['parents', '📱 App Padres'], ['whatsapp', '💬 WhatsApp'], ['school', '🏫 Escuela'], ['log', '📜 Bitácora']];
  const allowed = ME.role === 'parent' ? ['parents', 'whatsapp'] : ME.role === 'admin' ? ['whatsapp', 'school', 'log'] : ['school'];
  if (UI.view === 'tv' && !(ME.role === 'admin' || staffCan('marcar_salida'))) UI.view = allowed[0];
  if (!allowed.includes(UI.view) && UI.view !== 'tv') UI.view = allowed[0];
  document.getElementById('tabs').innerHTML = all.filter(([k]) => allowed.includes(k)).map(([k, l]) => '<button class="tab' + (UI.view === k ? ' active' : '') + '" data-action="setView" data-view="' + k + '">' + l + '</button>').join('');
}
function badge(status, expired) { return expired ? '<span class="badge st-cancelada">Vencida</span>' : '<span class="badge st-' + esc(status) + '">' + esc(STATUS[status] || status) + '</span>'; }
/* S11: r.color viene del seed hoy, pero si algún día se edita desde la UI no debe poder escapar del
   atributo style/fill; se valida contra un hex de 6 dígitos antes de usarlo. */
function safeColor(c) { return /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#888888'; }
function kindBadge(kind) {
  const map = { titular: 'k-titular', siempre: 'k-siempre', temporal: 'k-temporal', una_vez: 'k-unavez' };
  return '<span class="badge ' + (map[kind] || '') + '">' + esc(kindLabel(kind)) + '</span>';
}
function opt(v, label, sel) { return '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(label) + '</option>'; }
