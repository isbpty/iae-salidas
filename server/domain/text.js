import { partsIn, pad, todayISO, shiftISO } from './time.js';

export const ROLE_NAMES = { admin: 'Administración', recepcion: 'Recepción', profesor: 'Profesor', garita: 'Garita de salida', monitora: 'Monitora de bus' };
export const AUTH_TYPES = { siempre: 'Siempre', temporal: 'Por tiempo', una_vez: 'Una vez (con confirmación)' };
export const STATUS = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada', retirado: 'Retirado', cancelada: 'Cancelada', aceptada: 'Aceptada' };
export const CHANNEL = { whatsapp: 'WhatsApp', web: 'App' };
export const LEG_NAMES = { ida: 'ida (mañana)', vuelta: 'vuelta (tarde)' };
export const roleName = (r) => ROLE_NAMES[r] || r;
export const kindLabel = (kind) => (kind === 'titular' ? 'Titular' : AUTH_TYPES[kind] || kind);
export const firstName = (name) => (name || '').split(' ')[0];

export function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return (h % 12 || 12) + ':' + pad(m) + (h >= 12 ? ' pm' : ' am');
}
export function fmtDate(ctx, iso) {
  if (!iso) return '';
  if (iso === todayISO(ctx.now, ctx.tz)) return 'hoy';
  if (iso === shiftISO(ctx.now, ctx.tz, 1)) return 'mañana';
  if (iso === shiftISO(ctx.now, ctx.tz, -1)) return 'ayer';
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('es-PA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
export function fmtClock(ctx, ms) { return fmtTime(partsIn(new Date(ms), ctx.tz).time); }
