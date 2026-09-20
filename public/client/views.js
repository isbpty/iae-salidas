/* =====================================================================
   IAE Salidas · Interfaz: app de padres, WhatsApp simulado, dashboard
   ===================================================================== */

/* ---------- Arranque ---------- */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('splitToggle').addEventListener('change', (e) => { UI.split = e.target.checked; render(); });
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'waInput') { e.preventDefault(); sendChat(); }
    if (e.key === 'Escape' && UI.modal) { UI.modal = null; renderModal(); }
  });
  tickClock();
  setInterval(tickClock, 15000);
  boot();
});
function tickClock() {
  const d = new Date();
  const el = document.getElementById('clock');
  if (el) el.textContent = d.toLocaleDateString('es-PA', { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/* ---------- Render principal ---------- */
let pendingTimer = null;
function render() {
  if (!V) return;
  const main = document.getElementById('main');
  const active = document.activeElement;
  const keep = active && active.id === 'waInput' ? { id: 'waInput', value: active.value } : null;
  renderTabs();
  if (UI.split && ME.role === 'admin') {
    main.className = 'split';
    main.innerHTML = '<div class="pane">' + viewWhatsapp() + '</div><div class="pane">' + viewSchool() + '</div>';
  } else {
    main.className = 'single ' + UI.view;
    main.innerHTML = { parents: viewParents, whatsapp: viewWhatsapp, school: viewSchool, log: viewLog }[UI.view]();
  }
  renderModal();
  drawQRs();
  if (keep) { const el = document.getElementById(keep.id); if (el) { el.value = keep.value; el.focus(); } }
  const chat = document.getElementById('waChat');
  if (chat) chat.scrollTop = chat.scrollHeight;
  T.screen(currentScreen());
  if (!(UI.view === 'school' && UI.schoolTab === 'actividad')) activityTimer(false);
  const now = serverNow();
  const pend = Object.values(allChats()).flat().filter((m) => m.pendingUntil && m.pendingUntil > now).map((m) => m.pendingUntil);
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
  if (!allowed.includes(UI.view)) UI.view = allowed[0];
  document.getElementById('tabs').innerHTML = all.filter(([k]) => allowed.includes(k)).map(([k, l]) => '<button class="tab' + (UI.view === k ? ' active' : '') + '" data-action="setView" data-view="' + k + '">' + l + '</button>').join('');
}
function badge(status) { return '<span class="badge st-' + status + '">' + (STATUS[status] || status) + '</span>'; }
function kindBadge(kind) {
  const map = { titular: 'k-titular', siempre: 'k-siempre', temporal: 'k-temporal', una_vez: 'k-unavez' };
  return '<span class="badge ' + (map[kind] || '') + '">' + esc(kindLabel(kind)) + '</span>';
}
function opt(v, label, sel) { return '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(label) + '</option>'; }

/* =====================================================================
   APP DE PADRES
   ===================================================================== */
function viewParents() {
  const p = V.me;
  const unread = V.unread;
  const tab = UI.parentTab;
  const body = { inicio: parentHome, solicitudes: parentRequests, autorizados: parentAuths, avisos: parentNotifs }[tab](p);
  return '<div class="phone-wrap"><div class="phone app">' +
    '<div class="app-header"><div><div class="muted small">' + esc(V.settings.school.name) + '</div><b>Hola, ' + esc(firstName(p.name)) + '</b></div>' +
    '<button class="bell" data-action="parentTab" data-tab="avisos">🔔' + (unread ? '<span class="dot">' + unread + '</span>' : '') + '</button></div>' +
    '<div class="app-body">' + body + '</div>' +
    '<nav class="app-nav">' + [['inicio', '🏠', 'Inicio'], ['solicitudes', '📋', 'Solicitudes'], ['autorizados', '👥', 'Autorizados'], ['avisos', '🔔', 'Avisos']]
      .map(([k, i, l]) => '<button class="' + (tab === k ? 'active' : '') + '" data-action="parentTab" data-tab="' + k + '">' + i + '<span>' + l + '</span></button>').join('') + '</nav>' +
    '</div></div>';
}
function parentHome(p) {
  const kids = studentsOf(p.id);
  const auths = authorizedFor();
  const today = todayISO();
  const todayReqs = V.requests.filter((r) => kids.some((k) => k.id === r.studentId) && r.date === today && r.status !== 'cancelada');
  let h = '<div class="section-title">Mis hijos</div>';
  if (!kids.length) h += '<div class="empty">No eres titular de ningún estudiante.</div>';
  h += kids.map((k) => {
    const others = k.titulares.filter((t) => t !== p.id).map((t) => (person(t) || {}).name || '');
    return '<div class="card kid"><div class="avatar">' + k.emoji + '</div><div class="grow"><b>' + esc(k.name) + '</b><div class="muted small">' + esc(k.grade) + ' · ' + esc(levelName(k.levelId)) + '</div>' +
      '<div class="muted small">Titulares: tú' + (others.length ? ', ' + esc(others.join(', ')) : '') + ' · Autorizados: ' + authsForStudent(k.id).filter(isAuthActive).length + '</div>' +
      '<div class="small" style="margin-top:4px">' + busChip(k) + '</div>' +
      '<div class="actions"><button class="btn tiny" data-action="whereKid" data-id="' + k.id + '">📍 ¿Dónde está?</button>' + (k.routeId ? '<button class="btn tiny" data-action="noBusKid" data-id="' + k.id + '">🚌 Hoy no va en bus</button>' : '') + '</div></div></div>';
  }).join('');
  if (kids.length) {
    h += '<div class="grid2 gap">' +
      '<button class="btn primary big" data-action="openModal" data-modal="newSalida">🚪 Solicitar salida</button>' +
      '<button class="btn big" data-action="openModal" data-modal="newExcusa">📝 Enviar excusa</button>' +
      '<button class="btn big" data-action="openModal" data-modal="newAuth">👥 Autorizar persona</button>' +
      '<button class="btn big" data-action="setView" data-view="whatsapp">💬 Ir a WhatsApp</button></div>';
  }
  if (auths.length) {
    h += '<div class="section-title">Autorizado(a) para retirar otros niños</div>' + auths.map((a) => {
      const s = a.student;
      return '<div class="card"><div class="row"><span class="avatar sm">' + s.emoji + '</span><div><b>' + esc(s.name) + '</b> <span class="muted small">' + esc(s.grade) + '</span><div class="small">' + kindBadge(a.auth.type) + (a.auth.type === 'temporal' ? ' <span class="muted">' + a.auth.validFrom + ' → ' + a.auth.validTo + '</span>' : '') +
        ' <span class="muted">· por ' + esc(a.createdByName || '') + '</span></div></div></div></div>';
    }).join('');
  }
  h += '<div class="section-title">Hoy</div>';
  h += todayReqs.length ? todayReqs.map((r) => requestCard(r, { compact: true, who: p })).join('') : '<div class="empty">Sin solicitudes para hoy.</div>';
  return h;
}
function parentRequests(p) {
  const kids = studentsOf(p.id).map((k) => k.id);
  const list = V.requests.filter((r) => kids.includes(r.studentId));
  return '<div class="section-title">Mis solicitudes <button class="btn small primary right" data-action="openModal" data-modal="newSalida">+ Salida</button> <button class="btn small right" data-action="openModal" data-modal="newExcusa">+ Excusa</button></div>' +
    (list.length ? list.map((r) => requestCard(r, { who: p })).join('') : '<div class="empty">Aún no hay solicitudes.</div>');
}
function parentAuths(p) {
  const kids = studentsOf(p.id);
  let h = '<div class="section-title">Titulares y autorizados <button class="btn small primary right" data-action="openModal" data-modal="newAuth">+ Autorizar</button></div>';
  h += kids.map((k) => {
    const tit = k.titulares.map((t) => {
      const tp = person(t) || {};
      return '<div class="row item"><span class="avatar sm">👤</span><div><b>' + esc(tp.name) + '</b> <span class="muted small">' + esc(tp.relation) + ' · ' + esc(tp.phone) + '</span></div>' + kindBadge('titular') + '</div>';
    }).join('');
    const auths = authsForStudent(k.id).map((a) => {
      const pr = person(a.personId) || {};
      const active = isAuthActive(a);
      let vig = '';
      if (a.type === 'temporal') vig = a.validFrom + ' → ' + a.validTo;
      if (a.type === 'una_vez') vig = a.usedAt ? 'ya usada' : 'pendiente de uso';
      return '<div class="row item' + (active ? '' : ' inactive') + '"><span class="avatar sm">🧑</span><div><b>' + esc(pr.name) + '</b> <span class="muted small">' + esc(pr.relation) + (pr.cedula ? ' · céd. ' + esc(pr.cedula) : '') + (pr.hasAccount ? ' · 📱 tiene cuenta' : '') + '</span><div class="small">' + kindBadge(a.type) + ' <span class="muted">' + vig + (active ? '' : ' · inactiva') + '</span></div></div>' +
        '<button class="btn tiny danger" data-action="revokeAuth" data-id="' + a.id + '" title="Revocar">✕</button></div>';
    }).join('');
    return '<div class="card"><div class="row"><span class="avatar sm">' + k.emoji + '</span><b>' + esc(k.name) + '</b> <span class="muted small">máx. ' + V.settings.maxTitulares + ' titulares</span></div>' + tit + (auths || '<div class="muted small">Sin personas autorizadas.</div>') + '</div>';
  }).join('');
  return h;
}
function parentNotifs(p) {
  const list = V.notifications.slice().reverse();
  markReadSoon();
  return '<div class="section-title">Avisos</div>' + (list.length ? list.map((n) => '<div class="card notif"><div class="small muted">' + fmtTs(n.ts) + '</div>' + esc(n.text) + '</div>').join('') : '<div class="empty">Sin avisos todavía.</div>');
}
function requestCard(r, o = {}) {
  const st = student(r.studentId);
  const by = person(r.requestedBy) || {};
  const canCancel = o.who && st.titulares.includes(o.who.id) && ['pendiente', 'aprobada'].includes(r.status) && r.status !== 'retirado';
  let main = '';
  if (r.kind === 'salida') {
    main = '<b>🚪 Salida ' + esc(fmtDate(r.date)) + ' · ' + fmtTime(r.time) + '</b><div class="small">Retira: ' + esc(describePickup(r)) + ' ' + (r.pickupKind ? kindBadge(r.pickupKind) : '') + '</div>' +
      (r.status === 'aprobada' || r.status === 'retirado' ? '<div class="small">📍 ' + esc(r.pickupPoint) + ' · código <b class="mono">' + r.code + '</b>' + (r.autoApproved ? ' · <span class="muted">auto-aprobada</span>' : '') + '</div>' : '') +
      (r.confirmation ? '<div class="small">Confirmación del titular: <b>' + r.confirmation.status + '</b></div>' : '') +
      (r.status === 'aprobada' && !o.compact ? qrBox(r) : '') +
      (r.status === 'retirado' ? '<div class="small">Salió a las ' + fmtClock(r.exitAt) + (r.exitBy ? ' · confirmó ' + esc(staffName(r.exitBy)) : '') + '</div>' : '') +
      (r.status === 'rechazada' ? '<div class="small danger-text">Motivo: ' + esc(r.rejectReason) + '</div>' : '');
  } else {
    main = '<b>📝 Excusa · ' + esc(r.excusaType) + ' · ' + esc(fmtDate(r.date)) + '</b><div class="small">' + esc(r.reason) + '</div>' + (r.attachmentName ? '<div class="small">📎 ' + esc(r.attachmentName) + '</div>' : '') +
      (r.status === 'rechazada' ? '<div class="small danger-text">Motivo: ' + esc(r.rejectReason) + '</div>' : '');
  }
  return '<div class="card req"><div class="row top"><span class="avatar sm">' + st.emoji + '</span><div class="grow"><div class="small muted">' + esc(st.name) + ' · ' + esc(st.grade) + ' · vía ' + CHANNEL[r.channel] + ' · por ' + esc(firstName(by.name)) + '</div>' + main + '</div>' + badge(r.status) + '</div>' +
    (o.compact ? '' : '<details class="hist"><summary>Historial</summary>' + r.history.map((h) => '<div class="small"><span class="muted mono">' + fmtTs(h.ts) + '</span> ' + esc(h.text) + '</div>').join('') + '</details>') +
    (canCancel ? '<div class="actions"><button class="btn tiny" data-action="cancelReq" data-id="' + r.id + '">Cancelar solicitud</button></div>' : '') +
    '</div>';
}

/* =====================================================================
   WHATSAPP SIMULADO
   ===================================================================== */
function viewWhatsapp() {
  const isParent = ME.role === 'parent';
  const key = isParent ? V.me.id : UI.phoneId;
  const p = key === 'unknown' ? null : (isParent ? V.me : person(key));
  const msgs = chatMessages(key);
  const now = serverNow();
  const lastBotIdx = msgs.map((m) => m.from).lastIndexOf('bot');
  const bubbles = msgs.map((m, i) => {
    if (m.from === 'bot' && m.pendingUntil > now) return '<div class="bubble in typing"><span></span><span></span><span></span></div>';
    const btns = m.from === 'bot' && i === lastBotIdx && m.buttons && m.buttons.length
      ? '<div class="wa-btns">' + m.buttons.map((b) => '<button class="wa-btn" data-action="chatQuick" data-text="' + esc(b) + '">' + esc(b) + '</button>').join('') + '</div>' : '';
    return '<div class="bubble ' + (m.from === 'bot' ? 'in' : 'out') + '">' + esc(m.text).replace(/\n/g, '<br>').replace(/\*(.+?)\*/g, '<b>$1</b>') + (m.location ? locationCard(m.location) : '') + '<span class="time">' + fmtClock(m.ts) + '</span></div>' + btns;
  }).join('');
  const welcome = !msgs.length ? '<div class="wa-sys">Los mensajes están cifrados de extremo a extremo. Escribe "hola" para empezar.</div>' : '';
  const picker = isParent ? '' : '<div class="sim-bar">📞 Simular teléfono de: <select data-change="setPhone">' +
    Object.values(V.persons).filter((x) => x.phone).map((x) => opt(x.id, x.name + ' · ' + x.phone + (x.hasAccount ? '' : ' (sin cuenta)'), x.id === key)).join('') +
    opt('unknown', 'Número desconocido · +507 6000-0000', key === 'unknown') + '</select></div>';
  return '<div class="phone-wrap">' + picker +
    '<div class="phone wa"><div class="wa-header"><span class="wa-back">‹</span><span class="wa-avatar">🏫</span><div><b>' + esc(V.settings.school.short) + ' Salidas</b> <span class="verified">✔</span><div class="small">Cuenta de empresa · en línea</div></div></div>' +
    '<div class="wa-chat" id="waChat">' + welcome + bubbles + '</div>' +
    '<div class="wa-chips">' + chatChips(p, key).map((c) => '<button class="chip" data-action="chatQuick" data-text="' + esc(c) + '">' + esc(c) + '</button>').join('') + '</div>' +
    '<div class="wa-input"><input id="waInput" placeholder="Escribe un mensaje" autocomplete="off"><button class="wa-send" data-action="chatSend">➤</button></div></div></div>';
}
function chatChips(p, key) {
  if (!p || !p.hasAccount) return ['Hola', 'Necesito retirar a mi hijo'];
  const st = chatStateFor(key);
  if (st && st.step === 'confirm_pickup') return ['Sí, confirmo', 'No'];
  if (st && st.step === 'confirm') return ['Sí', 'No', 'Cancelar'];
  if (st && st.step) return ['Cancelar'];
  const kids = studentsOf(p.id);
  if (!kids.length) return ['Hola', 'Estado'];
  const k = kids[0];
  const k2 = kids[1] || kids[0];
  const t1 = fmtTime(addMinutes(nowHHMM(), 125));
  const t2 = fmtTime(addMinutes(nowHHMM(), 30));
  const chips = ['Hola', 'Necesito retirar a ' + firstName(k.name) + ' hoy a las ' + t1];
  const auths = authsForStudent(k.id).filter(isAuthActive);
  if (auths.length) {
    const a = auths[0];
    const ap = person(a.personId) || {};
    chips.push('A ' + firstName(k.name) + ' lo va a retirar ' + (String(ap.relation || '').toLowerCase() === 'abuela' ? 'la abuela' : ap.name) + ' a las ' + t2);
    const uv = auths.find((x) => x.type === 'una_vez');
    if (uv) chips.push('Hoy retira a ' + firstName(k.name) + ' ' + (person(uv.personId) || {}).name + ' a las ' + t2);
  }
  chips.push('¿Dónde está ' + firstName(k.name) + '?');
  if (k.routeId) chips.push(firstName(k.name) + ' hoy no va en el bus');
  chips.push(firstName(k2.name) + ' no irá mañana, tiene cita médica');
  chips.push('Estado');
  return chips;
}
function sendText(text) {
  const t = (text || '').trim();
  if (!t) return;
  apply('whatsapp_inbound', ME.role === 'parent' ? { text: t } : { text: t, chatKey: UI.phoneId }).then(render).catch(() => {});
}
function sendChat() {
  const input = document.getElementById('waInput');
  const text = input.value;
  input.value = '';
  sendText(text);
}

/* =====================================================================
   DASHBOARD ESCUELA
   ===================================================================== */
const SCHOOL_TABS = [
  ['inicio', '🏠 Inicio', null],
  ['solicitudes', '🚪 Salidas', 'ver_solicitudes'],
  ['salidas_hoy', '🛂 Garita · Hoy', 'marcar_salida'],
  ['rutas', '🚌 Rutas de bus', 'ver_rutas'],
  ['excusas', '📝 Excusas', 'ver_excusas'],
  ['estudiantes', '🎒 Estudiantes', 'ver_estudiantes'],
  ['autorizados', '👥 Autorizados', 'gestionar_autorizados'],
  ['personal', '🧑‍🏫 Personal y permisos', 'personal'],
  ['config', '⚙️ Configuración', 'config'],
  ['bitacora', '📜 Bitácora', 'bitacora'],
  ['actividad', '📊 Actividad', 'super'],
];
/* 'super' no es un permiso de rol: solo lo tiene el probador super admin (viene en la cookie). */
function availableTabs(staff) { return SCHOOL_TABS.filter(([, , cap]) => !cap || (cap === 'super' ? !!ME.super : staffCan(cap))); }
function viewSchool() {
  const staff = V.me;
  const tabs = availableTabs(staff);
  if (!tabs.some(([k]) => k === UI.schoolTab)) UI.schoolTab = staff.role === 'garita' ? 'salidas_hoy' : staff.role === 'monitora' ? 'rutas' : tabs[0][0];
  const unread = V.unread;
  const body = {
    inicio: schoolHome, solicitudes: schoolRequests, salidas_hoy: schoolGate, rutas: schoolRutas, excusas: schoolExcusas, estudiantes: schoolStudents,
    autorizados: schoolAuths, personal: schoolStaff, config: schoolConfig, bitacora: schoolLog, actividad: activityView,
  }[UI.schoolTab](staff);
  const scope = staff.routeId ? '<span class="muted">solo ' + esc((route(staff.routeId) || {}).name || staff.routeId) + '</span>' : staff.grades ? '<span class="muted">grados: ' + esc(staff.grades.join(', ')) + '</span>' : '<span class="muted">todos los niveles</span>';
  return '<div class="dash"><aside class="side"><div class="side-brand">🏫 ' + esc(V.settings.school.short) + ' Salidas<div class="small muted">' + esc(V.settings.school.name) + '</div></div>' +
    '<div class="side-user"><label class="small muted">Usuario</label><div><b>' + esc(staff.name) + '</b></div>' +
    (V.tester && V.tester.id ? '<div class="small muted">Probador: ' + esc(V.tester.name) + (ME.super ? ' · super' : '') + '</div>' : '') +
    '<div class="small"><span class="badge role-' + staff.role + '">' + esc(roleName(staff.role)) + '</span> ' + scope + '</div></div>' +
    '<nav class="side-nav">' + tabs.map(([k, l]) => '<button class="' + (UI.schoolTab === k ? 'active' : '') + '" data-action="schoolTab" data-tab="' + k + '">' + l + (k === 'inicio' && unread ? '<span class="dot">' + unread + '</span>' : '') + '</button>').join('') + '</nav></aside>' +
    '<section class="content">' + body + '</section></div>';
}
function kpi(label, value, cls = '') { return '<div class="kpi ' + cls + '"><div class="kpi-v">' + value + '</div><div class="kpi-l">' + label + '</div></div>'; }
function schoolHome(staff) {
  const reqs = V.requests;
  const t = todayISO();
  const pend = reqs.filter((r) => r.kind === 'salida' && r.status === 'pendiente');
  const aprob = reqs.filter((r) => r.kind === 'salida' && r.date === t && r.status === 'aprobada');
  const ret = reqs.filter((r) => r.kind === 'salida' && r.date === t && r.status === 'retirado');
  const exc = reqs.filter((r) => r.kind === 'excusa' && r.status === 'pendiente');
  const notifs = V.notifications.slice(-8).reverse();
  markReadSoon();
  return '<h2>Hola, ' + esc(staff.name) + '</h2><div class="kpis">' + kpi('Salidas pendientes', pend.length, 'warn') + kpi('Aprobadas hoy', aprob.length, 'ok') + kpi('Retirados hoy', ret.length) + kpi('Excusas pendientes', exc.length, 'warn') + '</div>' +
    '<div class="cols"><div><h3>Requieren acción</h3>' + (pend.length || exc.length ? pend.concat(exc).map((r) => schoolReqCard(r, staff)).join('') : '<div class="empty">Todo al día ✅</div>') + '</div>' +
    '<div><h3>Avisos recientes</h3>' + (notifs.length ? notifs.map((n) => '<div class="card notif"><div class="small muted">' + fmtTs(n.ts) + '</div>' + esc(n.text) + '</div>').join('') : '<div class="empty">Sin avisos.</div>') + '</div></div>';
}
function schoolReqCard(r, staff) {
  const st = student(r.studentId);
  const by = person(r.requestedBy) || {};
  const canApprove = staffCan('aprobar');
  const canDecide = staffCan('decidir_excusas');
  let body, actions = '';
  if (r.kind === 'salida') {
    const pk = person(r.pickupBy) || {};
    body = '<b>🚪 Salida ' + esc(fmtDate(r.date)) + ' · ' + fmtTime(r.time) + '</b><div class="small">Retira: <b>' + esc(pk.name) + '</b> (' + esc(pk.relation) + ') · céd. ' + esc(pk.cedula) + ' ' + kindBadge(r.pickupKind) + '</div><div class="small muted">Motivo: ' + esc(r.reason) + '</div>' +
      (r.pickupPoint ? '<div class="small">📍 ' + esc(r.pickupPoint) + ' · código <b class="mono">' + r.code + '</b>' + (r.autoApproved ? ' · auto-aprobada' : r.decidedBy ? ' · por ' + esc(staffName(r.decidedBy)) : '') + '</div>' : '') +
      (r.confirmation ? '<div class="small">Confirmación titular: <b>' + r.confirmation.status + '</b></div>' : '') +
      (r.status === 'retirado' ? '<div class="small">Salió ' + fmtClock(r.exitAt) + ' · garita: ' + esc(staffName(r.exitBy)) + '</div>' : '') +
      (r.status === 'rechazada' ? '<div class="small danger-text">Rechazo: ' + esc(r.rejectReason) + '</div>' : '');
    if (r.status === 'pendiente' && canApprove) {
      actions = '<div class="actions"><select class="inline" id="pp-' + r.id + '">' + V.settings.school.pickupPoints.map((x) => opt(x, x, x === V.settings.defaultPickupPoint)).join('') + '</select>' +
        '<button class="btn small primary" data-action="approve" data-id="' + r.id + '">✅ Aprobar</button><button class="btn small danger" data-action="openModal" data-modal="reject" data-id="' + r.id + '">✕ Rechazar</button></div>';
    }
  } else {
    const link = r.attachmentId ? '<a href="/api/attachments/' + esc(r.attachmentId) + '" target="_blank" rel="noopener">' + esc(r.attachmentName || 'adjunto') + '</a>' : esc(r.attachmentName || '');
    body = '<b>📝 Excusa · ' + esc(r.excusaType) + ' · ' + esc(fmtDate(r.date)) + '</b><div class="small">' + esc(r.reason) + '</div>' + (r.attachmentName ? '<div class="small">📎 ' + link + '</div>' : '<div class="small muted">Sin adjunto</div>') +
      (r.status === 'rechazada' ? '<div class="small danger-text">Rechazo: ' + esc(r.rejectReason) + '</div>' : '');
    if (r.status === 'pendiente' && canDecide) {
      actions = '<div class="actions"><button class="btn small primary" data-action="acceptExcusa" data-id="' + r.id + '">✅ Aceptar</button><button class="btn small danger" data-action="openModal" data-modal="reject" data-id="' + r.id + '">✕ Rechazar</button></div>';
    }
  }
  return '<div class="card req"><div class="row top"><span class="avatar sm">' + st.emoji + '</span><div class="grow"><div class="small muted">' + esc(st.name) + ' · ' + esc(st.grade) + ' ' + esc(levelName(st.levelId)) + ' · vía ' + CHANNEL[r.channel] + ' · solicitó ' + esc(by.name) + ' (' + esc(by.relation) + ') · ' + fmtTs(r.createdAt) + '</div>' + body + '</div>' + badge(r.status) + '</div>' +
    '<details class="hist"><summary>Historial</summary>' + r.history.map((h) => '<div class="small"><span class="muted mono">' + fmtTs(h.ts) + '</span> ' + esc(h.text) + '</div>').join('') + '</details>' + actions + '</div>';
}
function schoolRequests(staff) {
  const f = UI.filter;
  let list = V.requests.filter((r) => r.kind === 'salida');
  if (f !== 'todas') list = list.filter((r) => r.status === f);
  const filters = ['todas', 'pendiente', 'aprobada', 'retirado', 'rechazada', 'cancelada'];
  return '<h2>Solicitudes de salida</h2><div class="filters">' + filters.map((x) => '<button class="chip' + (f === x ? ' active' : '') + '" data-action="setFilter" data-f="' + x + '">' + (x === 'todas' ? 'Todas' : STATUS[x]) + '</button>').join('') + '</div>' +
    (list.length ? list.map((r) => schoolReqCard(r, staff)).join('') : '<div class="empty">No hay solicitudes con este filtro.</div>');
}
function schoolGate(staff) {
  const t = todayISO();
  const list = V.requests.filter((r) => r.kind === 'salida' && r.date === t && ['aprobada', 'retirado'].includes(r.status)).sort((a, b) => a.time.localeCompare(b.time));
  const pend = list.filter((r) => r.status === 'aprobada');
  const done = list.filter((r) => r.status === 'retirado');
  const card = (r) => {
    const st = student(r.studentId);
    const pk = person(r.pickupBy) || {};
    const uv = r.pickupKind === 'una_vez';
    const conf = r.confirmation && r.confirmation.status;
    let act = '';
    if (r.status === 'aprobada') {
      if (uv && conf !== 'confirmada') {
        act = conf === 'pendiente' ? '<span class="muted small">⏳ Esperando confirmación del titular…</span>' : conf === 'negada' ? '<span class="danger-text small">⛔ Entrega negada por el titular</span>' : '<button class="btn small" data-action="askConfirm" data-id="' + r.id + '">📲 Persona en garita: solicitar confirmación</button>';
      } else {
        act = '<button class="btn small primary" data-action="markExit" data-id="' + r.id + '">🚪 Verificar cédula y marcar retirado</button>';
      }
    }
    return '<div class="card gate ' + r.status + '"><div><div class="gate-time">' + fmtTime(r.time) + '</div>' + personDoc(pk) + '</div><div class="grow"><div class="row"><span class="avatar sm">' + st.emoji + '</span><b>' + esc(st.name) + '</b> <span class="muted small">' + esc(st.grade) + ' · ' + esc(levelName(st.levelId)) + '</span></div>' +
      '<div class="small">Retira: <b>' + esc(pk.name) + '</b> (' + esc(pk.relation) + ') · céd. <b class="mono">' + esc(pk.cedula) + '</b> ' + kindBadge(r.pickupKind) + '</div>' +
      '<div class="small">📍 ' + esc(r.pickupPoint) + ' · código <b class="mono">' + r.code + '</b>' + (conf ? ' · confirmación: <b>' + conf + '</b>' : '') + (r.status === 'retirado' ? ' · <b>salió ' + fmtClock(r.exitAt) + '</b>' : '') + '</div>' +
      '<div class="actions">' + act + '</div></div></div>';
  };
  return '<h2>Garita · salidas de hoy <span class="muted small">' + new Date().toLocaleDateString('es-PA', { weekday: 'long', day: 'numeric', month: 'long' }) + '</span> <button class="btn small primary right" data-action="openModal" data-modal="scan">📷 Escanear QR / código</button></h2><h3>Por retirar (' + pend.length + ')</h3>' + (pend.length ? pend.map(card).join('') : '<div class="empty">No hay salidas aprobadas pendientes.</div>') +
    '<h3>Retirados (' + done.length + ')</h3>' + (done.length ? done.map(card).join('') : '<div class="empty">Nadie ha salido todavía.</div>');
}
function schoolExcusas(staff) {
  const list = V.requests.filter((r) => r.kind === 'excusa');
  return '<h2>Excusas (ausencias y tardanzas)</h2>' + (list.length ? list.map((r) => schoolReqCard(r, staff)).join('') : '<div class="empty">Sin excusas.</div>');
}
function schoolStudents(staff) {
  const scope = V.students;
  return '<h2>Estudiantes y familias</h2>' + V.levels.map((lv) => {
    const kids = scope.filter((s) => s.levelId === lv.id);
    if (!kids.length) return '';
    return '<h3>' + esc(lv.name) + '</h3><table class="tbl"><tr><th>Estudiante</th><th>Grado</th><th>Titulares</th><th>Autorizados vigentes</th><th>Bus</th><th>Solicitudes</th></tr>' + kids.map((k) =>
      '<tr><td>' + k.emoji + ' ' + esc(k.name) + '</td><td>' + esc(k.grade) + '</td><td>' + k.titulares.map((t) => esc((person(t) || {}).name) + ' <span class="muted small">(' + esc((person(t) || {}).relation) + ' · ' + esc((person(t) || {}).phone) + ')</span>').join('<br>') + '</td>' +
      '<td>' + (authsForStudent(k.id).filter(isAuthActive).map((a) => esc((person(a.personId) || {}).name) + ' ' + kindBadge(a.type)).join('<br>') || '<span class="muted">—</span>') + '</td><td>' + busChip(k) + '</td><td>' + V.requests.filter((r) => r.studentId === k.id).length + '</td></tr>').join('') + '</table>';
  }).join('');
}
function schoolAuths(staff) {
  const scope = new Set(V.students.map((s) => s.id));
  const list = V.authorizations.filter((a) => scope.has(a.studentId));
  return '<h2>Personas autorizadas</h2><table class="tbl"><tr><th>Persona</th><th>Cédula</th><th>Estudiante</th><th>Tipo</th><th>Vigencia</th><th>Registró</th><th>Estado</th><th></th></tr>' + list.map((a) => {
    const p = person(a.personId) || {}; const s = student(a.studentId) || {};
    const vig = a.type === 'temporal' ? a.validFrom + ' → ' + a.validTo : a.type === 'una_vez' ? (a.usedAt ? 'usada ' + fmtTs(a.usedAt) : 'pendiente de uso') : 'permanente';
    const estado = a.revokedAt ? '<span class="badge st-rechazada">Revocada</span>' : isAuthActive(a) ? '<span class="badge st-aprobada">Activa</span>' : '<span class="badge st-cancelada">Inactiva</span>';
    const quien = (person(a.createdBy) || {}).name || staffName(a.createdBy) || '—';
    return '<tr><td>' + esc(p.name) + ' <span class="muted small">' + esc(p.relation) + (p.hasAccount ? ' · 📱 cuenta' : '') + '</span></td><td class="mono">' + esc(p.cedula) + '</td><td>' + esc(s.name) + ' <span class="muted small">' + esc(s.grade) + '</span></td><td>' + kindBadge(a.type) + '</td><td>' + vig + '</td><td>' + esc(quien) + '</td><td>' + estado + '</td>' +
      '<td>' + (!a.revokedAt ? '<button class="btn tiny danger" data-action="revokeAuthSchool" data-id="' + a.id + '">Revocar</button>' : '') + '</td></tr>';
  }).join('') + '</table>';
}
function schoolStaff(staff) {
  const caps = [['ver_solicitudes', 'Ver salidas'], ['aprobar', 'Aprobar / rechazar'], ['ver_excusas', 'Ver excusas'], ['decidir_excusas', 'Decidir excusas'], ['marcar_salida', 'Marcar salida (garita)'], ['ver_rutas', 'Ver rutas de bus'], ['marcar_bus', 'Marcar abordaje (bus)'], ['ver_estudiantes', 'Ver estudiantes'], ['gestionar_autorizados', 'Gestionar autorizados'], ['personal', 'Personal'], ['config', 'Configuración'], ['bitacora', 'Bitácora'], ['todos_niveles', 'Todos los niveles']];
  const roles = ['admin', 'recepcion', 'profesor', 'garita', 'monitora'];
  const perms = V.permissions || {};
  const matrix = V.permissions
    ? '<h2>Matriz de permisos <span class="muted small">quién puede ver y hacer qué</span></h2><table class="tbl perms"><tr><th>Permiso</th>' + roles.map((r) => '<th>' + esc(roleName(r)) + '</th>').join('') + '</tr>' +
      caps.map(([c, l]) => '<tr><td>' + l + '</td>' + roles.map((r) => '<td class="center"><input type="checkbox" data-change="togglePerm" data-role="' + r + '" data-cap="' + c + '"' + (r === 'admin' || (perms[r] || {})[c] ? ' checked' : '') + (r === 'admin' ? ' disabled' : '') + '></td>').join('') + '</tr>').join('') + '</table>' +
      '<p class="muted small">Los profesores sin "Todos los niveles" solo ven los grados que tienen asignados; las monitoras solo ven los estudiantes de su ruta.</p>'
    : '<p class="muted small">Solo Administración puede ver y editar la matriz de permisos.</p>';
  return '<h2>Personal</h2><table class="tbl"><tr><th>Nombre</th><th>Rol</th><th>Cargo</th><th>Alcance</th></tr>' + V.staff.map((s) => '<tr><td>' + esc(s.name) + '</td><td><span class="badge role-' + s.role + '">' + esc(roleName(s.role)) + '</span></td><td>' + esc(s.title || '') + '</td><td>' + (s.routeId ? 'Solo ' + esc((route(s.routeId) || {}).name || s.routeId) : s.grades ? esc(s.grades.join(', ')) : 'Todos los niveles') + '</td></tr>').join('') + '</table>' + matrix;
}
function schoolConfig() {
  const c = V.settings;
  return '<h2>Configuración</h2><form data-form="saveConfig" class="form"><div class="card">' +
    '<h3>Aprobación automática</h3><label class="check"><input type="checkbox" name="autoApprove"' + (c.autoApprove ? ' checked' : '') + '> Activar auto-aprobación de salidas</label>' +
    '<p class="small muted">Regla: la solicita un <b>titular</b>, con al menos <b>N minutos</b> de anticipación, la persona que retira es titular o autorizada "siempre"/"por tiempo" (nunca "una vez"), y el estudiante no tiene rechazos en los últimos 30 días. Todo lo demás pasa a revisión manual.</p>' +
    '<label>Minutos mínimos de anticipación <input type="number" name="minAnticipationMin" min="0" value="' + c.minAnticipationMin + '"></label>' +
    '<label>Punto de retiro por defecto <select name="defaultPickupPoint">' + c.school.pickupPoints.map((x) => opt(x, x, x === c.defaultPickupPoint)).join('') + '</select></label>' +
    '</div><div class="card"><h3>Escuela</h3><label>Nombre <input name="schoolName" value="' + esc(c.school.name) + '"></label><label>Teléfono de recepción <input name="schoolPhone" value="' + esc(c.school.phone) + '"></label>' +
    '<label>Puntos de retiro (uno por línea)<textarea name="pickupPoints" rows="3">' + esc(c.school.pickupPoints.join('\n')) + '</textarea></label>' +
    '<label>Máximo de titulares por estudiante <input type="number" name="maxTitulares" min="1" max="4" value="' + c.maxTitulares + '"></label>' +
    '<div class="grid2"><label>Inicio de clases <input type="time" name="schoolStart" value="' + c.schoolStart + '"></label><label>Fin de clases <input type="time" name="schoolEnd" value="' + c.schoolEnd + '"></label></div></div>' +
    '<div class="card"><h3>Bus escolar (GPS)</h3><label class="check"><input type="checkbox" name="simulateBus"' + (c.simulateBus ? ' checked' : '') + '> Modo demo: el bus de vuelta está en ruta ahora mismo</label>' +
    '<p class="small muted">Con el modo demo apagado, la ubicación solo se responde dentro de los horarios de ida y vuelta de cada ruta. El GPS es un simulador con la misma forma que tendría la API real del proveedor de buses.</p>' +
    '<label>Avance simulado del viaje: <b>' + Math.round(c.busProgress * 100) + '%</b> <input type="range" name="busProgress" min="0" max="100" value="' + Math.round(c.busProgress * 100) + '" data-change="busProgress"></label>' +
    '<label>Días para considerar "nueva" una autorización (aviso proactivo) <input type="number" name="newAuthDays" min="0" max="60" value="' + c.newAuthDays + '"></label></div>' +
    '<div class="card"><h3>Niveles y grados</h3>' + V.levels.map((l) => '<div class="small"><b>' + esc(l.name) + '</b>: ' + esc(l.grades.join(', ')) + '</div>').join('') + '</div>' +
    '<button class="btn primary" type="submit">Guardar</button></form>' +
    (ME.role === 'admin' ? '<div class="card" style="margin-top:14px"><h3>Datos de prueba a escala</h3><p class="small muted">Reinicia la base y genera familias ficticias (de 1 a 5 hijos, promedio 2.65) con titulares, autorizados con cédula, rutas de bus, docentes por grado y un historial de solicitudes. Útil para probar el sistema con el tamaño real de la escuela.</p>' +
    '<div class="actions"><input type="number" id="loadCount" value="700" min="50" max="3000" style="width:110px"> estudiantes <button class="btn danger" data-action="seedLoad">⚗️ Cargar datos de prueba</button></div></div>' : '');
}
function schoolLog() {
  return '<h2>Bitácora</h2>' + logTable();
}
function logTable() {
  return '<table class="tbl"><tr><th>Fecha</th><th>Actor</th><th>Evento</th></tr>' + (V.audit || []).slice(0, 200).map((l) => '<tr><td class="mono small">' + fmtTs(l.ts) + '</td><td>' + esc(l.actor) + '</td><td>' + esc(l.text) + '</td></tr>').join('') + '</table>';
}
function viewLog() { return '<div class="page"><h2>📜 Bitácora del sistema</h2>' + logTable() + '</div>'; }

/* =====================================================================
   BUS: rutas, mapa simulado, documentos y QR
   ===================================================================== */
function busChip(k) {
  const r = k.routeId && route(k.routeId);
  if (!r) return '<span class="muted small">sin bus</span>';
  const stop = r.stops.find((s) => s.id === k.stopId);
  return '<span class="bus-chip">🚌 ' + esc(r.name) + (stop ? ' · ' + esc(stop.name) : '') + (k.busLegs && k.busLegs.length === 1 ? ' · solo ' + k.busLegs[0] : '') + '</span>';
}
function personDoc(p) {
  if (p.docAttachmentId) return '<img class="doc-thumb" src="/api/attachments/' + esc(p.docAttachmentId) + '" data-action="openDoc" data-id="' + p.id + '" title="Ver documento">';
  return '<div class="doc-placeholder" data-action="openDoc" data-id="' + p.id + '" title="Ver documento">🪪<br>' + esc(p.docName || 'sin foto') + '</div>';
}
function qrBox(r) {
  return '<div class="qr-box"><div class="qrc" data-qr="IAE-' + r.code + '-' + r.id + '"></div><div><div class="small muted">Código de retiro</div><div class="qr-code">' + r.code + '</div><div class="small muted">Muéstralo en garita o dilo en voz alta</div></div></div>';
}
function routeMap(r, leg, progress, opts = {}) {
  const stops = legStops(r, leg); const W = 600; const H = opts.height || 180;
  const lats = r.stops.map((s) => s.lat); const lngs = r.stops.map((s) => s.lng);
  const minLa = Math.min(...lats), maxLa = Math.max(...lats), minLn = Math.min(...lngs), maxLn = Math.max(...lngs);
  const X = (lng) => 60 + (maxLn === minLn ? 0 : (lng - minLn) / (maxLn - minLn)) * (W - 120);
  const Y = (lat) => H - 42 - (maxLa === minLa ? 0 : (lat - minLa) / (maxLa - minLa)) * (H - 84);
  const pts = stops.map((s) => X(s.lng) + ',' + Y(s.lat)).join(' ');
  let grid = '';
  for (let x = 0; x < W; x += 60) grid += '<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + H + '" stroke="#dfe7df" stroke-width="1"/>';
  for (let y = 0; y < H; y += 60) grid += '<line x1="0" y1="' + y + '" x2="' + W + '" y2="' + y + '" stroke="#dfe7df" stroke-width="1"/>';
  let bus = '';
  if (progress != null) {
    const p = busPosition(r, leg, progress);
    bus = '<circle cx="' + X(p.lng) + '" cy="' + Y(p.lat) + '" r="15" fill="#fff" stroke="' + r.color + '" stroke-width="3"/><text x="' + X(p.lng) + '" y="' + (Y(p.lat) + 6) + '" font-size="16" text-anchor="middle">🚌</text>';
  }
  return '<svg class="map" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg"><rect width="' + W + '" height="' + H + '" fill="#eef3ee"/>' + grid +
    '<polyline points="' + pts + '" fill="none" stroke="' + r.color + '" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity=".75"/>' +
    stops.map((s, i) => '<circle cx="' + X(s.lng) + '" cy="' + Y(s.lat) + '" r="6" fill="' + (i === 0 || i === stops.length - 1 ? r.color : '#fff') + '" stroke="' + r.color + '" stroke-width="2"/><text x="' + X(s.lng) + '" y="' + (Y(s.lat) + (i % 2 ? -12 : 22)) + '" font-size="12" text-anchor="middle" fill="#374151">' + esc(s.name) + '</text>').join('') +
    bus + '</svg>';
}
function locationCard(loc) {
  const r = route(loc.routeId);
  if (!r) return '';
  return '<div class="map-wrap">' + routeMap(r, loc.leg, loc.progress, { height: 150 }) + '<span class="map-label">📍 ' + esc(loc.label) + '</span></div>' +
    '<a href="https://maps.google.com/?q=' + loc.lat.toFixed(5) + ',' + loc.lng.toFixed(5) + '" target="_blank" rel="noopener">Abrir en Google Maps · ' + loc.lat.toFixed(4) + ', ' + loc.lng.toFixed(4) + '</a>';
}
function schoolRutas(staff) {
  const can = staffCan('marcar_bus');
  const list = V.routes;
  if (!list.length) return '<h2>Rutas de bus</h2><div class="empty">No hay rutas registradas.</div>';
  return '<h2>Rutas de bus <span class="muted small">' + (V.settings.simulateBus ? 'modo demo: GPS simulado en ruta' : 'GPS según horario') + '</span></h2>' + list.map((r) => {
    const cur = currentLeg(r);
    const leg = cur ? cur.leg : (minutesOf(nowHHMM()) < minutesOf(r.schedule.vuelta.start) ? 'ida' : 'vuelta');
    const trip = getTrip(r.id, leg);
    const stops = legStops(r, leg);
    const kids = V.students.filter((s) => s.routeId === r.id && (!s.busLegs || s.busLegs.includes(leg)));
    const pos = cur ? busPosition(r, cur.leg, cur.progress) : null;
    const statusLabel = { en_ruta: 'En ruta', finalizado: 'Finalizado', programado: 'Programado' }[trip.status];
    const head = '<div class="route-head"><div><b style="font-size:16px">🚌 ' + esc(r.name) + '</b> <span class="muted small">placa ' + esc(r.plate) + ' · conductor ' + esc(r.driver) + ' · monitora ' + esc(staffName(r.monitorId) || '—') + '</span>' +
      '<div class="small muted">Ida ' + fmtTime(r.schedule.ida.start) + ' – ' + fmtTime(r.schedule.ida.end) + ' · Vuelta ' + fmtTime(r.schedule.vuelta.start) + ' – ' + fmtTime(r.schedule.vuelta.end) + '</div></div>' +
      '<div><span class="badge st-' + trip.status + '">' + statusLabel + '</span> <span class="small muted">' + LEG_NAMES[leg] + (cur ? (cur.simulated ? ' · GPS simulado' : ' · GPS en vivo') : ' · fuera de horario') + '</span> ' +
      (can ? (trip.status !== 'en_ruta' ? '<button class="btn tiny primary" data-action="tripStatus" data-route="' + r.id + '" data-leg="' + leg + '" data-status="en_ruta">▶ Iniciar viaje</button>' : '<button class="btn tiny" data-action="tripStatus" data-route="' + r.id + '" data-leg="' + leg + '" data-status="finalizado">⏹ Finalizar viaje</button>') : '') + '</div></div>';
    const map = '<div class="map-wrap" style="margin:10px 0">' + routeMap(r, leg, pos ? cur.progress : null, { height: 180 }) + '<span class="map-label">' + (pos ? '🚌 próxima parada: ' + esc(pos.nextStop.name) + ' · termina en ~' + pos.minutesLeft + ' min' : 'Bus fuera de horario') + '</span></div>';
    const rows = kids.map((k) => {
      const rec = trip.boarded[k.id]; const nb = trip.noBus.includes(k.id); const stop = r.stops.find((s) => s.id === k.stopId);
      const status = nb ? '<span class="badge st-nobus">Hoy no va</span>' : rec ? '<span class="badge st-' + rec.status + '">' + ({ abordo: 'A bordo', bajo: 'Bajó', no_abordo: 'No abordó' })[rec.status] + '</span> <span class="muted small">' + fmtClock12(rec.ts) + '</span>' : '<span class="muted small">sin marcar</span>';
      const b = (status2, label, cls, stopId) => '<button class="btn tiny ' + cls + '" data-action="board" data-route="' + r.id + '" data-leg="' + leg + '" data-id="' + k.id + '" data-status="' + status2 + '" data-stop="' + stopId + '">' + label + '</button> ';
      const btns = can && !nb ? b('abordo', '✅ Abordó', '', leg === 'ida' ? k.stopId : stops[0].id) + b('bajo', '🏁 Bajó', '', leg === 'ida' ? stops[stops.length - 1].id : k.stopId) + b('no_abordo', '✕ No abordó', 'danger', '') : '';
      return '<tr><td>' + k.emoji + ' ' + esc(k.name) + ' <span class="muted small">' + esc(k.grade) + '</span></td><td>' + (stop ? esc(stop.name) : '—') + '</td><td>' + status + '</td><td>' + btns + '</td></tr>';
    }).join('');
    return '<div class="card route-card" style="border-left-color:' + r.color + '">' + head + map + '<table class="tbl" style="margin-bottom:0"><tr><th>Estudiante</th><th>Parada</th><th>Estado hoy</th><th></th></tr>' + (rows || '<tr><td colspan="4" class="muted">Sin estudiantes en este tramo.</td></tr>') + '</table></div>';
  }).join('');
}

/* =====================================================================
   MODALES (formularios)
   ===================================================================== */
function renderModal() {
  const box = document.getElementById('modal');
  if (!UI.modal) { box.className = 'modal hidden'; box.innerHTML = ''; T.modal(null); return; }
  const m = UI.modal;
  const content = { newSalida: modalSalida, newExcusa: modalExcusa, newAuth: modalAuth, reject: modalReject, guide: modalGuide, where: modalWhere, scan: modalScan, doc: modalDoc }[m.type](m.data || {});
  box.className = 'modal';
  box.innerHTML = '<div class="modal-card"><button class="modal-x" data-action="closeModal">✕</button>' + content + '</div>';
  T.modal(m.type);
}
function modalSalida(d) {
  const p = V.me;
  const kids = studentsOf(p.id);
  const sid = d.studentId || kids[0].id;
  const cands = pickupCandidates(sid);
  const defTime = addMinutes(nowHHMM(), 120);
  return '<h3>🚪 Solicitar salida temprana</h3><form data-form="newSalida" class="form">' +
    '<label>Estudiante <select name="studentId" data-change="modalField">' + kids.map((k) => opt(k.id, k.name + ' · ' + k.grade, k.id === sid)).join('') + '</select></label>' +
    '<div class="grid2"><label>Fecha <input type="date" name="date" value="' + (d.date || todayISO()) + '" min="' + todayISO() + '" required></label><label>Hora <input type="time" name="time" value="' + (d.time || defTime) + '" required></label></div>' +
    '<label>¿Quién retira? <select name="pickupBy">' + cands.map((c) => opt(c.person.id, (c.person.id === p.id ? 'Yo · ' : '') + c.person.name + ' (' + c.person.relation + ') · ' + kindLabel(c.kind), c.person.id === (d.pickupBy || p.id))).join('') + '</select></label>' +
    '<label>Motivo <input name="reason" value="' + esc(d.reason || '') + '" placeholder="Cita médica, viaje, etc." required></label>' +
    '<p class="small muted">Si cumples la regla de auto-aprobación (titular, anticipación ≥ ' + V.settings.minAnticipationMin + ' min, persona autorizada vigente) se aprueba al instante.</p>' +
    '<div class="actions"><button class="btn primary" type="submit">Enviar solicitud</button><button class="btn" type="button" data-action="closeModal">Cancelar</button></div></form>';
}
function modalExcusa(d) {
  const p = V.me;
  const kids = studentsOf(p.id);
  return '<h3>📝 Enviar excusa</h3><form data-form="newExcusa" class="form">' +
    '<label>Estudiante <select name="studentId">' + kids.map((k) => opt(k.id, k.name + ' · ' + k.grade, k.id === d.studentId)).join('') + '</select></label>' +
    '<div class="grid2"><label>Fecha <input type="date" name="date" value="' + (d.date || shiftISO(1)) + '" required></label><label>Tipo <select name="excusaType">' + opt('ausencia', 'Ausencia', true) + opt('tardanza', 'Tardanza') + '</select></label></div>' +
    '<label>Motivo <textarea name="reason" rows="2" required placeholder="Cita médica, enfermedad, trámite…"></textarea></label>' +
    '<label>Adjuntar certificado / foto (opcional) <input type="file" name="attachment" accept="image/*,.pdf"></label>' +
    '<div class="actions"><button class="btn primary" type="submit">Enviar excusa</button><button class="btn" type="button" data-action="closeModal">Cancelar</button></div></form>';
}
function modalAuth(d) {
  const p = V.me;
  const kids = studentsOf(p.id);
  const mode = d.mode || 'nueva';
  const type = d.type || 'siempre';
  return '<h3>👥 Autorizar persona para retirar</h3><form data-form="newAuth" class="form">' +
    '<div class="label">Estudiantes</div><div class="checks">' + kids.map((k) => '<label class="check"><input type="checkbox" name="studentIds" value="' + k.id + '" checked> ' + k.emoji + ' ' + esc(k.name) + '</label>').join('') + '</div>' +
    '<div class="label">Persona</div><div class="radios"><label class="check"><input type="radio" name="mode" value="nueva" data-change="modalField"' + (mode === 'nueva' ? ' checked' : '') + '> Nueva persona (sin cuenta)</label><label class="check"><input type="radio" name="mode" value="cuenta" data-change="modalField"' + (mode === 'cuenta' ? ' checked' : '') + '> Padre/madre que ya tiene cuenta</label></div>' +
    (mode === 'nueva'
      ? '<div class="grid2"><label>Nombre completo <input name="name" required value="' + esc(d.name || '') + '"></label><label>Parentesco <input name="relation" required placeholder="Abuela, Tío, Chofer…" value="' + esc(d.relation || '') + '"></label><label>Cédula <input name="cedula" required placeholder="8-123-456" value="' + esc(d.cedula || '') + '"></label><label>Teléfono <input name="phone" placeholder="+507 6xxx-xxxx" value="' + esc(d.phone || '') + '"></label></div>'
      : '<label>Cuenta <select name="personId">' + V.accounts.map((a) => opt(a.id, a.name + ' · ' + a.relation, a.id === d.personId)).join('') + '</select></label>') +
    '<label>Foto de la persona o de su cédula' + (mode === 'nueva' ? ' (obligatoria)' : ' (opcional, ya tiene cuenta)') + ' <input type="file" name="docFile" accept="image/*"' + (mode === 'nueva' ? ' required' : '') + '></label>' +
    '<p class="small muted">La garita verá esta imagen junto al código de retiro para verificar la identidad.</p>' +
    '<label>Tipo de autorización <select name="type" data-change="modalField">' + Object.keys(AUTH_TYPES).map((k) => opt(k, AUTH_TYPES[k], k === type)).join('') + '</select></label>' +
    (type === 'temporal' ? '<div class="grid2"><label>Desde <input type="date" name="from" value="' + (d.from || todayISO()) + '" required></label><label>Hasta <input type="date" name="to" value="' + (d.to || shiftISO(14)) + '" required></label></div>' : '') +
    (type === 'una_vez' ? '<p class="small muted">La autorización sirve para un solo retiro. Cuando la persona llegue a la garita, la escuela te pedirá confirmar por WhatsApp antes de entregar al estudiante.</p>' : '') +
    '<div class="actions"><button class="btn primary" type="submit">Guardar autorización</button><button class="btn" type="button" data-action="closeModal">Cancelar</button></div></form>';
}
function modalReject(d) {
  const r = request(d.id);
  const st = student(r.studentId);
  return '<h3>✕ Rechazar ' + (r.kind === 'salida' ? 'salida' : 'excusa') + ' de ' + esc(st.name) + '</h3><form data-form="reject" class="form"><input type="hidden" name="id" value="' + r.id + '">' +
    '<label>Motivo (se envía al padre) <textarea name="reason" rows="3" required placeholder="Ej.: examen en curso, no hay autorización vigente…"></textarea></label>' +
    '<div class="actions"><button class="btn danger" type="submit">Rechazar y notificar</button><button class="btn" type="button" data-action="closeModal">Cancelar</button></div></form>';
}
function modalWhere(d) {
  const st = student(d.id); const w = d.result;
  return '<h3>📍 ¿Dónde está ' + esc(firstName(st.name)) + '?</h3><div class="where-box">' + (w ? esc(w.text) : 'Consultando…') + '</div>' + (w && w.location ? '<div style="margin-top:10px">' + locationCard(w.location) + '</div>' : '') +
    '<p class="small muted" style="margin-top:8px">La ubicación solo se muestra a titulares, dentro del horario de la ruta, y proviene del GPS del bus (simulado en este demo).</p>' +
    '<div class="actions"><button class="btn primary" data-action="closeModal">Cerrar</button></div>';
}
function modalScan(d) {
  if (d.found) {
    const r = request(d.found); const st = student(r.studentId); const pk = person(r.pickupBy) || {};
    const el = pickupEligibility(r.studentId, r.pickupBy);
    return '<h3>✅ Código válido · ' + r.code + '</h3><div class="row" style="align-items:flex-start; gap:14px">' +
      (pk.docAttachmentId ? '<img class="doc-big" style="max-width:220px; margin:0" src="/api/attachments/' + esc(pk.docAttachmentId) + '">' : '<div class="doc-placeholder" style="width:120px;height:120px;font-size:13px">🪪<br>' + esc(pk.docName || 'sin foto') + '</div>') +
      '<div><div style="font-size:18px"><b>' + esc(pk.name) + '</b> <span class="muted">(' + esc(pk.relation) + ')</span></div><div>Cédula: <b class="mono">' + esc(pk.cedula) + '</b> · ' + kindBadge(el.kind || r.pickupKind) + '</div>' +
      '<div style="margin-top:8px">Retira a <b>' + st.emoji + ' ' + esc(st.name) + '</b> · ' + esc(st.grade) + '</div><div class="small muted">Salida ' + fmtTime(r.time) + ' · ' + esc(r.pickupPoint) + '</div>' +
      ((el.kind || r.pickupKind) === 'una_vez' && !(r.confirmation && r.confirmation.status === 'confirmada') ? '<div class="small danger-text" style="margin-top:6px">Autorización de una sola vez: falta la confirmación del titular.</div>' : '') + '</div></div>' +
      '<div class="actions"><button class="btn primary" data-action="markExit" data-id="' + r.id + '">🚪 Identidad verificada · marcar retirado</button><button class="btn" type="button" data-action="closeModal">Cancelar</button></div>';
  }
  const today = V.requests.filter((r) => r.kind === 'salida' && r.status === 'aprobada' && r.date === todayISO());
  return '<h3>📷 Escanear QR o escribir código</h3><form data-form="scan" class="form"><label>Código de retiro <input name="code" placeholder="Ej. 3811" autofocus required></label>' +
    '<p class="small muted">En producción la cámara del teléfono de garita lee el QR que el padre o el autorizado muestra en su app.' + (today.length ? ' Aprobadas hoy (solo para el demo): ' + today.map((r) => r.code).join(', ') : '') + '</p>' +
    '<div class="actions"><button class="btn primary" type="submit">Buscar</button><button class="btn" type="button" data-action="closeModal">Cancelar</button></div></form>';
}
function modalDoc(d) {
  const p = person(d.id) || {};
  return '<h3>🪪 ' + esc(p.name) + ' <span class="muted small">' + esc(p.relation) + ' · céd. ' + esc(p.cedula) + '</span></h3>' +
    (p.docAttachmentId ? '<img class="doc-big" src="/api/attachments/' + esc(p.docAttachmentId) + '">' : '<div class="empty">Documento registrado: <b>' + esc(p.docName || '—') + '</b><br><span class="small">(dato de ejemplo sin imagen; los autorizados nuevos guardan la foto real)</span></div>') +
    '<div class="actions"><button class="btn primary" data-action="closeModal">Cerrar</button></div>';
}
function modalGuide() {
  return '<h3>📖 Guion sugerido para el demo</h3><ol class="guide">' +
    '<li><b>WhatsApp · Carlos (papá):</b> toca el chip "Necesito retirar a Joseph hoy a las …" (2 h de anticipación). Confirma con <i>Sí</i>. Como cumple la regla, se <b>auto-aprueba</b>: llega el punto de retiro y el código a Carlos y a Ana.</li>' +
    '<li><b>WhatsApp · Carlos:</b> "A Joseph lo va a retirar la abuela a las …" (30 min). Queda <b>pendiente</b> por poca anticipación. Cambia a <b>Escuela · Recepción</b>, elige el punto de retiro y aprueba. Mira la notificación al padre.</li>' +
    '<li><b>Escuela · Garita (Manuel):</b> en "Garita · Hoy" verifica la cédula y marca <b>retirado</b>. Ambos padres reciben "Joseph fue retirado a las …".</li>' +
    '<li><b>Autorización de una sola vez:</b> Carlos envía "Hoy retira a Joseph Laura Gómez a las …". Recepción aprueba. En Garita, pulsa <b>solicitar confirmación</b>: Carlos y Ana reciben "¿Confirmas?". Responde <i>Sí, confirmo</i> desde WhatsApp y luego marca retirado. Laura (que tiene cuenta) también ve la autorización en su app.</li>' +
    '<li><b>Excusa:</b> "Sofía no irá mañana, tiene cita médica" → adjunta certificado → Recepción acepta → la profesora de Kínder lo ve en su bandeja.</li>' +
    '<li><b>App Padres:</b> muestra hijos, solicitudes, autorizados (siempre / por tiempo / una vez), y agrega un autorizado nuevo o un padre con cuenta.</li>' +
    '<li><b>Permisos:</b> en otro dispositivo inicia sesión como Prof. Diana Ríos (solo ve 3°) y luego como Administración para editar la matriz de permisos y la regla de auto-aprobación.</li>' +
    '<li><b>Bus:</b> en WhatsApp escribe "¿Dónde está Joseph?": responde con el bus, la próxima parada, el tiempo de llegada y el mapa GPS (simulado). Después de marcarlo retirado en garita, la misma pregunta responde "salió por Puerta Principal a las …, confirmó el oficial …".</li>' +
    '<li><b>Monitora:</b> inicia sesión como Kenia Pérez (solo ve el Bus 12), marca Abordó / Bajó / No abordó e inicia o finaliza el viaje. Escribe "Sofía hoy no va en el bus" desde WhatsApp y mira cómo le llega a la monitora.</li>' +
    '<li><b>Aviso proactivo:</b> aprueba una salida donde retira Laura Gómez (una vez) o Luis (por tiempo): los titulares reciben un aviso con botones "Es correcto / NO"; con NO se cancela la salida y se avisa a garita.</li>' +
    '<li><b>QR:</b> en App Padres la salida aprobada muestra el QR y el código; en Garita usa "Escanear QR / código" para ver la foto o cédula del autorizado y marcar el retiro. Al registrar un autorizado nuevo, la foto o cédula es obligatoria.</li>' +
    '<li>Como Administración, activa <b>Vista dividida</b> para ver WhatsApp y el dashboard a la vez; cada dispositivo del demo entra con su propio usuario.</li></ol>' +
    '<div class="actions"><button class="btn primary" data-action="closeModal">Entendido</button></div>';
}

/* =====================================================================
   EVENTOS
   ===================================================================== */
function formData(form) {
  const fd = new FormData(form);
  const o = {};
  for (const [k, v] of fd.entries()) {
    if (o[k] !== undefined) { o[k] = [].concat(o[k], v); } else { o[k] = v; }
  }
  return o;
}
/* run: ejecuta un comando, repinta y avisa. Devuelve null si el servidor lo rechazó (apply ya mostró el error). */
function run(name, input, okText) {
  return apply(name, input).then((res) => { render(); if (okText) toast(okText, 'ok'); return res; }).catch(() => null);
}
const ACTIONS = {
  setView(el) { UI.view = el.dataset.view; },
  logout() { doLogout(); },
  switchUser() { showSwitch(); },
  resetDemo() { if (confirm('¿Reiniciar el demo con los datos de ejemplo?')) run('reset_demo', {}, 'Demo reiniciado con datos de ejemplo').then(() => { UI.modal = null; render(); }); },
  seedLoad() {
    const n = Math.max(50, Math.min(3000, +(document.getElementById('loadCount') || {}).value || 700));
    if (!confirm('Esto borra todos los datos actuales y carga ' + n + ' estudiantes de prueba. ¿Continuar?')) return;
    setBadge('cargando datos…');
    run('seed_load', { students: n }).then((c) => { if (c) toast('Cargados ' + c.students + ' estudiantes en ' + c.families + ' familias', 'ok'); });
  },
  showGuide() { UI.modal = { type: 'guide' }; },
  closeModal() { UI.modal = null; },
  openModal(el) { UI.modal = { type: el.dataset.modal, data: { id: el.dataset.id } }; },
  parentTab(el) { UI.parentTab = el.dataset.tab; },
  schoolTab(el) { UI.schoolTab = el.dataset.tab; },
  setFilter(el) { UI.filter = el.dataset.f; },
  chatSend() { sendChat(); },
  chatQuick(el) { sendText(el.dataset.text); },
  cancelReq(el) { if (confirm('¿Cancelar esta solicitud?')) run('cancel_request', { requestId: el.dataset.id }); },
  revokeAuth(el) { if (confirm('¿Revocar esta autorización?')) run('revoke_authorization', { authorizationId: el.dataset.id }); },
  revokeAuthSchool(el) { if (confirm('¿Revocar esta autorización?')) run('revoke_authorization', { authorizationId: el.dataset.id }); },
  approve(el) {
    const sel = document.getElementById('pp-' + el.dataset.id);
    run('approve_request', { requestId: el.dataset.id, pickupPoint: sel ? sel.value : V.settings.defaultPickupPoint }, 'Salida aprobada y padres notificados');
  },
  acceptExcusa(el) { run('accept_excusa', { requestId: el.dataset.id }, 'Excusa aceptada'); },
  askConfirm(el) { run('request_confirmation', { requestId: el.dataset.id }, 'Se pidió confirmación a los titulares por WhatsApp'); },
  markExit(el) {
    const r = request(el.dataset.id);
    const pk = person(r.pickupBy) || {};
    if (!confirm('¿Verificaste la cédula ' + pk.cedula + ' de ' + pk.name + ' (' + pk.relation + ')?\nCódigo de retiro: ' + r.code)) return;
    run('mark_exit', { requestId: r.id }, 'Salida registrada. Padres notificados.').then((res) => { if (res) { UI.modal = null; render(); } });
  },
  whereKid(el) {
    UI.modal = { type: 'where', data: { id: el.dataset.id } };
    apply('where_is', { studentId: el.dataset.id })
      .then((w) => { if (UI.modal && UI.modal.type === 'where' && UI.modal.data.id === el.dataset.id) { UI.modal.data.result = w; renderModal(); } })
      .catch(() => { UI.modal = null; renderModal(); });
  },
  noBusKid(el) { if (confirm('¿Avisar a la monitora que hoy no va en el bus (ida y vuelta)?')) run('mark_no_bus', { studentId: el.dataset.id, legs: ['ida', 'vuelta'] }, 'Aviso enviado a la monitora'); },
  openDoc(el) { UI.modal = { type: 'doc', data: { id: el.dataset.id } }; },
  board(el) { run('mark_boarding', { routeId: el.dataset.route, leg: el.dataset.leg, studentId: el.dataset.id, status: el.dataset.status, stopId: el.dataset.stop || null }); },
  tripStatus(el) { run('set_trip_status', { routeId: el.dataset.route, leg: el.dataset.leg, status: el.dataset.status }); },
};
Object.assign(ACTIONS, ACTIVITY_ACTIONS);
function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) {
    if (e.target.id === 'modal' && V) { UI.modal = null; renderModal(); }
    return;
  }
  const fn = ACTIONS[el.dataset.action];
  if (!fn || !V) return;
  fn(el);
  render();
}
const FORMS = {
  newSalida(d) {
    run('create_salida', { studentId: d.studentId, date: d.date, time: d.time, pickupBy: d.pickupBy, reason: d.reason }).then((r) => {
      if (!r) return;
      UI.modal = null; UI.parentTab = 'solicitudes'; render();
      toast(r.status === 'aprobada' ? 'Solicitud auto-aprobada ✅' : 'Solicitud enviada, pendiente de la escuela', 'ok');
    });
  },
  async newExcusa(d, form) {
    const file = form.querySelector('input[name=attachment]').files[0] || null;
    let attachmentId = null, attachmentName = null;
    if (file) {
      const up = await run('upload_attachment', await api.filePayload(file, 'certificado'));
      if (!up) return;
      attachmentId = up.attachmentId; attachmentName = file.name;
    }
    const r = await run('create_excusa', { studentId: d.studentId, date: d.date, excusaType: d.excusaType, reason: d.reason, attachmentId, attachmentName });
    if (!r) return;
    UI.modal = null; UI.parentTab = 'solicitudes'; render(); toast('Excusa enviada', 'ok');
  },
  async newAuth(d, form) {
    const ids = [].concat(d.studentIds || []);
    if (!ids.length) { alert('Elige al menos un estudiante.'); return; }
    if (d.type === 'temporal' && d.to < d.from) { alert('La fecha "hasta" debe ser posterior a "desde".'); return; }
    const file = form.querySelector('input[name=docFile]').files[0] || null;
    if (d.mode === 'nueva' && !file) { alert('Sube una foto de la persona o de su cédula.'); return; }
    let attachmentId = null;
    if (file) {
      const up = await run('upload_attachment', await api.filePayload(file, 'cedula'));
      if (!up) return;
      attachmentId = up.attachmentId;
    }
    const r = await run('add_authorization', { studentIds: ids, mode: d.mode, personId: d.personId, name: d.name, relation: d.relation, cedula: d.cedula, phone: d.phone, attachmentId, type: d.type, from: d.from, to: d.to });
    if (!r) return;
    UI.modal = null; UI.parentTab = 'autorizados'; render(); toast('Autorización guardada', 'ok');
  },
  scan(d) {
    run('scan_code', { code: d.code }).then((res) => { if (res) { UI.modal = { type: 'scan', data: { found: res.requestId } }; render(); } });
  },
  reject(d) {
    run('reject_request', { requestId: d.id, reason: d.reason }, 'Rechazada y padres notificados').then((r) => { if (r) { UI.modal = null; render(); } });
  },
  saveConfig(d) {
    run('update_settings', { data: {
      autoApprove: d.autoApprove === 'on', minAnticipationMin: +d.minAnticipationMin, maxTitulares: +d.maxTitulares,
      schoolStart: d.schoolStart, schoolEnd: d.schoolEnd, simulateBus: d.simulateBus === 'on', busProgress: (+d.busProgress || 0) / 100,
      newAuthDays: +d.newAuthDays, defaultPickupPoint: d.defaultPickupPoint,
      school: { name: d.schoolName, phone: d.schoolPhone, pickupPoints: String(d.pickupPoints || '').split('\n').map((x) => x.trim()).filter(Boolean) },
    } }, 'Configuración guardada');
  },
};
function onSubmit(e) {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fn = FORMS[form.dataset.form];
  if (!fn || !V) return;
  T.formSubmitted(form.dataset.form);
  fn(formData(form), form);
}
function onChange(e) {
  const el = e.target.closest('[data-change]');
  if (!el || !V) return;
  const k = el.dataset.change;
  if (k.startsWith('act')) { activityChange(el); return; }
  if (k === 'setPhone') { UI.phoneId = el.value; render(); return; }
  if (k === 'busProgress') { const b = el.closest('label').querySelector('b'); if (b) b.textContent = el.value + '%'; return; } // se guarda con "Guardar"
  if (k === 'togglePerm') { run('set_permission', { role: el.dataset.role, capability: el.dataset.cap, allowed: el.checked }); return; }
  if (k === 'modalField') { const form = el.closest('form'); UI.modal.data = Object.assign({}, UI.modal.data, formData(form)); renderModal(); }
}
