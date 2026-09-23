/* =====================================================================
   IAE Salidas · Interfaz: dashboard de la escuela
   Barra lateral, inicio, salidas, excusas, estudiantes, autorizados, personal, configuración y bitácora.
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
];
function availableTabs(staff) { return SCHOOL_TABS.filter(([, , cap]) => !cap || staffCan(cap)); }
function viewSchool() {
  const staff = V.me;
  const tabs = availableTabs(staff);
  if (!tabs.some(([k]) => k === UI.schoolTab)) UI.schoolTab = staff.role === 'garita' ? 'salidas_hoy' : staff.role === 'monitora' ? 'rutas' : tabs[0][0];
  const unread = V.unread;
  const body = {
    inicio: schoolHome, solicitudes: schoolRequests, salidas_hoy: schoolGate, rutas: schoolRutas, excusas: schoolExcusas, estudiantes: schoolStudents,
    autorizados: schoolAuths, personal: schoolStaff, config: schoolConfig, bitacora: schoolLog,
  }[UI.schoolTab](staff);
  const scope = staff.routeId ? '<span class="muted">solo ' + esc((route(staff.routeId) || {}).name || staff.routeId) + '</span>' : staff.grades ? '<span class="muted">grados: ' + esc(staff.grades.join(', ')) + '</span>' : '<span class="muted">todos los niveles</span>';
  return '<div class="dash"><aside class="side"><div class="side-brand">🏫 ' + esc(V.settings.school.short) + ' Salidas<div class="small muted">' + esc(V.settings.school.name) + '</div></div>' +
    '<div class="side-user"><label class="small muted">Usuario</label><div><b>' + esc(staff.name) + '</b></div>' +
    (V.tester && V.tester.id ? '<div class="small muted">Probador: ' + esc(V.tester.name) + '</div>' : '') +
    '<div class="small"><span class="badge role-' + staff.role + '">' + esc(roleName(staff.role)) + '</span> ' + scope + '</div></div>' +
    (SEARCH_TABS.includes(UI.schoolTab) ? '<div class="side-search"><input id="schoolSearch" type="search" placeholder="Buscar…  (tecla /)" value="' + esc(UI.q) + '" autocomplete="off"><div class="small muted">nombre, grado, cédula, teléfono, código</div></div>' : '') +
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
    '<div>' + (staffCan('ver_solicitudes') ? '<div class="card summary-card"><div class="row"><div class="grow"><b>📊 Resumen del día</b><div class="small muted">Salidas, excusas, tiempos y quién retiró más. Se puede enviar a Dirección.</div></div><button class="btn small primary" data-action="daySummary">Ver resumen</button></div></div>' : '') +
    '<h3>Avisos recientes</h3>' + (notifs.length ? notifs.map((n) => '<div class="card notif"><div class="small muted">' + fmtTs(n.ts) + '</div>' + esc(n.text) + '</div>').join('') : '<div class="empty">Sin avisos.</div>') + '</div></div>';
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
  return '<div class="card req"><div class="row top"><span class="avatar sm">' + esc(st.emoji) + '</span><div class="grow"><div class="small muted">' + esc(st.name) + ' · ' + esc(st.grade) + ' ' + esc(levelName(st.levelId)) + ' · vía ' + CHANNEL[r.channel] + ' · solicitó ' + esc(by.name) + ' (' + esc(by.relation) + ') · ' + fmtTs(r.createdAt) + '</div>' + body + '</div>' + badge(r.status, r.expired) + '</div>' +
    '<details class="hist"><summary>Historial</summary>' + r.history.map((h) => '<div class="small"><span class="muted mono">' + fmtTs(h.ts) + '</span> ' + esc(h.text) + '</div>').join('') + '</details>' + actions + '</div>';
}
function schoolRequests(staff) {
  const f = UI.filter;
  let list = V.requests.filter((r) => r.kind === 'salida');
  if (f !== 'todas') list = list.filter((r) => r.status === f);
  const total = list.length;
  list = list.filter((r) => matchQ(requestQ(r)));
  const filters = ['todas', 'pendiente', 'aprobada', 'retirado', 'rechazada', 'cancelada'];
  /* R3: the local list only covers hoy + pendientes + últimos 14 días -- a non-empty search also
     reaches into the history via `search_requests`, appended below the window's own matches (never
     duplicating an id already shown). */
  ensureHistorySearch(UI.q, f);
  const shownIds = new Set(list.map((r) => r.id));
  const historic = UI.q.trim() && historySearch.status === 'done' ? historySearch.results.filter((r) => !shownIds.has(r.id)) : [];
  const historyHint = UI.q.trim() && historySearch.status === 'loading' ? '<div class="search-hint">🔎 buscando en el histórico…</div>' : '';
  return '<h2>Solicitudes de salida</h2><div class="filters">' + filters.map((x) => '<button class="chip' + (f === x ? ' active' : '') + '" data-action="setFilter" data-f="' + x + '">' + (x === 'todas' ? 'Todas' : STATUS[x]) + '</button>').join('') + '</div>' + searchHint(list.length, total) + historyHint +
    (list.length ? list.slice(0, 200).map((r) => schoolReqCard(r, staff)).join('') + (list.length > 200 ? '<div class="empty">Mostrando 200 de ' + list.length + '. Afina la búsqueda.</div>' : '') : '<div class="empty">No hay solicitudes con este filtro.</div>') +
    (historic.length ? '<h3>En el histórico (más de 14 días)</h3>' + historic.map((r) => schoolReqCard(r, staff)).join('') : '');
}
function schoolExcusas(staff) {
  const all = V.requests.filter((r) => r.kind === 'excusa');
  const list = all.filter((r) => matchQ(requestQ(r)));
  return '<h2>Excusas (ausencias y tardanzas)</h2>' + searchHint(list.length, all.length) + (list.length ? list.slice(0, 200).map((r) => schoolReqCard(r, staff)).join('') : '<div class="empty">Sin excusas.</div>');
}
function schoolStudents(staff) {
  const scope = V.students.filter((s) => matchQ(studentQ(s), authsForStudent(s.id).filter((a) => isAuthActive(a)).map((a) => personQ(a.personId)), (route(s.routeId) || {}).name));
  return '<h2>Estudiantes y familias</h2>' + searchHint(scope.length, V.students.length) + (scope.length ? '' : '<div class="empty">Ningún estudiante coincide.</div>') + V.levels.map((lv) => {
    const kids = scope.filter((s) => s.levelId === lv.id);
    if (!kids.length) return '';
    return '<h3>' + esc(lv.name) + '</h3><table class="tbl"><tr><th>Estudiante</th><th>Grado</th><th>Titulares</th><th>Autorizados vigentes</th><th>Bus</th><th>Solicitudes</th></tr>' + kids.map((k) =>
      '<tr><td>' + esc(k.emoji) + ' ' + esc(k.name) + '</td><td>' + esc(k.grade) + '</td><td>' + k.titulares.map((t) => esc((person(t) || {}).name) + ' <span class="muted small">(' + esc((person(t) || {}).relation) + ' · ' + esc((person(t) || {}).phone) + ')</span>').join('<br>') + '</td>' +
      '<td>' + (authsForStudent(k.id).filter((a) => isAuthActive(a)).map((a) => esc((person(a.personId) || {}).name) + ' ' + kindBadge(a.type)).join('<br>') || '<span class="muted">—</span>') + '</td><td>' + busChip(k) + '</td><td>' + V.requests.filter((r) => r.studentId === k.id).length + '</td></tr>').join('') + '</table>';
  }).join('');
}
function schoolAuths(staff) {
  const scope = new Set(V.students.map((s) => s.id));
  const all = V.authorizations.filter((a) => scope.has(a.studentId));
  const list = all.filter((a) => matchQ(personQ(a.personId), studentQ(student(a.studentId)), kindLabel(a.type), a.revokedAt ? 'revocada' : isAuthActive(a) ? 'activa' : 'inactiva'));
  return '<h2>Personas autorizadas</h2>' + searchHint(list.length, all.length) + (list.length ? '' : '<div class="empty">Ninguna autorización coincide.</div>') + '<table class="tbl"><tr><th>Persona</th><th>Cédula</th><th>Estudiante</th><th>Tipo</th><th>Vigencia</th><th>Registró</th><th>Estado</th><th></th></tr>' + list.map((a) => {
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
  const people = V.staff.filter((s) => matchQ(s.name, roleName(s.role), s.title, s.grades, (route(s.routeId) || {}).name));
  return '<h2>Personal</h2>' + searchHint(people.length, V.staff.length) + '<table class="tbl"><tr><th>Nombre</th><th>Rol</th><th>Cargo</th><th>Alcance</th></tr>' + people.map((s) => '<tr><td>' + esc(s.name) + '</td><td><span class="badge role-' + s.role + '">' + esc(roleName(s.role)) + '</span></td><td>' + esc(s.title || '') + '</td><td>' + (s.routeId ? 'Solo ' + esc((route(s.routeId) || {}).name || s.routeId) : s.grades ? esc(s.grades.join(', ')) : 'Todos los niveles') + '</td></tr>').join('') + '</table>' + matrix;
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
    (ME.role === 'admin' && V.demoMode !== false ? '<div class="card" style="margin-top:14px"><h3>Datos de prueba a escala</h3><p class="small muted">Reinicia la base y genera familias ficticias (de 1 a 5 hijos, promedio 2.65) con titulares, autorizados con cédula, rutas de bus, docentes por grado y un historial de solicitudes. Útil para probar el sistema con el tamaño real de la escuela.</p>' +
    '<div class="actions"><input type="number" id="loadCount" value="700" min="50" max="3000" style="width:110px"> estudiantes <button class="btn danger" data-action="seedLoad">⚗️ Cargar datos de prueba</button></div></div>' : '');
}
function schoolLog() {
  return '<h2>Bitácora</h2>' + logTable();
}
function logTable() {
  const all = V.audit || [];
  const rows = UI.view === 'school' ? all.filter((l) => matchQ(l.actor, l.text, fmtTs(l.ts))) : all;
  return (UI.view === 'school' ? searchHint(rows.length, all.length) : '') + '<table class="tbl"><tr><th>Fecha</th><th>Actor</th><th>Evento</th></tr>' + rows.slice(0, 200).map((l) => '<tr><td class="mono small">' + fmtTs(l.ts) + '</td><td>' + esc(l.actor) + '</td><td>' + esc(l.text) + '</td></tr>').join('') + '</table>';
}
function viewLog() { return '<div class="page"><h2>📜 Bitácora del sistema</h2>' + logTable() + '</div>'; }
