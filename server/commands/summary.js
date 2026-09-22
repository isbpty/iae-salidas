/* Resumen del día para Dirección: cifras de salidas, excusas, canales, tiempos y quién retiró más. */
import { register } from './index.js';
import { requireCap, STAFF_ROLES } from './guards.js';
import { listRequests, getPerson } from '../db/repo.js';
import { notifyRole, logEvent } from '../domain/notifications.js';
import { todayISO, localToMs } from '../domain/time.js';
import { hydrateRequests } from '../db/repo.js';

const avgMin = (pairs) => {
  const ms = pairs.filter(([a, b]) => a && b).map(([a, b]) => new Date(b).getTime() - new Date(a).getTime()).filter((x) => x >= 0);
  return ms.length ? Math.round(ms.reduce((s, x) => s + x, 0) / ms.length / 60000) : null;
};
const fmtHour = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + (h >= 12 ? ' pm' : ' am'); };

export async function daySummary(ctx) {
  const date = todayISO(ctx.now, ctx.tz);
  const dayStart = new Date(localToMs(date, '00:00', ctx.tz)).toISOString();
  const salidas = await listRequests(ctx.q, { date, kind: 'salida' });
  const excusas = await hydrateRequests(ctx.q, await ctx.q.query("SELECT * FROM requests WHERE kind='excusa' AND created_at >= $1 ORDER BY created_at", [dayStart]));
  const by = (list, status) => list.filter((r) => r.status === status).length;
  const retiradas = salidas.filter((r) => r.status === 'retirado');
  const decided = salidas.filter((r) => r.decidedAt && !r.autoApproved);
  const counts = {};
  for (const r of retiradas) counts[r.pickupBy] = (counts[r.pickupBy] || 0) + 1;
  const topRetira = [];
  for (const [id, count] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3)) { const p = await getPerson(ctx.q, id); topRetira.push({ name: p ? p.name : id, count }); }
  const hours = {};
  for (const r of salidas) if (r.time) { const h = r.time.slice(0, 2) + ':00'; hours[h] = (hours[h] || 0) + 1; }
  const peak = Object.entries(hours).sort((a, b) => b[1] - a[1])[0] || null;
  const s = {
    date,
    salidas: { pedidas: salidas.length, aprobadas: by(salidas, 'aprobada') + retiradas.length, autoAprobadas: salidas.filter((r) => r.autoApproved).length, rechazadas: by(salidas, 'rechazada'), retiradas: retiradas.length, pendientes: by(salidas, 'pendiente'), canceladas: by(salidas, 'cancelada'), conConfirmacion: salidas.filter((r) => r.pickupKind === 'una_vez').length },
    excusas: { recibidas: excusas.length, aceptadas: by(excusas, 'aceptada'), pendientes: by(excusas, 'pendiente'), rechazadas: by(excusas, 'rechazada') },
    canales: { whatsapp: salidas.concat(excusas).filter((r) => r.channel === 'whatsapp').length, app: salidas.concat(excusas).filter((r) => r.channel === 'web').length },
    tiempos: { aprobacionPromedioMin: avgMin(decided.map((r) => [r.createdAt, r.decidedAt])), retiroPromedioMin: avgMin(retiradas.map((r) => [r.decidedAt || r.createdAt, r.exitAt])) },
    horaPico: peak ? { hora: fmtHour(peak[0]), salidas: peak[1] } : null,
    topRetira,
  };
  const d = new Date(date + 'T12:00:00Z');
  const fecha = d.toLocaleDateString('es-PA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  s.text = '📊 Resumen del ' + fecha + ' · ' + ctx.settings.school.name + '\n' +
    '🚪 Salidas: ' + s.salidas.pedidas + ' pedidas · ' + s.salidas.aprobadas + ' aprobadas (' + s.salidas.autoAprobadas + ' automáticas) · ' + s.salidas.retiradas + ' retiradas · ' + s.salidas.rechazadas + ' rechazadas · ' + s.salidas.pendientes + ' pendientes\n' +
    '📝 Excusas: ' + s.excusas.recibidas + ' recibidas · ' + s.excusas.aceptadas + ' aceptadas · ' + s.excusas.pendientes + ' pendientes\n' +
    '📲 Canales: ' + s.canales.whatsapp + ' por WhatsApp · ' + s.canales.app + ' por la app\n' +
    '⏱ Aprobación manual promedio: ' + (s.tiempos.aprobacionPromedioMin == null ? 'sin datos' : s.tiempos.aprobacionPromedioMin + ' min') + ' · de aprobada a retirada: ' + (s.tiempos.retiroPromedioMin == null ? 'sin datos' : s.tiempos.retiroPromedioMin + ' min') + '\n' +
    (s.horaPico ? '🕒 Hora pico: ' + s.horaPico.hora + ' (' + s.horaPico.salidas + ' salidas)\n' : '') +
    (s.topRetira.length ? '👤 Retiró más: ' + s.topRetira.map((t) => t.name + ' (' + t.count + ')').join(', ') : '👤 Nadie ha retirado todavía');
  return s;
}

register({
  day_summary: {
    roles: STAFF_ROLES,
    handler: async (ctx) => { requireCap(ctx, 'ver_solicitudes'); return daySummary(ctx); },
  },
  send_day_summary: {
    roles: STAFF_ROLES,
    handler: async (ctx) => {
      requireCap(ctx, 'ver_solicitudes');
      const s = await daySummary(ctx);
      await notifyRole(ctx, 'admin', s.text);
      await logEvent(ctx, 'Envió el resumen del día a Dirección', ctx.staff.name);
      return s;
    },
  },
});
