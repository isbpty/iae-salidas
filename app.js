/* =====================================================================
   IAE Salidas · Lógica de negocio, notificaciones y bot de WhatsApp
   ===================================================================== */

const STORAGE_KEY = 'iae-salidas-demo-v2';
let S; // estado persistente (localStorage)
const UI = {
  view: 'whatsapp',        // parents | whatsapp | school | log
  split: false,
  parentId: 'p1',          // persona activa en la app de padres
  phoneId: 'p1',           // teléfono simulado en WhatsApp ('unknown' = número desconocido)
  staffId: 's2',           // usuario activo del dashboard
  schoolTab: 'inicio',
  parentTab: 'inicio',
  modal: null,
  filter: 'todas',
};

/* ---------- Persistencia ---------- */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { S = JSON.parse(raw); return; }
  } catch (e) { /* sin localStorage: se usa memoria */ }
  S = makeSeed();
}
function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(S)); } catch (e) { /* ignorar */ } }
function resetDemo() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignorar */ }
  S = makeSeed();
  UI.modal = null;
  render();
  toast('Demo reiniciado con datos de ejemplo', 'ok');
}

/* ---------- Utilidades ---------- */
const uid = (p = '') => p + Math.random().toString(36).slice(2, 8);
const pad = (n) => String(n).padStart(2, '0');
function localISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
const todayISO = () => localISO(new Date());
function shiftISO(days) { const d = new Date(); d.setDate(d.getDate() + days); return localISO(d); }
function nowHHMM() { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function addMinutes(hhmm, n) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = ((h * 60 + m + n) % 1440 + 1440) % 1440;
  return pad(Math.floor(t / 60)) + ':' + pad(t % 60);
}
function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return (h % 12 || 12) + ':' + pad(m) + (h >= 12 ? ' pm' : ' am');
}
function fmtDate(iso) {
  if (!iso) return '';
  if (iso === todayISO()) return 'hoy';
  if (iso === shiftISO(1)) return 'mañana';
  if (iso === shiftISO(-1)) return 'ayer';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('es-PA', { weekday: 'short', day: 'numeric', month: 'short' });
}
function fmtTs(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('es-PA', { day: '2-digit', month: 'short' }) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function fmtClock(ts) { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function normalize(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim(); }
function firstName(name) { return (name || '').split(' ')[0]; }

/* ---------- Accesores ---------- */
const person = (id) => S.persons.find((p) => p.id === id);
const student = (id) => S.students.find((s) => s.id === id);
const staffMember = (id) => S.staff.find((s) => s.id === id);
const request = (id) => S.requests.find((r) => r.id === id);
const levelName = (id) => (S.levels.find((l) => l.id === id) || {}).name || id;
const ROLE_NAMES = { admin: 'Administración', recepcion: 'Recepción', profesor: 'Profesor', garita: 'Garita de salida', monitora: 'Monitora de bus' };
const route = (id) => (S.routes || []).find((r) => r.id === id);
const LEG_NAMES = { ida: 'ida (mañana)', vuelta: 'vuelta (tarde)' };
const roleName = (r) => ROLE_NAMES[r] || r;
const AUTH_TYPES = { siempre: 'Siempre', temporal: 'Por tiempo', una_vez: 'Una vez (con confirmación)' };
const STATUS = {
  pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada', retirado: 'Retirado', cancelada: 'Cancelada', aceptada: 'Aceptada',
};
const CHANNEL = { whatsapp: 'WhatsApp', web: 'App' };

function studentsOf(personId) { return S.students.filter((s) => s.titulares.includes(personId)); }
function isAuthActive(a) {
  if (a.revoked) return false;
  const t = todayISO();
  if (a.type === 'siempre') return true;
  if (a.type === 'temporal') return a.from <= t && t <= a.to;
  if (a.type === 'una_vez') return !a.used;
  return false;
}
function authsForStudent(sid) { return S.authorizations.filter((a) => a.studentId === sid && !a.revoked); }
function authorizedFor(personId) {
  // estudiantes para los que la persona tiene autorización activa sin ser titular
  return S.authorizations
    .filter((a) => a.personId === personId && isAuthActive(a) && !student(a.studentId).titulares.includes(personId))
    .map((a) => ({ auth: a, student: student(a.studentId) }));
}
function pickupEligibility(studentId, personId) {
  const st = student(studentId);
  if (!st || !personId) return { ok: false };
  if (st.titulares.includes(personId)) return { ok: true, kind: 'titular' };
  const a = S.authorizations.find((x) => x.studentId === studentId && x.personId === personId && isAuthActive(x));
  if (a) return { ok: true, kind: a.type, auth: a };
  return { ok: false };
}
function pickupCandidates(studentId) {
  // titulares + autorizados activos
  const st = student(studentId);
  const list = st.titulares.map((id) => ({ person: person(id), kind: 'titular' }));
  authsForStudent(studentId).filter(isAuthActive).forEach((a) => list.push({ person: person(a.personId), kind: a.type, auth: a }));
  return list;
}
function kindLabel(kind) { return kind === 'titular' ? 'Titular' : AUTH_TYPES[kind] || kind; }
function staffCan(staff, cap) { return !!(S.permissions[staff.role] || {})[cap]; }
function staffScope(staff) {
  // estudiantes visibles según rol: todos, solo su ruta (monitora) o solo sus grados (profesor)
  if (staffCan(staff, 'todos_niveles')) return S.students;
  if (staff.routeId) return S.students.filter((s) => s.routeId === staff.routeId);
  return S.students.filter((s) => (staff.grades || []).includes(s.grade));
}
function visibleRoutes(staff) {
  if (staff.routeId) return (S.routes || []).filter((r) => r.id === staff.routeId);
  return S.routes || [];
}
function teacherOf(student) {
  return S.staff.find((s) => s.role === 'profesor' && (s.grades || []).includes(student.grade));
}
function visibleRequests(staff) {
  const ids = new Set(staffScope(staff).map((s) => s.id));
  return S.requests.filter((r) => ids.has(r.studentId));
}

/* ---------- Notificaciones, chat y bitácora ---------- */
function toast(text, kind = 'info') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 6000);
}
function chatPush(key, msg) {
  if (!S.chats[key]) S.chats[key] = [];
  S.chats[key].push(Object.assign({ ts: Date.now() }, msg));
}
function notifyPerson(personId, text, opts = {}) {
  const p = person(personId);
  if (!p) return;
  S.notifications.push({ id: uid('n'), to: personId, text, ts: Date.now(), read: false, kind: opts.kind || 'info' });
  if (p.phone) chatPush(personId, { from: 'bot', text, buttons: opts.buttons });
  toast('📲 ' + firstName(p.name) + ': ' + text, 'wa');
}
function notifyRole(role, text) {
  S.notifications.push({ id: uid('n'), toRole: role, text, ts: Date.now(), read: false });
  toast('🏫 ' + roleName(role) + ': ' + text, 'school');
}
function notifyTeachers(studentId, text) {
  const st = student(studentId);
  S.staff.filter((s) => s.role === 'profesor' && (s.grades || []).includes(st.grade))
    .forEach((s) => S.notifications.push({ id: uid('n'), toStaff: s.id, text, ts: Date.now(), read: false }));
}
function logEvent(text, actor = 'Sistema') { S.log.unshift({ ts: Date.now(), text, actor }); }
function addHist(req, text) { req.history.push({ ts: Date.now(), text }); }
function unreadFor(personId) { return S.notifications.filter((n) => n.to === personId && !n.read).length; }
function unreadForStaff(staff) {
  return S.notifications.filter((n) => !n.read && (n.toRole === staff.role || n.toStaff === staff.id)).length;
}

