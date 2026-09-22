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
/* Adds `days` calendar days to a millisecond timestamp, e.g. an authorization's createdAt, and
   returns YYYY-MM-DD. Used for the default una_vez expiry (mirrors server/domain/eligibility.js). */
function addDaysISO(ms, days) { const d = new Date(ms); d.setDate(d.getDate() + days); return localISO(d); }
function nowHHMM() { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
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
function fmtTs(ts) { const d = new Date(ts); return d.toLocaleDateString('es-PA', { day: '2-digit', month: 'short' }) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function fmtClock(ts) { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function fmtClock12(ts) { return fmtTime(fmtClock(ts)); }
