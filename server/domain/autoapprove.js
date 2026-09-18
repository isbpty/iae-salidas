import { listRequests } from '../db/repo.js';
import { localToMs } from './time.js';
import { pickupEligibility } from './eligibility.js';

export async function evaluateAutoApprove(ctx, req, st) {
  const cfg = ctx.settings;
  if (!cfg.autoApprove) return { ok: false, reason: 'auto-aprobación desactivada' };
  if (!st.titulares.includes(req.requestedBy)) return { ok: false, reason: 'el solicitante no es titular' };
  const mins = Math.round((localToMs(req.date, req.time, ctx.tz) - ctx.now.getTime()) / 60000);
  if (mins < cfg.minAnticipationMin) return { ok: false, reason: 'menos de ' + cfg.minAnticipationMin + ' min de anticipación' };
  const el = await pickupEligibility(ctx, req.studentId, req.pickupBy);
  if (!el.ok) return { ok: false, reason: 'la persona que retira no está autorizada' };
  if (el.kind === 'una_vez') return { ok: false, reason: 'autorización de una sola vez requiere revisión' };
  const cutoff = ctx.now.getTime() - 30 * 24 * 3600 * 1000;
  const rejected = (await listRequests(ctx.q, { studentIds: [req.studentId], status: 'rechazada' })).some((r) => r.createdAt > cutoff);
  if (rejected) return { ok: false, reason: 'el estudiante tiene un rechazo reciente' };
  return { ok: true };
}
