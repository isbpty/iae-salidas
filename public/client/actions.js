/* =====================================================================
   IAE Salidas · Interfaz: eventos
   ACTIONS (data-action), FORMS (data-form), onClick/onSubmit/onChange, run y formData.
   Va al final: los escuchas se enlazan en DOMContentLoaded (views-core.js), cuando todo ya está definido.
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
  setView(el) { UI.view = el.dataset.view; if (UI.view !== 'school') UI.q = ''; },
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
  toggleTheme() { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); },
  daySummary() {
    UI.modal = { type: 'daySummary', data: {} };
    apply('day_summary', {}).then((r) => { if (UI.modal && UI.modal.type === 'daySummary') { UI.modal.data.result = r; renderModal(); } }).catch(() => { UI.modal = null; renderModal(); });
  },
  sendDaySummary() { run('send_day_summary', {}, 'Resumen enviado a Dirección (avisos de Administración)').then((r) => { if (r) { UI.modal = null; render(); } }); },
  closeModal() { UI.modal = null; },
  lookupPerson(el) {
    const form = el.closest('form');
    const d = formData(form);
    UI.modal.data = Object.assign({}, UI.modal.data, d, { found: null, foundBy: null, lookupError: null });
    if (!String(d.lookupCedula || '').trim() && !String(d.lookupPhone || '').trim()) { UI.modal.data.lookupError = 'Escribe la cédula o el teléfono.'; return; }
    const by = { cedula: d.lookupCedula, phone: d.lookupPhone };
    api.command('lookup_person', by)
      .then((r) => { if (UI.modal && UI.modal.type === 'newAuth') { UI.modal.data.found = r.result; UI.modal.data.foundBy = by; renderModal(); } })
      .catch((e) => {
        if (e.status === 401) { showLogin(); return; }
        if (UI.modal && UI.modal.type === 'newAuth') { UI.modal.data.lookupError = e.status === 404 ? 'No encontramos una cuenta con esa cédula o teléfono.' : e.status === 429 ? 'Demasiadas búsquedas. Espera 15 minutos.' : 'No se pudo buscar: ' + e.message; renderModal(); }
      });
  },
  openModal(el) { UI.modal = { type: el.dataset.modal, data: { id: el.dataset.id } }; },
  parentTab(el) { UI.parentTab = el.dataset.tab; },
  schoolTab(el) { UI.schoolTab = el.dataset.tab; },
  setFilter(el) { UI.filter = el.dataset.f; },
  clearSearch() { UI.q = ''; },
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
    const foundBy = UI.modal && UI.modal.data && UI.modal.data.found ? UI.modal.data.foundBy : null;
    if (d.mode === 'cuenta' && !foundBy) { alert('Busca primero a la persona con su cédula o teléfono.'); return; }
    let attachmentId = null;
    if (file) {
      const up = await run('upload_attachment', await api.filePayload(file, 'cedula'));
      if (!up) return;
      attachmentId = up.attachmentId;
    }
    const who = d.mode === 'cuenta' ? { cedula: foundBy.cedula, phone: foundBy.phone } : { name: d.name, relation: d.relation, cedula: d.cedula, phone: d.phone };
    const r = await run('add_authorization', Object.assign({ studentIds: ids, mode: d.mode, attachmentId, type: d.type, from: d.from, to: d.to }, who));
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
  if (k === 'setPhone') { UI.phoneId = el.value; render(); return; }
  if (k === 'busProgress') { const b = el.closest('label').querySelector('b'); if (b) b.textContent = el.value + '%'; return; } // se guarda con "Guardar"
  if (k === 'togglePerm') { run('set_permission', { role: el.dataset.role, capability: el.dataset.cap, allowed: el.checked }); return; }
  if (k === 'modalField') { const form = el.closest('form'); UI.modal.data = Object.assign({}, UI.modal.data, formData(form)); renderModal(); }
}
