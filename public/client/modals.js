/* =====================================================================
   IAE Salidas · Interfaz: modales (formularios)
   ===================================================================== */

function renderModal() {
  const box = document.getElementById('modal');
  if (!UI.modal) { box.className = 'modal hidden'; box.innerHTML = ''; T.modal(null); return; }
  const m = UI.modal;
  const content = { newSalida: modalSalida, newExcusa: modalExcusa, newAuth: modalAuth, reject: modalReject, guide: modalGuide, where: modalWhere, scan: modalScan, doc: modalDoc, daySummary: modalDaySummary }[m.type](m.data || {});
  box.className = 'modal';
  box.innerHTML = '<div class="modal-card"><button class="modal-x" data-action="closeModal">✕</button>' + content + '</div>';
  T.modal(m.type);
}
function modalSalida(d) {
  const p = V.me;
  const kids = studentsOf(p.id);
  const sid = d.studentId || kids[0].id;
  const date = d.date || todayISO();
  const cands = pickupCandidates(sid, date);
  const defTime = addMinutes(nowHHMM(), 120);
  return '<h3>🚪 Solicitar salida temprana</h3><form data-form="newSalida" class="form">' +
    '<label>Estudiante <select name="studentId" data-change="modalField">' + kids.map((k) => opt(k.id, k.name + ' · ' + k.grade, k.id === sid)).join('') + '</select></label>' +
    '<div class="grid2"><label>Fecha <input type="date" name="date" value="' + date + '" min="' + todayISO() + '" required data-change="modalField"></label><label>Hora <input type="time" name="time" value="' + (d.time || defTime) + '" required></label></div>' +
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
/* "Padre/madre que ya tiene cuenta": no hay directorio; se busca por cédula o teléfono completos (lookup_person).
   El resultado solo se muestra: al guardar se envía otra vez la cédula/teléfono buscados, nunca el id. */
function authLookupFields(d) {
  const found = d.found
    ? '<div class="row item"><span class="avatar sm">🧑</span><div><b>' + esc(d.found.name) + '</b> <span class="muted small">' + esc(d.found.relation) + ' · 📱 tiene cuenta</span></div></div>'
    : d.lookupError ? '<p class="small danger-text">' + esc(d.lookupError) + '</p>'
      : '<p class="small muted">Escribe la cédula o el teléfono completos de la persona y pulsa Buscar.</p>';
  return '<div class="grid2"><label>Cédula <input name="lookupCedula" placeholder="8-123-456" value="' + esc(d.lookupCedula || '') + '"></label><label>Teléfono <input name="lookupPhone" placeholder="+507 6xxx-xxxx" value="' + esc(d.lookupPhone || '') + '"></label></div>' +
    '<div class="actions"><button class="btn small" type="button" data-action="lookupPerson">🔎 Buscar</button></div>' + found;
}
function modalAuth(d) {
  const p = V.me;
  const kids = studentsOf(p.id);
  const mode = d.mode || 'nueva';
  const type = d.type || 'siempre';
  return '<h3>👥 Autorizar persona para retirar</h3><form data-form="newAuth" class="form">' +
    '<div class="label">Estudiantes</div><div class="checks">' + kids.map((k) => '<label class="check"><input type="checkbox" name="studentIds" value="' + k.id + '" checked> ' + esc(k.emoji) + ' ' + esc(k.name) + '</label>').join('') + '</div>' +
    '<div class="label">Persona</div><div class="radios"><label class="check"><input type="radio" name="mode" value="nueva" data-change="modalField"' + (mode === 'nueva' ? ' checked' : '') + '> Nueva persona (sin cuenta)</label><label class="check"><input type="radio" name="mode" value="cuenta" data-change="modalField"' + (mode === 'cuenta' ? ' checked' : '') + '> Padre/madre que ya tiene cuenta</label></div>' +
    (mode === 'nueva'
      ? '<div class="grid2"><label>Nombre completo <input name="name" required value="' + esc(d.name || '') + '"></label><label>Parentesco <input name="relation" required placeholder="Abuela, Tío, Chofer…" value="' + esc(d.relation || '') + '"></label><label>Cédula <input name="cedula" required placeholder="8-123-456" value="' + esc(d.cedula || '') + '"></label><label>Teléfono <input name="phone" placeholder="+507 6xxx-xxxx" value="' + esc(d.phone || '') + '"></label></div>'
      : authLookupFields(d)) +
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
    const el = pickupEligibility(r.studentId, r.pickupBy, r.date);
    return '<h3>✅ Código válido · ' + r.code + '</h3><div class="row" style="align-items:flex-start; gap:14px">' +
      (pk.docAttachmentId ? '<img class="doc-big" style="max-width:220px; margin:0" src="/api/attachments/' + esc(pk.docAttachmentId) + '">' : '<div class="doc-placeholder" style="width:120px;height:120px;font-size:13px">🪪<br>' + esc(pk.docName || 'sin foto') + '</div>') +
      '<div><div style="font-size:18px"><b>' + esc(pk.name) + '</b> <span class="muted">(' + esc(pk.relation) + ')</span></div><div>Cédula: <b class="mono">' + esc(pk.cedula) + '</b> · ' + kindBadge(el.kind || r.pickupKind) + '</div>' +
      '<div style="margin-top:8px">Retira a <b>' + esc(st.emoji) + ' ' + esc(st.name) + '</b> · ' + esc(st.grade) + '</div><div class="small muted">Salida ' + fmtTime(r.time) + ' · ' + esc(r.pickupPoint) + '</div>' +
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
function modalDaySummary(d) {
  const s = d.result;
  if (!s) return '<h3>📊 Resumen del día</h3><div class="empty">Calculando…</div>';
  const row = (k, v) => '<tr><td>' + k + '</td><td><b>' + v + '</b></td></tr>';
  const min = (v) => (v == null ? 'sin datos' : v + ' min');
  return '<h3>📊 Resumen del día · ' + esc(fmtDate(s.date)) + '</h3>' +
    '<div class="kpis">' + kpi('salidas pedidas', s.salidas.pedidas) + kpi('aprobadas', s.salidas.aprobadas, 'ok') + kpi('retiradas', s.salidas.retiradas) + kpi('pendientes', s.salidas.pendientes, s.salidas.pendientes ? 'warn' : '') + '</div>' +
    '<table class="tbl">' + row('Auto-aprobadas', s.salidas.autoAprobadas) + row('Rechazadas / canceladas', s.salidas.rechazadas + ' / ' + s.salidas.canceladas) + row('Con confirmación de titular (una vez)', s.salidas.conConfirmacion) +
    row('Excusas recibidas · aceptadas · pendientes', s.excusas.recibidas + ' · ' + s.excusas.aceptadas + ' · ' + s.excusas.pendientes) + row('Por WhatsApp · por la app', s.canales.whatsapp + ' · ' + s.canales.app) +
    row('Aprobación manual promedio', min(s.tiempos.aprobacionPromedioMin)) + row('De aprobada a retirada', min(s.tiempos.retiroPromedioMin)) +
    (s.horaPico ? row('Hora pico', s.horaPico.hora + ' (' + s.horaPico.salidas + ' salidas)') : '') + row('Retiró más', s.topRetira.length ? esc(s.topRetira.map((x) => x.name + ' (' + x.count + ')').join(', ')) : '—') + '</table>' +
    '<pre class="summary-text">' + esc(s.text) + '</pre>' +
    '<div class="actions"><button class="btn primary" data-action="sendDaySummary">📲 Enviar a Dirección</button><button class="btn" data-action="closeModal">Cerrar</button></div>';
}
function modalGuide() {
  return '<h3>📖 Guion sugerido para el demo</h3><ol class="guide">' +
    '<li><b>WhatsApp · Carlos (papá):</b> toca el chip "Necesito retirar a Joseph hoy a las …" (2 h de anticipación). Confirma con <i>Sí</i>. Como cumple la regla, se <b>auto-aprueba</b>: llega el punto de retiro y el código a Carlos y a Ana.</li>' +
    '<li><b>WhatsApp · Carlos:</b> "A Joseph lo va a retirar la abuela a las …" (30 min). Queda <b>pendiente</b> por poca anticipación. Cambia a <b>Escuela · Recepción</b>, elige el punto de retiro y aprueba. Mira la notificación al padre.</li>' +
    '<li><b>Escuela · Garita (Manuel):</b> en "Garita · Hoy" verifica la cédula y marca <b>retirado</b>. Ambos padres reciben "Joseph fue retirado a las …".</li>' +
    '<li><b>Autorización de una sola vez:</b> Carlos envía "Hoy retira a Joseph Laura Gómez a las …". Recepción aprueba. En Garita, pulsa <b>solicitar confirmación</b>: Carlos y Ana reciben "¿Confirmas?". Responde <i>Sí, confirmo</i> desde WhatsApp y luego marca retirado. Laura (que tiene cuenta) también ve la autorización en su app.</li>' +
    '<li><b>Excusa:</b> "Sofía no irá mañana, tiene cita médica" → adjunta certificado → Recepción acepta → la profesora de Kínder lo ve en su bandeja.</li>' +
    '<li><b>App Padres:</b> muestra hijos, solicitudes, autorizados (siempre / por tiempo / una vez), y agrega un autorizado nuevo o un padre con cuenta (se busca por su cédula o teléfono completos).</li>' +
    '<li><b>Permisos:</b> en otro dispositivo inicia sesión como Prof. Diana Ríos (solo ve 3°) y luego como Administración para editar la matriz de permisos y la regla de auto-aprobación.</li>' +
    '<li><b>Bus:</b> en WhatsApp escribe "¿Dónde está Joseph?": responde con el bus, la próxima parada, el tiempo de llegada y el mapa GPS (simulado). Después de marcarlo retirado en garita, la misma pregunta responde "salió por Puerta Principal a las …, confirmó el oficial …".</li>' +
    '<li><b>Monitora:</b> inicia sesión como Kenia Pérez (solo ve el Bus 12), marca Abordó / Bajó / No abordó e inicia o finaliza el viaje. Escribe "Sofía hoy no va en el bus" desde WhatsApp y mira cómo le llega a la monitora.</li>' +
    '<li><b>Aviso proactivo:</b> aprueba una salida donde retira Laura Gómez (una vez) o Luis (por tiempo): los titulares reciben un aviso con botones "Es correcto / NO"; con NO se cancela la salida y se avisa a garita.</li>' +
    '<li><b>QR:</b> en App Padres la salida aprobada muestra el QR y el código; en Garita usa "Escanear QR / código" para ver la foto o cédula del autorizado y marcar el retiro. Al registrar un autorizado nuevo, la foto o cédula es obligatoria.</li>' +
    '<li>Como Administración, activa <b>Vista dividida</b> para ver WhatsApp y el dashboard a la vez; cada dispositivo del demo entra con su propio usuario.</li></ol>' +
    '<div class="actions"><button class="btn primary" data-action="closeModal">Entendido</button></div>';
}