/* ---------- Solicitudes ---------- */
function describePickup(req) {
  const pk = person(req.pickupBy);
  if (!pk) return '';
  return pk.name + (req.pickupBy === req.requestedBy ? ' (solicitante)' : ' (' + pk.relation + ')');
}
function evaluateAutoApprove(req) {
  const st = student(req.studentId);
  const cfg = S.settings;
  if (!cfg.autoApprove) return { ok: false, reason: 'auto-aprobación desactivada' };
  if (!st.titulares.includes(req.requestedBy)) return { ok: false, reason: 'el solicitante no es titular' };
  const when = new Date(req.date + 'T' + req.time + ':00').getTime();
  const mins = Math.round((when - Date.now()) / 60000);
  if (mins < cfg.minAnticipationMin) return { ok: false, reason: 'menos de ' + cfg.minAnticipationMin + ' min de anticipación' };
  const el = pickupEligibility(req.studentId, req.pickupBy);
  if (!el.ok) return { ok: false, reason: 'la persona que retira no está autorizada' };
  if (el.kind === 'una_vez') return { ok: false, reason: 'autorización de una sola vez requiere revisión' };
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const rejected = S.requests.some((r) => r.studentId === req.studentId && r.status === 'rechazada' && r.createdAt > cutoff);
  if (rejected) return { ok: false, reason: 'el estudiante tiene un rechazo reciente' };
  return { ok: true };
}

function createRequest(data) {
  const st = student(data.studentId);
  const by = person(data.requestedBy);
  const req = Object.assign({
    id: uid('r'), status: 'pendiente', createdAt: Date.now(), history: [],
    code: String(1000 + Math.floor(Math.random() * 9000)),
  }, data);
  if (req.kind === 'salida') {
    const el = pickupEligibility(req.studentId, req.pickupBy);
    req.pickupKind = el.kind || 'no_autorizado';
  }
  S.requests.unshift(req);
  const ch = CHANNEL[req.channel] || req.channel;
  const otherTitulares = st.titulares.filter((t) => t !== req.requestedBy);

  if (req.kind === 'salida') {
    addHist(req, 'Solicitud creada por ' + by.name + ' vía ' + ch);
    logEvent('Solicitud de salida de ' + st.name + ' creada por ' + by.name + ' (' + ch + ')');
    otherTitulares.forEach((t) => notifyPerson(t, 'ℹ️ ' + by.name + ' solicitó salida de ' + st.name + ' ' + fmtDate(req.date) + ' a las ' + fmtTime(req.time) + '. Retira: ' + describePickup(req) + '.'));
    const ev = evaluateAutoApprove(req);
    if (ev.ok) {
      approveRequest(req.id, { auto: true, pickupPoint: S.settings.defaultPickupPoint });
    } else {
      addHist(req, 'Pendiente de revisión: ' + ev.reason);
      notifyPerson(req.requestedBy, '📝 Recibimos tu solicitud de salida de ' + st.name + ' ' + fmtDate(req.date) + ' a las ' + fmtTime(req.time) + '. Te avisamos en cuanto la escuela la apruebe.');
      notifyRole('recepcion', 'Nueva solicitud de salida: ' + st.name + ' (' + st.grade + ') ' + fmtDate(req.date) + ' ' + fmtTime(req.time) + ' · ' + ev.reason);
      notifyTeachers(req.studentId, 'Solicitud de salida pendiente: ' + st.name + ' ' + fmtTime(req.time));
    }
  } else {
    addHist(req, 'Excusa enviada por ' + by.name + ' vía ' + ch);
    logEvent('Excusa (' + req.excusaType + ') de ' + st.name + ' enviada por ' + by.name + ' (' + ch + ')');
    notifyPerson(req.requestedBy, '📝 Excusa recibida para ' + st.name + ' (' + req.excusaType + ' · ' + fmtDate(req.date) + '). Te avisamos cuando sea revisada.');
    otherTitulares.forEach((t) => notifyPerson(t, 'ℹ️ ' + by.name + ' envió una excusa de ' + req.excusaType + ' para ' + st.name + ' (' + fmtDate(req.date) + ').'));
    notifyRole('recepcion', 'Nueva excusa: ' + st.name + ' (' + st.grade + ') · ' + req.excusaType + ' ' + fmtDate(req.date));
    notifyTeachers(req.studentId, 'Excusa de ' + req.excusaType + ' para ' + st.name + ' (' + fmtDate(req.date) + ')');
  }
  save();
  return req;
}

