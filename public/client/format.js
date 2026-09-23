/* Etiquetas y formateadores para el navegador (copia de server/domain/text.js). */
const pad = (n) => String(n).padStart(2, '0');
const ROLE_NAMES = { admin: 'Administración', recepcion: 'Recepción', profesor: 'Profesor', garita: 'Garita de salida', monitora: 'Monitora de bus', parent: 'Padre/Madre' };
const AUTH_TYPES = { siempre: 'Siempre', temporal: 'Por tiempo', una_vez: 'Una vez (con confirmación)' };
const STATUS = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada', retirado: 'Retirado', cancelada: 'Cancelada', aceptada: 'Aceptada' };
const CHANNEL = { whatsapp: 'WhatsApp', web: 'App' };
const LEG_NAMES = { ida: 'ida (mañana)', vuelta: 'vuelta (tarde)' };
const roleName = (r) => ROLE_NAMES[r] || r;
const kindLabel = (kind) => (kind === 'titular' ? 'Titular' : AUTH_TYPES[kind] || kind);
const firstName = (name) => (name || '').split(' ')[0];
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function localISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
/* "hoy" es el día de la escuela que manda el servidor (V.today), no el del navegador. */
function todayISO() { return (typeof V !== 'undefined' && V && V.today) || localISO(new Date()); }
function shiftISO(days) { const d = new Date(todayISO() + 'T12:00:00'); d.setDate(d.getDate() + days); return localISO(d); }
/* L16: las horas se muestran en la zona horaria de la escuela (view.settings.timezone, América/Panamá),
   no en la del navegador -- un dispositivo con otra zona o con el reloj desfasado mostraba horas
   equivocadas en avisos, abordajes y la TV de garita. `serverNow()` (state.js) calibra "ahora" contra el
   reloj del servidor (V.serverNow), no el del dispositivo. */
function schoolTZ() { return (typeof V !== 'undefined' && V && V.settings && V.settings.timezone) || 'America/Panama'; }
function tzHHMM(ts) {
  const parts = new Intl.DateTimeFormat('es-PA', { timeZone: schoolTZ(), hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '00';
  let h = get('hour'); if (h === '24') h = '00';
  return pad(Number(h)) + ':' + pad(Number(get('minute')));
}
function nowHHMM() { return tzHHMM(typeof serverNow === 'function' ? serverNow() : Date.now()); }
function minutesOf(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function addMinutes(hhmm, n) { const t = ((minutesOf(hhmm) + n) % 1440 + 1440) % 1440; return pad(Math.floor(t / 60)) + ':' + pad(t % 60); }
function fmtTime(hhmm) { if (!hhmm) return ''; const [h, m] = hhmm.split(':').map(Number); return (h % 12 || 12) + ':' + pad(m) + (h >= 12 ? ' pm' : ' am'); }
function fmtDate(iso) {
  if (!iso) return '';
  if (iso === todayISO()) return 'hoy';
  if (iso === shiftISO(1)) return 'mañana';
  if (iso === shiftISO(-1)) return 'ayer';
  return new Date(iso + 'T00:00:00').toLocaleDateString('es-PA', { weekday: 'short', day: 'numeric', month: 'short' });
}
function fmtTs(ts) { const d = new Date(ts); return d.toLocaleDateString('es-PA', { day: '2-digit', month: 'short', timeZone: schoolTZ() }) + ' ' + tzHHMM(ts); }
function fmtClock(ts) { return tzHHMM(ts); }
function fmtClock12(ts) { return fmtTime(fmtClock(ts)); }
