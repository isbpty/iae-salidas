/* =====================================================================
   IAE Salidas · Interfaz: app de padres y WhatsApp simulado
   ===================================================================== */

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
    return '<div class="card kid"><div class="avatar">' + esc(k.emoji) + '</div><div class="grow"><b>' + esc(k.name) + '</b><div class="muted small">' + esc(k.grade) + ' · ' + esc(levelName(k.levelId)) + '</div>' +
      '<div class="muted small">Titulares: tú' + (others.length ? ', ' + esc(others.join(', ')) : '') + ' · Autorizados: ' + authsForStudent(k.id).filter((a) => isAuthActive(a)).length + '</div>' +
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
    return '<div class="card"><div class="row"><span class="avatar sm">' + esc(k.emoji) + '</span><b>' + esc(k.name) + '</b> <span class="muted small">máx. ' + V.settings.maxTitulares + ' titulares</span></div>' + tit + (auths || '<div class="muted small">Sin personas autorizadas.</div>') + '</div>';
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
  return '<div class="card req"><div class="row top"><span class="avatar sm">' + esc(st.emoji) + '</span><div class="grow"><div class="small muted">' + esc(st.name) + ' · ' + esc(st.grade) + ' · vía ' + CHANNEL[r.channel] + ' · por ' + esc(firstName(by.name)) + '</div>' + main + '</div>' + badge(r.status, r.expired) + '</div>' +
    (o.compact ? '' : '<details class="hist"><summary>Historial</summary>' + r.history.map((h) => '<div class="small"><span class="muted mono">' + fmtTs(h.ts) + '</span> ' + esc(h.text) + '</div>').join('') + '</details>') +
    (canCancel ? '<div class="actions"><button class="btn tiny" data-action="cancelReq" data-id="' + r.id + '">Cancelar solicitud</button></div>' : '') +
    '</div>';
}

function qrBox(r) {
  return '<div class="qr-box"><div class="qrc" data-qr="IAE-' + r.code + '-' + r.id + '"></div><div><div class="small muted">Código de retiro</div><div class="qr-code">' + r.code + '</div><div class="small muted">Muéstralo en garita o dilo en voz alta</div></div></div>';
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
    Object.values(V.persons).filter((x) => x.phone).map((x) => {
      const s = chatSummary(x.id);
      const unread = s && s.unread ? ' 🔵' + s.unread : '';
      return opt(x.id, x.name + ' · ' + x.phone + (x.hasAccount ? '' : ' (sin cuenta)') + unread, x.id === key);
    }).join('') +
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
  /* De noche los ejemplos pasarían la medianoche y el servidor los rechazaría (time_in_past): se piden para mañana. */
  const late = minutesOf(nowHHMM()) + 125 >= 24 * 60;
  const t1 = late ? '8:00 am' : fmtTime(addMinutes(nowHHMM(), 125));
  const t2 = late ? '9:00 am' : fmtTime(addMinutes(nowHHMM(), 30));
  const day = late ? 'mañana' : 'hoy';
  const chips = ['Hola', 'Necesito retirar a ' + firstName(k.name) + ' ' + day + ' a las ' + t1];
  const auths = authsForStudent(k.id).filter((a) => isAuthActive(a));
  if (auths.length) {
    const a = auths[0];
    const ap = person(a.personId) || {};
    chips.push('A ' + firstName(k.name) + ' lo va a retirar ' + (String(ap.relation || '').toLowerCase() === 'abuela' ? 'la abuela' : ap.name) + (late ? ' mañana' : '') + ' a las ' + t2);
    const uv = auths.find((x) => x.type === 'una_vez');
    if (uv) chips.push((late ? 'Mañana' : 'Hoy') + ' retira a ' + firstName(k.name) + ' ' + (person(uv.personId) || {}).name + ' a las ' + t2);
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