function approveRequest(id, opts = {}) {
  const req = request(id);
  const st = student(req.studentId);
  const pk = person(req.pickupBy);
  req.status = 'aprobada';
  req.pickupPoint = opts.pickupPoint || S.settings.defaultPickupPoint;
  req.decidedAt = Date.now();
  req.autoApproved = !!opts.auto;
  req.decidedBy = opts.auto ? 'auto' : opts.by;
  const who = opts.auto ? 'Aprobada automáticamente (regla: titular, anticipación, autorizado vigente)' : 'Aprobada por ' + staffMember(opts.by).name;
  addHist(req, who + ' · ' + req.pickupPoint);
  logEvent((opts.auto ? 'Auto-aprobó' : 'Aprobó') + ' salida de ' + st.name + ' · ' + req.pickupPoint, opts.auto ? 'Sistema' : staffMember(opts.by).name);
  const needsConfirm = req.pickupKind === 'una_vez';
  const msg = '✅ Salida aprobada: ' + st.name + ' ' + fmtDate(req.date) + ' a las ' + fmtTime(req.time) + '. Retira: ' + describePickup(req) +
    '. Punto de retiro: ' + req.pickupPoint + '. Código: ' + req.code + '.' + (needsConfirm ? ' ⚠️ Te pediremos confirmar cuando la persona llegue a la garita.' : '');
  st.titulares.forEach((t) => notifyPerson(t, msg));
  if (pk.account && !st.titulares.includes(pk.id)) {
    notifyPerson(pk.id, '👋 Estás autorizado(a) para retirar a ' + st.name + ' ' + fmtDate(req.date) + ' a las ' + fmtTime(req.time) + ' por ' + req.pickupPoint + '. Presenta tu cédula. Código: ' + req.code + '.');
  }
  if (needsConfirm) addHist(req, 'Requiere confirmación del titular cuando la persona llegue a la garita');
  // Aviso proactivo: solo cuando retira una persona nueva o con autorización temporal / de una vez
  const el = pickupEligibility(req.studentId, req.pickupBy);
  const ageDays = el.auth ? Math.floor((Date.now() - el.auth.createdAt) / 86400000) : null;
  const unusual = el.kind === 'temporal' || el.kind === 'una_vez' || (el.auth && ageDays < S.settings.newAuthDays);
  if (unusual) {
    const why = el.kind === 'temporal' ? 'autorización por tiempo (' + el.auth.from + ' → ' + el.auth.to + ')' : el.kind === 'una_vez' ? 'autorización de una sola vez' : 'autorización registrada hace ' + ageDays + ' día(s)';
    addHist(req, 'Aviso proactivo a los titulares: persona ' + (el.kind === 'siempre' ? 'nueva' : el.kind));
    st.titulares.forEach((t) => {
      notifyPerson(t, '⚠️ AVISO: hoy retira a ' + firstName(st.name) + ' ' + pk.name + ' (' + pk.relation + ') con ' + why + '. Si no lo reconoces responde NO y se cancela la salida.', { buttons: ['Es correcto', 'NO'] });
      S.chatState[t] = { step: 'alert_pickup', requestId: req.id };
    });
  }
  notifyRole('garita', 'Salida aprobada: ' + st.name + ' ' + fmtTime(req.time) + ' · retira ' + pk.name + ' · ' + req.pickupPoint);
  notifyTeachers(req.studentId, 'Salida aprobada: ' + st.name + ' ' + fmtTime(req.time));
  save();
}

function rejectRequest(id, reason, by) {
  const req = request(id);
  const st = student(req.studentId);
  req.status = 'rechazada';
  req.decidedAt = Date.now();
  req.decidedBy = by;
  req.rejectReason = reason;
  addHist(req, 'Rechazada por ' + staffMember(by).name + ': ' + reason);
  logEvent('Rechazó ' + (req.kind === 'salida' ? 'salida' : 'excusa') + ' de ' + st.name + ': ' + reason, staffMember(by).name);
  const what = req.kind === 'salida' ? 'Salida de ' + st.name + ' ' + fmtDate(req.date) + ' ' + fmtTime(req.time) : 'Excusa de ' + st.name + ' (' + fmtDate(req.date) + ')';
  st.titulares.forEach((t) => notifyPerson(t, '❌ ' + what + ' no fue aprobada. Motivo: ' + reason + '. Contacta a recepción al ' + S.school.phone + '.'));
  save();
}

function acceptExcusa(id, by) {
  const req = request(id);
  const st = student(req.studentId);
  req.status = 'aceptada';
  req.decidedAt = Date.now();
  req.decidedBy = by;
  addHist(req, 'Aceptada por ' + staffMember(by).name);
  logEvent('Aceptó excusa de ' + st.name + ' (' + req.excusaType + ' ' + fmtDate(req.date) + ')', staffMember(by).name);
  st.titulares.forEach((t) => notifyPerson(t, '✅ Excusa aceptada: ' + st.name + ' · ' + req.excusaType + ' ' + fmtDate(req.date) + '. Quedó registrada para su docente.'));
  notifyTeachers(req.studentId, 'Excusa aceptada: ' + st.name + ' · ' + req.excusaType + ' ' + fmtDate(req.date));
  save();
}

function cancelRequest(id, personId) {
  const req = request(id);
  const st = student(req.studentId);
  req.status = 'cancelada';
  addHist(req, 'Cancelada por ' + person(personId).name);
  logEvent('Canceló solicitud de ' + st.name, person(personId).name);
  notifyRole('recepcion', 'Solicitud cancelada por el padre: ' + st.name + ' ' + (req.time ? fmtTime(req.time) : fmtDate(req.date)));
  if (req.kind === 'salida') notifyRole('garita', 'Salida cancelada: ' + st.name + ' ' + fmtTime(req.time));
  save();
}

function requestConfirmation(id, by) {
  const req = request(id);
  const st = student(req.studentId);
  const pk = person(req.pickupBy);
  req.confirmation = { status: 'pendiente', requestedAt: Date.now(), by };
  addHist(req, 'Garita solicitó confirmación a los titulares (' + pk.name + ' presente)');
  logEvent('Solicitó confirmación de entrega de ' + st.name + ' a ' + pk.name, staffMember(by).name);
  st.titulares.forEach((t) => {
    notifyPerson(t, '⚠️ ' + pk.name + ' (' + pk.relation + ') está en la garita para retirar a ' + st.name + '. Es una autorización de UNA SOLA VEZ. ¿Confirmas la entrega? Responde SÍ o NO.', { buttons: ['Sí, confirmo', 'No'] });
    S.chatState[t] = { step: 'confirm_pickup', requestId: id };
  });
  save();
}

function confirmPickup(id, personId, yes) {
  const req = request(id);
  const st = student(req.studentId);
  const pk = person(req.pickupBy);
  if (!req.confirmation) req.confirmation = {};
  req.confirmation.status = yes ? 'confirmada' : 'negada';
  req.confirmation.byPerson = personId;
  req.confirmation.at = Date.now();
  addHist(req, (yes ? 'Entrega confirmada' : 'Entrega NEGADA') + ' por ' + person(personId).name);
  logEvent((yes ? 'Confirmó' : 'Negó') + ' la entrega de ' + st.name + ' a ' + pk.name, person(personId).name);
  notifyRole('garita', (yes ? '✅ Confirmado' : '⛔ NEGADO') + ' por ' + person(personId).name + ': entrega de ' + st.name + ' a ' + pk.name);
  st.titulares.filter((t) => t !== personId).forEach((t) => {
    notifyPerson(t, (yes ? '✅ ' : '⛔ ') + person(personId).name + (yes ? ' confirmó' : ' negó') + ' la entrega de ' + st.name + ' a ' + pk.name + '.');
    if (S.chatState[t] && S.chatState[t].step === 'confirm_pickup') delete S.chatState[t];
  });
  delete S.chatState[personId];
  save();
}

