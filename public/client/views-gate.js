/* =====================================================================
   IAE Salidas · Interfaz: garita (salidas de hoy) y pantalla de TV
   ===================================================================== */

function personDoc(p) {
  if (p.docAttachmentId) return '<img class="doc-thumb" src="/api/attachments/' + esc(p.docAttachmentId) + '" data-action="openDoc" data-id="' + p.id + '" title="Ver documento">';
  return '<div class="doc-placeholder" data-action="openDoc" data-id="' + p.id + '" title="Ver documento">🪪<br>' + esc(p.docName || 'sin foto') + '</div>';
}
function schoolGate(staff) {
  const t = todayISO();
  const list = V.requests.filter((r) => r.kind === 'salida' && r.date === t && ['aprobada', 'retirado'].includes(r.status)).sort((a, b) => a.time.localeCompare(b.time));
  const shown = list.filter((r) => matchQ(requestQ(r)));
  const pend = shown.filter((r) => r.status === 'aprobada');
  const done = shown.filter((r) => r.status === 'retirado');
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
    return '<div class="card gate ' + r.status + '"><div><div class="gate-time">' + fmtTime(r.time) + '</div>' + personDoc(pk) + '</div><div class="grow"><div class="row"><span class="avatar sm">' + esc(st.emoji) + '</span><b>' + esc(st.name) + '</b> <span class="muted small">' + esc(st.grade) + ' · ' + esc(levelName(st.levelId)) + '</span></div>' +
      '<div class="small">Retira: <b>' + esc(pk.name) + '</b> (' + esc(pk.relation) + ') · céd. <b class="mono">' + esc(pk.cedula) + '</b> ' + kindBadge(r.pickupKind) + '</div>' +
      '<div class="small">📍 ' + esc(r.pickupPoint) + ' · código <b class="mono">' + r.code + '</b>' + (conf ? ' · confirmación: <b>' + conf + '</b>' : '') + (r.status === 'retirado' ? ' · <b>salió ' + fmtClock(r.exitAt) + '</b>' : '') + '</div>' +
      '<div class="actions">' + act + '</div></div></div>';
  };
  return '<h2>Garita · salidas de hoy <span class="muted small">' + schoolDateLong() + '</span> <span class="right"><button class="btn small" data-action="setView" data-view="tv" title="Pantalla grande para el monitor de la puerta">📺 Pantalla de garita</button> <button class="btn small primary" data-action="openModal" data-modal="scan">📷 Escanear QR / código</button></span></h2>' + searchHint(shown.length, list.length) + '<h3>Por retirar (' + pend.length + ')</h3>' + (pend.length ? pend.map(card).join('') : '<div class="empty">No hay salidas aprobadas pendientes.</div>') +
    '<h3>Retirados (' + done.length + ')</h3>' + (done.length ? done.map(card).join('') : '<div class="empty">Nadie ha salido todavía.</div>');
}
/* "Viernes, 18 de septiembre" en la zona de la escuela y con el reloj del servidor (L16), no el del
   navegador -- lo usan el encabezado de la garita y la TV. */
function schoolDateLong() {
  const f = new Date(serverNow()).toLocaleDateString('es-PA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: schoolTZ() });
  return f.charAt(0).toUpperCase() + f.slice(1);
}
/* Modo pantalla: para un monitor en la garita. Tarjetas grandes, foto del autorizado, reloj; se actualiza solo. */
function viewTv() {
  const t = todayISO();
  const list = V.requests.filter((r) => r.kind === 'salida' && r.date === t && ['aprobada', 'retirado'].includes(r.status)).sort((a, b) => a.time.localeCompare(b.time));
  const pend = list.filter((r) => r.status === 'aprobada'); const done = list.filter((r) => r.status === 'retirado').reverse();
  const card = (r) => {
    const st = student(r.studentId); const pk = person(r.pickupBy) || {}; const conf = r.confirmation && r.confirmation.status;
    const soon = Math.abs(minutesOf(r.time) - minutesOf(nowHHMM())) <= 15;
    return '<div class="tv-card' + (r.pickupKind === 'una_vez' ? ' once' : '') + (soon ? ' soon' : '') + '"><div class="tv-time">' + fmtTime(r.time) + (soon ? '<span class="tv-soon">ahora</span>' : '') + '</div>' +
      '<div class="tv-doc">' + (pk.docAttachmentId ? '<img src="/api/attachments/' + esc(pk.docAttachmentId) + '" alt="">' : '<div class="tv-nodoc">🪪</div>') + '</div>' +
      '<div class="tv-body"><div class="tv-student">' + esc(st.emoji) + ' ' + esc(st.name) + ' <span class="muted">' + esc(st.grade) + '</span></div>' +
      '<div class="tv-pick">Retira <b>' + esc(pk.name) + '</b> · ' + esc(pk.relation || '') + ' · céd. <span class="mono">' + esc(pk.cedula || '') + '</span> ' + kindBadge(r.pickupKind) + '</div>' +
      '<div class="tv-meta">📍 ' + esc(r.pickupPoint) + ' · código <b class="mono">' + r.code + '</b>' + (conf ? ' · confirmación: <b>' + conf + '</b>' : r.pickupKind === 'una_vez' ? ' · <span class="danger-text">requiere confirmación del titular</span>' : '') + '</div></div></div>';
  };
  return '<div class="tv"><header class="tv-head"><div><div class="tv-title">🛂 Garita · ' + esc(V.settings.school.name) + '</div><div class="tv-date">' + schoolDateLong() + '</div></div>' +
    '<div class="tv-clock" id="tvClock">' + nowHHMM() + '</div><button class="btn" data-action="setView" data-view="school">✕ Salir (Esc)</button></header>' +
    '<section><h2>Por retirar <span class="tv-count">' + pend.length + '</span></h2>' + (pend.length ? '<div class="tv-grid">' + pend.map(card).join('') + '</div>' : '<div class="tv-empty">Sin salidas pendientes ✅</div>') + '</section>' +
    (done.length ? '<section class="tv-done"><h2>Retirados hoy <span class="tv-count">' + done.length + '</span></h2><div class="tv-list">' + done.slice(0, 8).map((r) => { const st = student(r.studentId); const pk = person(r.pickupBy) || {}; return '<div>' + fmtClock(r.exitAt) + ' · <b>' + esc(st.name) + '</b> · ' + esc(pk.name) + '</div>'; }).join('') + '</div></section>' : '') + '</div>';
}
