/* =====================================================================
   IAE Salidas · Interfaz: bus (rutas, mapa simulado, ubicación)
   ===================================================================== */

function busChip(k) {
  const r = k.routeId && route(k.routeId);
  if (!r) return '<span class="muted small">sin bus</span>';
  const stop = r.stops.find((s) => s.id === k.stopId);
  return '<span class="bus-chip">🚌 ' + esc(r.name) + (stop ? ' · ' + esc(stop.name) : '') + (k.busLegs && k.busLegs.length === 1 ? ' · solo ' + k.busLegs[0] : '') + '</span>';
}
/* El servidor manda la posición y la velocidad (progreso por ms); entre sondeos el bus avanza solo. */
const MAP_ANIMS = new Map(); let MAP_SEQ = 0;
function animateBuses() {
  for (const [id, a] of MAP_ANIMS) {
    const el = document.getElementById(id);
    if (!el) { MAP_ANIMS.delete(id); continue; }
    let p = a.base + a.rate * (Date.now() - a.at);
    p = a.simulated ? p % 1 : Math.min(1, p);
    const pos = busPosition(a.r, a.leg, p);
    el.style.transform = 'translate(' + a.X(pos.lng) + 'px,' + a.Y(pos.lat) + 'px)';
  }
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
    const gps = (V.gpsNow || {})[r.id] || {};
    const id = 'bus_' + (++MAP_SEQ);
    MAP_ANIMS.set(id, { r, leg, base: progress, rate: gps.rate || 0, simulated: !!gps.simulated, at: Date.now(), X, Y });
    bus = '<g class="bus-marker" id="' + id + '" style="transform:translate(' + X(p.lng) + 'px,' + Y(p.lat) + 'px)"><circle class="bus-pulse" r="22" fill="' + safeColor(r.color) + '"/><circle r="15" fill="#fff" stroke="' + safeColor(r.color) + '" stroke-width="3"/><text y="6" font-size="16" text-anchor="middle">🚌</text></g>';
  }
  return '<svg class="map" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg"><rect width="' + W + '" height="' + H + '" fill="#eef3ee"/>' + grid +
    '<polyline points="' + pts + '" fill="none" stroke="' + safeColor(r.color) + '" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity=".75"/>' +
    stops.map((s, i) => '<circle cx="' + X(s.lng) + '" cy="' + Y(s.lat) + '" r="6" fill="' + (i === 0 || i === stops.length - 1 ? safeColor(r.color) : '#fff') + '" stroke="' + safeColor(r.color) + '" stroke-width="2"/><text x="' + X(s.lng) + '" y="' + (Y(s.lat) + (i % 2 ? -12 : 22)) + '" font-size="12" text-anchor="middle" fill="#374151">' + esc(s.name) + '</text>').join('') +
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
    const cur = gpsPosition(r);
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
      return '<tr><td>' + esc(k.emoji) + ' ' + esc(k.name) + ' <span class="muted small">' + esc(k.grade) + '</span></td><td>' + (stop ? esc(stop.name) : '—') + '</td><td>' + status + '</td><td>' + btns + '</td></tr>';
    }).join('');
    return '<div class="card route-card" style="border-left-color:' + safeColor(r.color) + '">' + head + map + '<table class="tbl" style="margin-bottom:0"><tr><th>Estudiante</th><th>Parada</th><th>Estado hoy</th><th></th></tr>' + (rows || '<tr><td colspan="4" class="muted">Sin estudiantes en este tramo.</td></tr>') + '</table></div>';
  }).join('');
}