function markExit(id, by) {
  const req = request(id);
  const st = student(req.studentId);
  const pk = person(req.pickupBy);
  const el = pickupEligibility(req.studentId, req.pickupBy);
  if (!el.ok) return { ok: false, error: pk.name + ' ya no tiene autorización vigente para ' + st.name + '.' };
  if (el.kind === 'una_vez' && !(req.confirmation && req.confirmation.status === 'confirmada')) {
    return { ok: false, error: 'Autorización de una sola vez: primero solicita la confirmación del titular.' };
  }
  req.status = 'retirado';
  req.exitAt = Date.now();
  req.exitBy = by;
  if (el.auth && el.auth.type === 'una_vez') { el.auth.used = true; el.auth.usedAt = Date.now(); }
  addHist(req, 'Retirado por ' + pk.name + ' · marcado en garita por ' + staffMember(by).name);
  logEvent('Marcó retirado a ' + st.name + ' (' + pk.name + ')', staffMember(by).name);
  const hora = fmtTime(nowHHMM());
  const officer = staffMember(by);
  st.titulares.forEach((t) => {
    notifyPerson(t, '🚪 ' + st.name + ' salió por ' + req.pickupPoint + ' a las ' + hora + ', retirado(a) por ' + describePickup(req) + '. Confirmó ' + officer.name + ' (' + (officer.title || roleName(officer.role)) + ').');
    if (S.chatState[t] && S.chatState[t].step === 'alert_pickup') delete S.chatState[t];
  });
  if (pk.account && !st.titulares.includes(pk.id)) notifyPerson(pk.id, '🚪 Registramos que retiraste a ' + st.name + ' a las ' + hora + '. ¡Gracias!');
  notifyTeachers(req.studentId, st.name + ' salió a las ' + hora);
  save();
  return { ok: true };
}

/* ---------- Autorizaciones ---------- */
function addAuthorization({ studentIds, personId, newPerson, type, from, to, createdBy }) {
  let pid = personId;
  if (!pid) {
    const p = Object.assign({ id: uid('p'), account: false }, newPerson);
    S.persons.push(p);
    pid = p.id;
  } else if (newPerson && newPerson.docImage) {
    person(pid).docImage = newPerson.docImage;
    person(pid).doc = newPerson.doc;
  }
  const p = person(pid);
  const creator = person(createdBy);
  studentIds.forEach((sid) => {
    const st = student(sid);
    if (st.titulares.includes(pid)) return; // ya es titular
    const a = { id: uid('a'), studentId: sid, personId: pid, type, createdBy, createdAt: Date.now() };
    if (type === 'temporal') { a.from = from; a.to = to; }
    if (type === 'una_vez') a.used = false;
    S.authorizations.push(a);
    logEvent('Autorizó a ' + p.name + ' (' + p.relation + ') para retirar a ' + st.name + ' · ' + AUTH_TYPES[type], creator.name);
    st.titulares.filter((t) => t !== createdBy).forEach((t) => notifyPerson(t, 'ℹ️ ' + creator.name + ' autorizó a ' + p.name + ' (' + p.relation + ') para retirar a ' + st.name + ' · ' + AUTH_TYPES[type] + '.'));
    if (p.account) notifyPerson(pid, '🔑 ' + creator.name + ' te autorizó para retirar a ' + st.name + ' (' + st.grade + ') · ' + AUTH_TYPES[type] + (type === 'temporal' ? ' del ' + from + ' al ' + to : '') + '. Lo verás en tu app.');
  });
  notifyRole('recepcion', 'Nueva persona autorizada: ' + p.name + ' para ' + studentIds.map((s) => firstName(student(s).name)).join(', ') + ' · ' + AUTH_TYPES[type]);
  save();
}
function revokeAuthorization(id, byPerson) {
  const a = S.authorizations.find((x) => x.id === id);
  if (!a) return;
  a.revoked = true;
  a.revokedAt = Date.now();
  const st = student(a.studentId);
  const p = person(a.personId);
  logEvent('Revocó autorización de ' + p.name + ' para ' + st.name, byPerson ? person(byPerson).name : 'Escuela');
  st.titulares.filter((t) => t !== byPerson).forEach((t) => notifyPerson(t, 'ℹ️ Se revocó la autorización de ' + p.name + ' para retirar a ' + st.name + '.'));
  save();
}

/* =====================================================================
   Bot de WhatsApp (entendimiento simple en español)
   ===================================================================== */
const REL_WORDS = {
  abuela: 'abuela', abuelo: 'abuelo', tia: 'tía', tio: 'tío', mama: 'mamá', madre: 'mamá', papa: 'papá', padre: 'papá',
  hermano: 'hermano', hermana: 'hermana', nana: 'nana', ninera: 'niñera', chofer: 'chofer', vecina: 'vecina', vecino: 'vecino', prima: 'prima', primo: 'primo',
};

function botMenu(p) {
  const kids = studentsOf(p.id);
  const k = firstName(kids[0].name);
  return 'Hola ' + firstName(p.name) + ' 👋 Soy el asistente de ' + S.school.short + ' Salidas.\n\nPuedo ayudarte con:\n1️⃣ Salida temprana: "Necesito retirar a ' + k + ' hoy a las 3:30 pm"\n2️⃣ Alguien más retira: "A ' + k + ' lo retira la abuela a las 2 pm"\n3️⃣ Excusa: "' + k + ' no irá mañana, tiene cita médica"\n4️⃣ Ubicación: "¿Dónde está ' + k + '?"\n5️⃣ Bus: "' + k + ' hoy no va en el bus"\n6️⃣ Escribe *estado* para ver tus solicitudes.';
}

