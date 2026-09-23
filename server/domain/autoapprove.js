import { listRequests } from '../db/repo.js';
import { localToMs } from './time.js';
import { pickupEligibility } from './eligibility.js';
import { fmtTime } from './text.js';

export async function evaluateAutoApprove(ctx, req, st) {
  const cfg = ctx.settings;
  if (!cfg.autoApprove) return { ok: false, reason: 'auto-aprobación desactivada' };
  if (!st.titulares.includes(req.requestedBy)) return { ok: false, reason: 'el solicitante no es titular' };
  const mins = Math.round((localToMs(req.date, req.time, ctx.tz) - ctx.now.getTime()) / 60000);
  if (mins < cfg.minAnticipationMin) return { ok: false, reason: 'menos de ' + cfg.minAnticipationMin + ' min de anticipación' };
  const el = await pickupEligibility(ctx, req.studentId, req.pickupBy, req.date);
  if (!el.ok) return { ok: false, reason: 'la persona que retira no está autorizada' };
  if (el.kind === 'una_vez') return { ok: false, reason: 'autorización de una sola vez requiere revisión' };
  const cutoff = ctx.now.getTime() - 30 * 24 * 3600 * 1000;
  /* Only `createdAt`/`status` are read below -- `hydrate: false` skips the history/confirmation
     batch queries neither check needs (R2). */
  const rejected = (await listRequests(ctx.q, { studentIds: [req.studentId], status: 'rechazada', hydrate: false })).some((r) => r.createdAt > cutoff);
  if (rejected) return { ok: false, reason: 'el estudiante tiene un rechazo reciente' };
  /* Never silently duplicate: a second active salida for the same student and date always needs a
     human to look at it, even if it would otherwise sail through auto-approval (L15 fix-up -- the
     simulator's second demo salida for Joseph, at short notice with the grandmother, must still
     reach the "Aprobar" button in Recepción's queue instead of being rejected outright). */
  const dup = (await listRequests(ctx.q, { studentIds: [req.studentId], date: req.date, kind: 'salida', hydrate: false })).find((r) => r.id !== req.id && ['pendiente', 'aprobada'].includes(r.status));
  if (dup) {
    const otherPk = await ctx.getPerson(dup.pickupBy);
    return { ok: false, reason: 'ya existe otra salida hoy para este estudiante (' + fmtTime(dup.time) + ', retira ' + (otherPk ? otherPk.name : '?') + '): revisar' };
  }
  return { ok: true };
}