function parseTime(n) {
  let m, h, mm = 0, ap = '';
  n = n.replace(/de la manana/g, 'am').replace(/de la tarde|de la noche/g, 'pm').replace(/(\d)\s*(pm|am)/g, '$1 $2');
  if ((m = n.match(/\b(\d{1,2})[:.h](\d{2})\s*(am|pm|a\.m\.?|p\.m\.?)?/))) { h = +m[1]; mm = +m[2]; ap = m[3] || ''; }
  else if ((m = n.match(/\b(\d{3,4})\s*(am|pm|a\.m\.?|p\.m\.?)?\b/))) { const d = m[1]; h = +d.slice(0, d.length - 2); mm = +d.slice(-2); ap = m[2] || ''; }
  else if ((m = n.match(/\b(?:a las|a la|las|la|hora)\s+(\d{1,2})\b\s*(am|pm|a\.m\.?|p\.m\.?)?/))) { h = +m[1]; ap = m[2] || ''; }
  else if ((m = n.match(/\b(\d{1,2})\s*(am|pm|a\.m\.?|p\.m\.?)\b/))) { h = +m[1]; ap = m[2]; }
  else return null;
  if (isNaN(h) || h > 23 || mm > 59) return null;
  if (/p/.test(ap) && h < 12) h += 12;
  if (/a/.test(ap) && h === 12) h = 0;
  if (!ap && h <= 6) h += 12; // sin am/pm: se asume tarde
  return pad(h) + ':' + pad(mm);
}
function parseDate(n) {
  const t = n.replace(/de la manana/g, '');
  if (/pasado manana/.test(t)) return shiftISO(2);
  if (/\bmanana\b/.test(t)) return shiftISO(1);
  const m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m) { const y = new Date().getFullYear(); return y + '-' + pad(+m[2]) + '-' + pad(+m[1]); }
  const days = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  for (let i = 0; i < 7; i++) {
    if (new RegExp('\\bel ' + days[i] + '\\b').test(t)) {
      const d = new Date(); let diff = (i - d.getDay() + 7) % 7; if (diff === 0) diff = 7; return shiftISO(diff);
    }
  }
  return todayISO();
}
function matchKid(n, kids) {
  const found = kids.filter((k) => new RegExp('\\b' + normalize(firstName(k.name)) + '\\b').test(n));
  if (found.length === 1) return found[0].id;
  if (found.length > 1) return null;
  if (/\bmi hija\b/.test(n)) { const f = kids.filter((k) => k.emoji === '👧' || k.emoji === '👩‍🎓'); if (f.length === 1) return f[0].id; }
  if (/\bmi hijo\b/.test(n)) { const f = kids.filter((k) => k.emoji === '👦' || k.emoji === '🧒'); if (f.length === 1) return f[0].id; }
  if (kids.length === 1) return kids[0].id;
  return null;
}
function extractPickupHint(n) {
  // devuelve texto sobre quién retira, o null si no se menciona
  if (/\b(lo|la|los|las)?\s?(retiro|recojo|busco|paso)\s+yo\b|\byo\s+(lo|la)\s+(retiro|recojo|busco)\b/.test(n)) return 'yo';
  const stop = ['hoy', 'manana', 'a', 'las', 'la', 'el', 'temprano', 'de', 'en', 'por', 'y', 'que', 'mi', 'su'];
  const re = /(?:lo|la|los|las)?\s?(?:va a retirar|van a retirar|retira|retirara|recoge|recogera|busca|buscara|pasa a buscar|va a buscar|va a recoger|retirar[aá]?)\s+(?:a\s+\w+\s+)?(?:su|mi|la|el|los|las|nuestra|nuestro)?\s*([a-z]+(?:\s[a-z]+)?)/g;
  let m;
  while ((m = re.exec(n))) {
    const w = m[1].trim();
    const first = w.split(' ')[0];
    if (stop.includes(first) || /^\d/.test(first)) continue;
    const parts = w.split(' ');
    return parts.length > 1 && (stop.includes(parts[1]) || /^\d/.test(parts[1])) ? first : w;
  }
  const rel = Object.keys(REL_WORDS).find((r) => new RegExp('\\b(su|la|el|mi)\\s+' + r + '\\b').test(n));
  return rel || null;
}
function resolvePickup(hint, studentId, requester) {
  if (!hint || hint === 'yo') return requester;
  const cands = pickupCandidates(studentId);
  const words = hint.split(' ');
  // por nombre
  let hit = cands.find((c) => words.some((w) => w.length > 2 && normalize(c.person.name).split(' ').includes(w)));
  if (hit) return hit.person.id;
  // por parentesco
  hit = cands.find((c) => words.some((w) => REL_WORDS[w] && normalize(c.person.relation) === normalize(REL_WORDS[w])));
  if (hit) return hit.person.id;
  return null;
}
function detectIntent(n) {
  if (/^(hola|buenas|buenos dias|buenas tardes|menu|ayuda|hi)\b/.test(n)) return 'saludo';
  if (/\b(estado|mis solicitudes|estatus|status)\b/.test(n)) return 'estado';
  if (/\bcancelar\b/.test(n)) return 'cancelar';
  if (/no (va|ira|viaja|se va|toma|tomara|usa|usara|sube|subira)( a ir)?( hoy| manana)?( en| al| el)?( el)? bus|sin bus|no bus/.test(n)) return 'nobus';
  if (/donde (esta|estan|anda|va|queda)|\bdonde\b|ubicaci|en que bus|en el bus|ya (llego|salio|paso|bajo)|localiza|rastre|posicion|gps/.test(n)) return 'donde';
  if (/retir|salir|salida|recog|buscar|sacar|temprano|permiso/.test(n)) return 'salida';
  if (/no (va|ira|asistira|vendra|podra|puede)|falt|ausen|excusa|enferm|cita|tardanza|llegara tarde|llega tarde|reposo|fiebre|justific/.test(n)) return 'excusa';
  return 'desconocido';
}

function botReply(key, text, buttons, extra) {
  chatPush(key, Object.assign({ from: 'bot', text, buttons, pendingUntil: Date.now() + 700 + 400 * ((S.chats[key] || []).filter((m) => m.pendingUntil > Date.now()).length) }, extra || {}));
  save();
}
function statusSummary(p) {
  const kids = studentsOf(p.id).map((k) => k.id);
  const list = S.requests.filter((r) => kids.includes(r.studentId) && r.date >= shiftISO(-1)).slice(0, 5);
  if (!list.length) return 'No tienes solicitudes recientes.';
  return 'Tus solicitudes recientes:\n' + list.map((r) => {
    const st = student(r.studentId);
    const what = r.kind === 'salida' ? 'Salida ' + fmtDate(r.date) + ' ' + fmtTime(r.time) : 'Excusa ' + r.excusaType + ' ' + fmtDate(r.date);
    return '• ' + firstName(st.name) + ' · ' + what + ' · ' + STATUS[r.status] + (r.pickupPoint && r.status === 'aprobada' ? ' (' + r.pickupPoint + ', código ' + r.code + ')' : '');
  }).join('\n');
}

function handleIncoming(key, text) {
  chatPush(key, { from: 'user', text });
  const p = key === 'unknown' ? null : person(key);
  if (!p || !p.account) {
    botReply(key, 'Hola 👋 Este número no está registrado en ' + S.school.short + ' Salidas. Si eres padre o madre, regístrate en la app de padres o escribe a recepción al ' + S.school.phone + '.');
    return;
  }
  const kids = studentsOf(p.id);
  const n = normalize(text);
  const st = S.chatState[key];

  if (st && st.step) { handleStep(key, p, kids, st, n, text); return; }
  if (!kids.length) {
    const auths = authorizedFor(p.id);
    botReply(key, 'Hola ' + firstName(p.name) + '. No tienes hijos registrados como titular.' + (auths.length ? ' Estás autorizado(a) para retirar a: ' + auths.map((a) => a.student.name).join(', ') + '. Las solicitudes las crean los padres titulares.' : ''));
    return;
  }
  dispatch(key, p, kids, n, text);
}
function dispatch(key, p, kids, n, text) {
  const intent = detectIntent(n);
  if (intent === 'saludo') return botReply(key, botMenu(p));
  if (intent === 'estado') return botReply(key, statusSummary(p));
  if (intent === 'cancelar') return botReply(key, 'No hay nada en proceso. ' + botMenu(p));
  if (intent === 'nobus') return startNoBus(key, p, kids, n);
  if (intent === 'donde') return startDonde(key, p, kids, n);
  if (intent === 'salida') return startSalida(key, p, kids, n, text);
  if (intent === 'excusa') return startExcusa(key, p, kids, n, text);
  botReply(key, 'No te entendí 🤔\n\n' + botMenu(p));
}

function startSalida(key, p, kids, n, raw) {
  const draft = {
    kind: 'salida', requestedBy: p.id, channel: 'whatsapp',
    studentId: matchKid(n, kids), date: parseDate(n), time: parseTime(n), pickupHint: extractPickupHint(n), reason: raw,
  };
  S.chatState[key] = { step: 'salida', draft };
  continueSalida(key, p, kids);
}
function continueSalida(key, p, kids) {
  const st = S.chatState[key];
  const d = st.draft;
  if (!d.studentId) {
    st.step = 'ask_child';
    return botReply(key, '¿A cuál de tus hijos? ', kids.map((k) => firstName(k.name)));
  }
  const kid = student(d.studentId);
  if (!d.time) {
    st.step = 'ask_time';
    return botReply(key, '¿A qué hora necesitas que ' + firstName(kid.name) + ' salga ' + fmtDate(d.date) + '? (ej. 3:30 pm)');
  }
  if (d.pickupBy === undefined) {
    const pid = resolvePickup(d.pickupHint, d.studentId, p.id);
    if (!pid) {
      st.step = 'ask_pickup';
      const cands = pickupCandidates(d.studentId);
      return botReply(key, '"' + d.pickupHint + '" no aparece como persona autorizada para ' + firstName(kid.name) + '. Puedes registrarla en la app. ¿Quién va a retirar?', cands.map((c) => c.person.id === p.id ? 'Yo' : firstName(c.person.name) + ' (' + c.person.relation + ')'));
    }
    d.pickupBy = pid;
  }
  st.step = 'confirm';
  const pk = person(d.pickupBy);
  const el = pickupEligibility(d.studentId, d.pickupBy);
  botReply(key, '📋 Confirma la solicitud:\n• Estudiante: ' + kid.name + ' (' + kid.grade + ')\n• Fecha: ' + fmtDate(d.date) + '\n• Hora: ' + fmtTime(d.time) + '\n• Retira: ' + (pk.id === p.id ? 'tú' : pk.name + ' (' + pk.relation + ')') + (el.kind === 'una_vez' ? ' · autorización de una sola vez' : '') + '\n\n¿Es correcto?', ['Sí', 'No']);
}
function startExcusa(key, p, kids, n, raw) {
  const draft = {
    kind: 'excusa', requestedBy: p.id, channel: 'whatsapp',
    studentId: matchKid(n, kids), date: parseDate(n), excusaType: /tard/.test(n) ? 'tardanza' : 'ausencia', reason: raw,
  };
  S.chatState[key] = { step: 'excusa', draft };
  continueExcusa(key, p, kids);
}
function continueExcusa(key, p, kids) {
  const st = S.chatState[key];
  const d = st.draft;
  if (!d.studentId) {
    st.step = 'ask_child';
    return botReply(key, '¿Para cuál de tus hijos es la excusa?', kids.map((k) => firstName(k.name)));
  }
  const kid = student(d.studentId);
  st.step = 'confirm';
  botReply(key, '📋 Confirma la excusa:\n• Estudiante: ' + kid.name + ' (' + kid.grade + ')\n• Tipo: ' + d.excusaType + '\n• Fecha: ' + fmtDate(d.date) + '\n• Motivo: ' + d.reason + (d.attachment ? '\n• Adjunto: ' + d.attachment : '\n\nPuedes adjuntar el certificado con 📎 antes de confirmar.') + '\n\n¿Es correcto?', ['Sí', 'No', '📎 Adjuntar certificado']);
}
function handleStep(key, p, kids, st, n, raw) {
  if (/\bcancelar\b/.test(n)) { delete S.chatState[key]; return botReply(key, 'Listo, cancelé el proceso. ' + botMenu(p)); }
  const d = st.draft;
  const cont = () => {
    if (d && d.kind === 'excusa') return continueExcusa(key, p, kids);
    if (d && d.kind === 'donde') { delete S.chatState[key]; return finishDonde(key, d.studentId); }
    if (d && d.kind === 'nobus') { delete S.chatState[key]; return finishNoBus(key, p, d); }
    return continueSalida(key, p, kids);
  };

  if (st.step === 'alert_pickup') {
    const req = request(st.requestId);
    if (/^(no|n)\b/.test(n)) {
      delete S.chatState[key];
      if (req && ['aprobada', 'pendiente'].includes(req.status)) {
        cancelRequest(req.id, p.id);
        addHist(req, 'Cancelada: el titular NO reconoció a la persona que retira');
        notifyRole('garita', '⛔ ' + p.name + ' NO reconoce a ' + person(req.pickupBy).name + ' · salida de ' + student(req.studentId).name + ' CANCELADA');
        student(req.studentId).titulares.filter((t) => t !== p.id).forEach((t) => { notifyPerson(t, '⛔ ' + p.name + ' no reconoció a ' + person(req.pickupBy).name + '; la salida de ' + firstName(student(req.studentId).name) + ' fue cancelada.'); if (S.chatState[t] && S.chatState[t].step === 'alert_pickup') delete S.chatState[t]; });
      }
      return botReply(key, '⛔ Cancelé la salida y avisé a la garita. Recepción te contactará al ' + S.school.phone + '.');
    }
    if (/correcto|^(si|sí|s|ok|dale)\b|conozco|reconozco/.test(n)) { delete S.chatState[key]; return botReply(key, '👍 Gracias, queda confirmado. Te aviso cuando ' + firstName(student(req.studentId).name) + ' salga.'); }
    delete S.chatState[key];
    return dispatch(key, p, kids, n, raw);
  }

  if (st.step === 'confirm_pickup') {
    const req = request(st.requestId);
    if (/^(si|sí|s|yes|confirmo|si, confirmo|ok|dale)\b/.test(n)) { confirmPickup(req.id, p.id, true); return botReply(key, '✅ Gracias, confirmaste la entrega. Te avisamos cuando ' + firstName(student(req.studentId).name) + ' salga.'); }
    if (/^(no|n)\b/.test(n)) { confirmPickup(req.id, p.id, false); return botReply(key, '⛔ Entendido, NO se entregará al estudiante. La garita fue notificada.'); }
    return botReply(key, 'Responde SÍ para confirmar o NO para negar la entrega.', ['Sí, confirmo', 'No']);
  }
  if (st.step === 'ask_child') {
    const kid = kids.find((k) => new RegExp('\\b' + normalize(firstName(k.name)) + '\\b').test(n));
    if (!kid) return botReply(key, 'No reconocí el nombre. Elige uno:', kids.map((k) => firstName(k.name)));
    d.studentId = kid.id;
    return cont();
  }
  if (st.step === 'ask_time') {
    const t = parseTime(n);
    if (!t) return botReply(key, 'No entendí la hora. Escríbela como 3:30 pm o 15:30.');
    d.time = t;
    const nd = parseDate(n); if (nd !== todayISO()) d.date = nd;
    return cont();
  }
  if (st.step === 'ask_pickup') {
    if (/^(no|nadie|ninguno|ninguna)\b/.test(n)) { delete S.chatState[key]; return botReply(key, 'Ok, descarté la solicitud. Registra a la persona en la app y vuelve a escribirme.'); }
    const hint = /^yo\b/.test(n) ? 'yo' : n.replace(/\(.*\)/, '').trim();
    const pid = resolvePickup(hint, d.studentId, p.id);
    if (!pid) return botReply(key, 'Esa persona no está autorizada. Elige una de la lista o regístrala en la app.', pickupCandidates(d.studentId).map((c) => c.person.id === p.id ? 'Yo' : firstName(c.person.name) + ' (' + c.person.relation + ')'));
    d.pickupBy = pid;
    return cont();
  }
  if (st.step === 'confirm') {
    if (/adjunt|certificado|📎/.test(n)) { d.attachment = 'certificado_medico.jpg'; botReply(key, '📎 Recibí certificado_medico.jpg ✅'); return cont(); }
    if (/^(si|sí|s|yes|correcto|ok|dale|confirmo)\b/.test(n)) {
      delete S.chatState[key];
      delete d.pickupHint;
      createRequest(d);
      return;
    }
    if (/^(no|n)\b/.test(n)) { delete S.chatState[key]; return botReply(key, 'Ok, la descarté. Escríbeme de nuevo con los datos correctos, por ejemplo: "Necesito retirar a ' + firstName(kids[0].name) + ' hoy a las 3:30 pm".'); }
    return botReply(key, 'Responde Sí para enviar o No para descartar.', ['Sí', 'No']);
  }
  // paso desconocido
  delete S.chatState[key];
  botReply(key, botMenu(p));
}

/* =====================================================================
   Bus escolar: rutas, GPS simulado, monitora y "¿dónde está mi hijo?"
   ===================================================================== */
function tripKey(routeId, leg, date) { return (date || todayISO()) + '_' + routeId + '_' + leg; }
function getTrip(routeId, leg, date) {
  const k = tripKey(routeId, leg, date);
  if (!S.busTrips) S.busTrips = {};
  if (!S.busTrips[k]) S.busTrips[k] = { status: 'programado', boarded: {}, noBus: [] };
  return S.busTrips[k];
}
function minutesOf(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function fmtClock12(ts) { const d = new Date(ts); return fmtTime(pad(d.getHours()) + ':' + pad(d.getMinutes())); }
function currentLeg(r) {
  // { leg, progress, simulated } si el bus está en ruta ahora; null si no
  if (S.settings.simulateBus) return { leg: 'vuelta', progress: S.settings.busProgress, simulated: true };
  const now = minutesOf(nowHHMM());
  for (const leg of ['ida', 'vuelta']) {
    const w = r.schedule[leg]; const a = minutesOf(w.start); const b = minutesOf(w.end);
    if (now >= a && now <= b) return { leg, progress: (now - a) / (b - a), simulated: false };
  }
  return null;
}
function nextLegInfo(r) {
  const now = minutesOf(nowHHMM());
  for (const leg of ['ida', 'vuelta']) if (now < minutesOf(r.schedule[leg].start)) return LEG_NAMES[leg] + ' a las ' + fmtTime(r.schedule[leg].start);
  return 'ida mañana a las ' + fmtTime(r.schedule.ida.start);
}
function legStops(r, leg) { return leg === 'ida' ? r.stops.slice().reverse() : r.stops; }
function busPosition(r, leg, progress) {
  const stops = legStops(r, leg); const n = stops.length;
  const segF = Math.min(0.999, Math.max(0, progress)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(segF)); const f = segF - i;
  const a = stops[i]; const b = stops[i + 1];
  const total = minutesOf(r.schedule[leg].end) - minutesOf(r.schedule[leg].start);
  return {
    lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, prevStop: a, nextStop: b, index: i, frac: f, stops,
    minutesLeft: Math.round((1 - progress) * total),
    etaTo: (stop) => { const j = stops.findIndex((s) => s.id === stop.id); return Math.max(0, Math.round(((j - i - f) / (n - 1)) * total)); },
  };
}
function busStatusFor(st) {
  const r = route(st.routeId); if (!r) return null;
  const cur = currentLeg(r); if (!cur) return { r, active: false };
  const trip = getTrip(r.id, cur.leg);
  return { r, active: true, leg: cur.leg, trip, rec: trip.boarded[st.id], noBus: trip.noBus.includes(st.id), stop: r.stops.find((s) => s.id === st.stopId), pos: busPosition(r, cur.leg, cur.progress), simulated: cur.simulated };
}
function whereIs(studentId) {
  const st = student(studentId); const t = todayISO();
  const exit = S.requests.find((x) => x.kind === 'salida' && x.studentId === studentId && x.date === t && x.status === 'retirado');
  if (exit) {
    const off = staffMember(exit.exitBy);
    return { text: '🚪 ' + firstName(st.name) + ' salió por ' + exit.pickupPoint + ' a las ' + fmtClock12(exit.exitAt) + ', retirado(a) por ' + describePickup(exit) + '. Confirmó ' + off.name + ' (' + (off.title || roleName(off.role)) + ').' };
  }
  const appr = S.requests.find((x) => x.kind === 'salida' && x.studentId === studentId && x.date === t && x.status === 'aprobada');
  const apprTxt = appr ? ' Tiene salida aprobada a las ' + fmtTime(appr.time) + ' por ' + appr.pickupPoint + ', aún no ha salido.' : '';
  const bus = busStatusFor(st);
  if (bus && bus.active) {
    const r = bus.r; const mon = staffMember(r.monitorId);
    if (bus.noBus) return { text: '🚌 Hoy ' + firstName(st.name) + ' no va en el ' + r.name + ' (avisado por la familia).' + (apprTxt || ' Está en el plantel.') };
    if (bus.rec && bus.rec.status === 'abordo') {
      const eta = bus.stop ? bus.pos.etaTo(bus.stop) : bus.pos.minutesLeft;
      return {
        text: '🚌 ' + firstName(st.name) + ' va en el ' + r.name + ' (placa ' + r.plate + '), ' + LEG_NAMES[bus.leg] + '. Abordó a las ' + fmtClock12(bus.rec.ts) + '.\n📍 Próxima parada: ' + bus.pos.nextStop.name + (bus.stop ? (eta > 0 ? '\n🏁 Llega a ' + bus.stop.name + ' en ~' + eta + ' min' : '\n🏁 Está llegando a ' + bus.stop.name) : '') + '\n👩 Monitora: ' + (mon ? mon.name : '—'),
        location: { lat: bus.pos.lat, lng: bus.pos.lng, routeId: r.id, leg: bus.leg, progress: currentLeg(r).progress, label: r.name + ' · ' + LEG_NAMES[bus.leg] + (bus.simulated ? ' · GPS simulado' : ' · GPS en vivo') },
      };
    }
    if (bus.rec && bus.rec.status === 'bajo') return { text: '✅ ' + firstName(st.name) + ' bajó del ' + r.name + ' en ' + ((r.stops.find((s) => s.id === bus.rec.stopId) || {}).name || 'su parada') + ' a las ' + fmtClock12(bus.rec.ts) + '. Lo confirmó la monitora ' + staffMember(bus.rec.by).name + '.' };
    if (bus.rec && bus.rec.status === 'no_abordo') return { text: '⚠️ La monitora marcó que ' + firstName(st.name) + ' NO abordó el ' + r.name + ' (' + fmtClock12(bus.rec.ts) + ').' + (apprTxt || ' Contacta a recepción al ' + S.school.phone + '.') };
    return { text: '⏳ El ' + r.name + ' está en ruta, pero la monitora aún no ha marcado a ' + firstName(st.name) + ' a bordo.' + (apprTxt || ' Si no lo esperabas, llama a recepción al ' + S.school.phone + '.') };
  }
  const now = minutesOf(nowHHMM());
  if (now >= minutesOf(S.settings.schoolStart) && now <= minutesOf(S.settings.schoolEnd)) {
    const tch = teacherOf(st);
    return { text: '🏫 ' + firstName(st.name) + ' está en el plantel · ' + st.grade + ' ' + levelName(st.level) + (tch ? ' · ' + tch.name : '') + '.' + apprTxt };
  }
  return { text: '🕒 Fuera de horario escolar. No hay registro de salida especial de ' + firstName(st.name) + ' hoy.' + (bus && bus.r ? ' Próximo viaje del ' + bus.r.name + ': ' + nextLegInfo(bus.r) + '.' : '') };
}
function markBoarding(routeId, leg, studentId, status, by, stopId) {
  const trip = getTrip(routeId, leg);
  trip.boarded[studentId] = { status, ts: Date.now(), by, stopId: stopId || null };
  const st = student(studentId); const r = route(routeId);
  const verb = status === 'abordo' ? 'Marcó a bordo' : status === 'bajo' ? 'Marcó que bajó' : 'Marcó NO abordó';
  logEvent(verb + ' a ' + st.name + ' · ' + r.name + ' ' + LEG_NAMES[leg], staffMember(by).name);
  if (status === 'no_abordo') notifyRole('recepcion', st.name + ' no abordó el ' + r.name + ' (' + LEG_NAMES[leg] + ')');
  save();
}
function setTripStatus(routeId, leg, status, by) {
  const trip = getTrip(routeId, leg); trip.status = status;
  if (status === 'en_ruta') trip.startedAt = Date.now();
  if (status === 'finalizado') trip.endedAt = Date.now();
  logEvent((status === 'en_ruta' ? 'Inició' : status === 'finalizado' ? 'Finalizó' : 'Programó') + ' el viaje ' + route(routeId).name + ' ' + LEG_NAMES[leg], staffMember(by).name);
  save();
}
function markNoBus(studentId, personId, legs) {
  const st = student(studentId); const r = route(st.routeId);
  if (!r) return false;
  legs.forEach((leg) => { const trip = getTrip(r.id, leg); if (!trip.noBus.includes(studentId)) trip.noBus.push(studentId); });
  const by = person(personId);
  logEvent('Avisó que ' + st.name + ' hoy no va en el ' + r.name + ' (' + legs.join(', ') + ')', by.name);
  S.notifications.push({ id: uid('n'), toStaff: r.monitorId, text: '🚌 ' + st.name + ' hoy no va en el bus (' + legs.join(', ') + ') · avisó ' + by.name, ts: Date.now(), read: false });
  toast('🚌 Monitora ' + staffMember(r.monitorId).name + ': ' + st.name + ' hoy no va en el bus', 'school');
  st.titulares.filter((t) => t !== personId).forEach((t) => notifyPerson(t, 'ℹ️ ' + by.name + ' avisó que ' + firstName(st.name) + ' hoy no va en el ' + r.name + ' (' + legs.join(', ') + ').'));
  save();
  return true;
}

/* --- intenciones del bot --- */
function startDonde(key, p, kids, n) {
  const sid = matchKid(n, kids);
  if (!sid) { S.chatState[key] = { step: 'ask_child', draft: { kind: 'donde' } }; return botReply(key, '¿De cuál de tus hijos quieres saber?', kids.map((k) => firstName(k.name))); }
  finishDonde(key, sid);
}
function finishDonde(key, sid) {
  const w = whereIs(sid);
  logEvent('Consultó la ubicación de ' + student(sid).name + ' por WhatsApp', person(key) ? person(key).name : key);
  botReply(key, w.text, null, w.location ? { location: w.location } : null);
}
function startNoBus(key, p, kids, n) {
  const legs = /manana|ida/.test(n) && !/tarde|vuelta|regreso/.test(n) ? ['ida'] : /tarde|vuelta|regreso/.test(n) && !/manana|ida/.test(n) ? ['vuelta'] : ['ida', 'vuelta'];
  const sid = matchKid(n, kids);
  if (!sid) { S.chatState[key] = { step: 'ask_child', draft: { kind: 'nobus', legs } }; return botReply(key, '¿Cuál de tus hijos no va en el bus hoy?', kids.map((k) => firstName(k.name))); }
  finishNoBus(key, p, { studentId: sid, legs });
}
function finishNoBus(key, p, d) {
  const st = student(d.studentId);
  if (!st.routeId) return botReply(key, firstName(st.name) + ' no tiene ruta de bus registrada. Puedes asignarla en la app.');
  markNoBus(d.studentId, p.id, d.legs);
  const r = route(st.routeId);
  botReply(key, '🚌 Listo. Avisé a la monitora ' + staffMember(r.monitorId).name + ' que ' + firstName(st.name) + ' hoy no va en el ' + r.name + ' (' + d.legs.map((l) => LEG_NAMES[l]).join(' y ') + ').');
}
