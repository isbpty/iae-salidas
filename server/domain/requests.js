import crypto from 'node:crypto';
import { uid } from './ids.js';
import { HttpError, notFound, conflict, badRequest } from './errors.js';
import { insertRequest, getRequest, hydrateRequests, patchRow, addRequestEvent, getStaff, listRequests, upsertConfirmation, setConversation, getConversation, clearConversation } from '../db/repo.js';
import { notifyPerson, notifyRole, notifyTeachers, logEvent } from './notifications.js';
import { pickupEligibility, pickupCandidates, todayOf } from './eligibility.js';
import { evaluateAutoApprove } from './autoapprove.js';
import { fmtDate, fmtTime, firstName, CHANNEL, roleName } from './text.js';
import { nowHHMM, todayISO, isValidDate, isValidTime } from './time.js';

export function describePickup(req, pk) {
  if (!pk) return '';
  return pk.name + (req.pickupBy === req.requestedBy ? ' (solicitante)' : ' (' + pk.relation + ')');
}
const hist = (ctx, req, text) => addRequestEvent(ctx.q, req.id, ctx.now, text);
const randomCode = () => String(crypto.randomInt(1000, 10000));
async function uniqueCode(ctx, date) {
  const used = new Set((await listRequests(ctx.q, { date, kind: 'salida', hydrate: false })).map((r) => r.code));
  let c = randomCode();
  while (used.has(c)) c = randomCode();
  return c;
}
/* Migration 004 adds a unique index on requests(date, code) for salidas. The SELECT above avoids
   the common case, but two concurrent create_salida calls for the same date can still race between
   that read and their own insert; if that happens, Postgres/PGlite reject the second insert with
   23505 and we simply draw a fresh code and try again instead of surfacing a 500. */
export async function insertSalidaRequest(ctx, req) {
  for (let attempt = 0; ; attempt++) {
    try {
      await insertRequest(ctx.q, req);
      return;
    } catch (e) {
      if (req.kind === 'salida' && e && e.code === '23505' && attempt < 5) { req.code = randomCode(); continue; }
      throw e;
    }
  }
}
/* Derived, display-only flag: an `aprobada` salida whose date has already passed (garita never
   scanned it) is shown as "vencida" without ever touching the stored status. */
export function withExpired(requests, today) {
  return requests.map((r) => ({ ...r, expired: r.kind === 'salida' && r.status === 'aprobada' && r.date < today }));
}
async function loadSalida(ctx, id) {
  /* Lock the row for the rest of the transaction so two garita officers cannot both read
     `aprobada` and both write a transition -- the lock and the hydrated read used to be two
     separate queries; `FOR UPDATE` on the hydrating `SELECT *` itself does both in one (R2). */
  const req = (await hydrateRequests(ctx.q, await ctx.q.query('SELECT * FROM requests WHERE id=$1 FOR UPDATE', [id])))[0] || null;
  if (!req) notFound('request_not_found');
  return req;
}

/* ---------- chat state around a request: queue proactive alerts, never lose one (L8/L9) ---------- */
/* A proactive "does this look right?" notice never overwrites whatever the chat is already doing
   (a draft in progress, an urgent `confirm_pickup`, or an earlier still-unanswered alert): it is
   appended to `alerts` and surfaces once that step concludes (see advanceAlert, and handleStep in
   bot/conversation.js, which calls it at every point a step ends). */
export async function queueAlert(ctx, personId, requestId) {
  const cs = await getConversation(ctx.q, personId, ctx);
  if (cs && cs.step) {
    await setConversation(ctx.q, personId, { step: cs.step, requestId: cs.requestId, draft: cs.draft, alerts: [...(cs.alerts || []), { requestId }] }, ctx.now);
  } else {
    await setConversation(ctx.q, personId, { step: 'alert_pickup', requestId, draft: null, alerts: [] }, ctx.now);
  }
}
/* Called once the current step for `personId` is resolved (answered, cancelled, or otherwise done):
   surfaces the next queued alert, if any, or clears the conversation. */
export async function advanceAlert(ctx, personId) {
  const cs = await getConversation(ctx.q, personId, ctx);
  const alerts = (cs && cs.alerts) || [];
  if (alerts.length) {
    const [next, ...rest] = alerts;
    await setConversation(ctx.q, personId, { step: 'alert_pickup', requestId: next.requestId, draft: null, alerts: rest }, ctx.now);
  } else {
    await clearConversation(ctx.q, personId);
  }
}
/* Scrubs one request out of `personId`'s chat state, whether it is the active alert_pickup/
   confirm_pickup step or merely queued -- used whenever that request stops needing an answer
   through another channel (cancelled, rejected, retired, or cancelled by staff): L8. */
export async function releasePickupState(ctx, personId, requestId) {
  const cs = await getConversation(ctx.q, personId, ctx);
  if (!cs) return;
  const isActive = (cs.step === 'alert_pickup' || cs.step === 'confirm_pickup') && cs.requestId === requestId;
  const alerts = (cs.alerts || []).filter((a) => a.requestId !== requestId);
  if (isActive) {
    if (alerts.length) {
      const [next, ...rest] = alerts;
      await setConversation(ctx.q, personId, { step: 'alert_pickup', requestId: next.requestId, draft: null, alerts: rest }, ctx.now);
    } else {
      await clearConversation(ctx.q, personId);
    }
  } else if (alerts.length !== (cs.alerts || []).length) {
    await setConversation(ctx.q, personId, { step: cs.step, requestId: cs.requestId, draft: cs.draft, alerts }, ctx.now);
  }
}
/* Narrower than releasePickupState: releases only an urgent confirm_pickup (moot once the student
   has actually exited -- there is nothing left to confirm). A still-unanswered *alert_pickup* is
   deliberately left alone by markExit: "do you recognize this person" stays a meaningful question
   even after the fact, and answering NO late still needs to reach the titular's family and
   Recepción (L9) -- which cannot happen if the state was already wiped out from under them. */
export async function releaseConfirmState(ctx, personId, requestId) {
  const cs = await getConversation(ctx.q, personId, ctx);
  if (!cs || cs.step !== 'confirm_pickup' || cs.requestId !== requestId) return;
  const alerts = cs.alerts || [];
  if (alerts.length) {
    const [next, ...rest] = alerts;
    await setConversation(ctx.q, personId, { step: 'alert_pickup', requestId: next.requestId, draft: null, alerts: rest }, ctx.now);
  } else {
    await clearConversation(ctx.q, personId);
  }
}

export async function createRequest(ctx, data) {
  const st = await ctx.getStudent(data.studentId);
  if (!st) notFound('student_not_found');
  const by = await ctx.getPerson(data.requestedBy);
  if (!by) notFound('person_not_found');
  if (!isValidDate(data.date)) badRequest('invalid_date');
  const req = { id: uid('r'), kind: data.kind, studentId: st.id, requestedBy: by.id, date: data.date, reason: String(data.reason || ''), channel: data.channel === 'whatsapp' ? 'whatsapp' : 'web', status: 'pendiente', createdAt: ctx.now, autoApproved: false };
  if (req.kind === 'salida') {
    if (!isValidTime(data.time)) badRequest('invalid_time');
    req.time = data.time;
    const today = todayISO(ctx.now, ctx.tz);
    if (req.date < today) badRequest('date_in_past');
    if (req.date === today && req.time < nowHHMM(ctx.now, ctx.tz)) badRequest('time_in_past');
    req.pickupBy = data.pickupBy || by.id;
    const candidate = (await pickupCandidates(ctx, st.id, req.date)).find((c) => c.person.id === req.pickupBy);
    if (!candidate) badRequest('pickup_not_candidate');
    // A second active salida for the same student and date is not rejected (that broke the demo
    // script): it is simply never auto-approved -- see the dup check in evaluateAutoApprove.
    req.code = await uniqueCode(ctx, req.date);
    req.pickupKind = candidate.kind;
  } else if (req.kind === 'excusa') {
    req.excusaType = data.excusaType === 'tardanza' ? 'tardanza' : 'ausencia';
    req.attachmentId = data.attachmentId || null;
    req.attachmentName = data.attachmentName || null;
  } else badRequest('invalid_kind');
  await insertSalidaRequest(ctx, req);
  const ch = CHANNEL[req.channel];
  const others = st.titulares.filter((t) => t !== by.id);
  if (req.kind === 'salida') {
    const pk = await ctx.getPerson(req.pickupBy);
    await hist(ctx, req, 'Solicitud creada por ' + by.name + ' vía ' + ch);
    await logEvent(ctx, 'Solicitud de salida de ' + st.name + ' creada por ' + by.name + ' (' + ch + ')');
    for (const t of others) await notifyPerson(ctx, t, 'ℹ️ ' + by.name + ' solicitó salida de ' + st.name + ' ' + fmtDate(ctx, req.date) + ' a las ' + fmtTime(req.time) + '. Retira: ' + describePickup(req, pk) + '.');
    const ev = await evaluateAutoApprove(ctx, req, st);
    if (ev.ok) {
      /* `approveRequest` already re-reads and returns the hydrated, approved row -- reusing that
         instead of falling through to the `getRequest` below avoids a second, identical hydrate
         (main select + history + confirmations) for the same request (R2). */
      return approveRequest(ctx, req.id, { auto: true, pickupPoint: ctx.settings.defaultPickupPoint });
    } else {
      await hist(ctx, req, 'Pendiente de revisión: ' + ev.reason);
      await notifyPerson(ctx, by.id, '📝 Recibimos tu solicitud de salida de ' + st.name + ' ' + fmtDate(ctx, req.date) + ' a las ' + fmtTime(req.time) + '. Te avisamos en cuanto la escuela la apruebe.');
      await notifyRole(ctx, 'recepcion', 'Nueva solicitud de salida: ' + st.name + ' (' + st.grade + ') ' + fmtDate(ctx, req.date) + ' ' + fmtTime(req.time) + ' · ' + ev.reason);
      await notifyTeachers(ctx, st.id, 'Solicitud de salida pendiente: ' + st.name + ' ' + fmtTime(req.time));
    }
  } else {
    await hist(ctx, req, 'Excusa enviada por ' + by.name + ' vía ' + ch);
    await logEvent(ctx, 'Excusa (' + req.excusaType + ') de ' + st.name + ' enviada por ' + by.name + ' (' + ch + ')');
    await notifyPerson(ctx, by.id, '📝 Excusa recibida para ' + st.name + ' (' + req.excusaType + ' · ' + fmtDate(ctx, req.date) + '). Te avisamos cuando sea revisada.');
    for (const t of others) await notifyPerson(ctx, t, 'ℹ️ ' + by.name + ' envió una excusa de ' + req.excusaType + ' para ' + st.name + ' (' + fmtDate(ctx, req.date) + ').');
    await notifyRole(ctx, 'recepcion', 'Nueva excusa: ' + st.name + ' (' + st.grade + ') · ' + req.excusaType + ' ' + fmtDate(ctx, req.date));
    await notifyTeachers(ctx, st.id, 'Excusa de ' + req.excusaType + ' para ' + st.name + ' (' + fmtDate(ctx, req.date) + ')');
  }
  return getRequest(ctx.q, req.id);
}

export async function approveRequest(ctx, id, opts = {}) {
  const req = await loadSalida(ctx, id);
  if (req.kind !== 'salida' || req.status !== 'pendiente') conflict('request_not_pending');
  if (req.date < todayOf(ctx)) conflict('date_in_past');
  const st = await ctx.getStudent(req.studentId);
  const pk = await ctx.getPerson(req.pickupBy);
  if (!pk) conflict('pickup_person_missing');
  const el = await pickupEligibility(ctx, req.studentId, req.pickupBy, req.date);
  if (!el.ok) conflict('pickup_no_longer_eligible');
  const staff = opts.auto ? null : await getStaff(ctx.q, opts.by);
  const pickupPoint = opts.pickupPoint || ctx.settings.defaultPickupPoint;
  /* Recalculate pickupKind instead of trusting the value frozen at creation: eligibility may have
     changed (a new authorization, a revocation) between create_salida and this approval. */
  await patchRow(ctx.q, 'requests', id, { status: 'aprobada', pickupPoint, pickupKind: el.kind, decidedAt: ctx.now, autoApproved: !!opts.auto, decidedBy: opts.auto ? 'auto' : opts.by });
  const who = opts.auto ? 'Aprobada automáticamente (regla: titular, anticipación, autorizado vigente)' : 'Aprobada por ' + staff.name;
  await hist(ctx, req, who + ' · ' + pickupPoint);
  await logEvent(ctx, (opts.auto ? 'Auto-aprobó' : 'Aprobó') + ' salida de ' + st.name + ' · ' + pickupPoint, opts.auto ? 'Sistema' : staff.name);
  const needsConfirm = el.kind === 'una_vez';
  const msg = '✅ Salida aprobada: ' + st.name + ' ' + fmtDate(ctx, req.date) + ' a las ' + fmtTime(req.time) + '. Retira: ' + describePickup(req, pk) +
    '. Punto de retiro: ' + pickupPoint + '. Código: ' + req.code + '.' + (needsConfirm ? ' ⚠️ Te pediremos confirmar cuando la persona llegue a la garita.' : '');
  for (const t of st.titulares) await notifyPerson(ctx, t, msg);
  if (pk.hasAccount && !st.titulares.includes(pk.id)) {
    await notifyPerson(ctx, pk.id, '👋 Estás autorizado(a) para retirar a ' + st.name + ' ' + fmtDate(ctx, req.date) + ' a las ' + fmtTime(req.time) + ' por ' + pickupPoint + '. Presenta tu cédula. Código: ' + req.code + '.');
  }
  if (needsConfirm) await hist(ctx, req, 'Requiere confirmación del titular cuando la persona llegue a la garita');
  // Aviso proactivo: solo cuando retira una persona nueva o con autorización temporal / de una vez
  const ageDays = el.auth ? Math.floor((ctx.now.getTime() - el.auth.createdAt) / 86400000) : null;
  const unusual = el.kind === 'temporal' || el.kind === 'una_vez' || (el.auth && ageDays < ctx.settings.newAuthDays);
  if (unusual) {
    const why = el.kind === 'temporal' ? 'autorización por tiempo (' + el.auth.validFrom + ' → ' + el.auth.validTo + ')' : el.kind === 'una_vez' ? 'autorización de una sola vez' : 'autorización registrada hace ' + ageDays + ' día(s)';
    await hist(ctx, req, 'Aviso proactivo a los titulares: persona ' + (el.kind === 'siempre' ? 'nueva' : el.kind));
    for (const t of st.titulares) {
      await notifyPerson(ctx, t, '⚠️ AVISO: hoy retira a ' + firstName(st.name) + ' ' + pk.name + ' (' + pk.relation + ') con ' + why + '. Si no lo reconoces responde NO y se cancela la salida.', { buttons: ['Es correcto', 'NO'] });
      await queueAlert(ctx, t, req.id);
    }
  }
  await notifyRole(ctx, 'garita', 'Salida aprobada: ' + st.name + ' ' + fmtTime(req.time) + ' · retira ' + pk.name + ' · ' + pickupPoint);
  await notifyTeachers(ctx, st.id, 'Salida aprobada: ' + st.name + ' ' + fmtTime(req.time));
  return getRequest(ctx.q, id);
}

export async function rejectRequest(ctx, id, reason, byStaffId) {
  const req = await loadSalida(ctx, id);
  if (req.status !== 'pendiente') conflict('request_not_pending');
  const st = await ctx.getStudent(req.studentId);
  const staff = await getStaff(ctx.q, byStaffId);
  await patchRow(ctx.q, 'requests', id, { status: 'rechazada', decidedAt: ctx.now, decidedBy: byStaffId, rejectReason: reason });
  await hist(ctx, req, 'Rechazada por ' + staff.name + ': ' + reason);
  await logEvent(ctx, 'Rechazó ' + (req.kind === 'salida' ? 'salida' : 'excusa') + ' de ' + st.name + ': ' + reason, staff.name);
  const what = req.kind === 'salida' ? 'Salida de ' + st.name + ' ' + fmtDate(ctx, req.date) + ' ' + fmtTime(req.time) : 'Excusa de ' + st.name + ' (' + fmtDate(ctx, req.date) + ')';
  for (const t of st.titulares) {
    await notifyPerson(ctx, t, '❌ ' + what + ' no fue aprobada. Motivo: ' + reason + '. Contacta a recepción al ' + ctx.settings.school.phone + '.');
    await releasePickupState(ctx, t, id);
  }
  return getRequest(ctx.q, id);
}

export async function acceptExcusa(ctx, id, byStaffId) {
  const req = await loadSalida(ctx, id);
  if (req.kind !== 'excusa' || req.status !== 'pendiente') conflict('request_not_pending');
  const st = await ctx.getStudent(req.studentId);
  const staff = await getStaff(ctx.q, byStaffId);
  await patchRow(ctx.q, 'requests', id, { status: 'aceptada', decidedAt: ctx.now, decidedBy: byStaffId });
  await hist(ctx, req, 'Aceptada por ' + staff.name);
  await logEvent(ctx, 'Aceptó excusa de ' + st.name + ' (' + req.excusaType + ' ' + fmtDate(ctx, req.date) + ')', staff.name);
  for (const t of st.titulares) await notifyPerson(ctx, t, '✅ Excusa aceptada: ' + st.name + ' · ' + req.excusaType + ' ' + fmtDate(ctx, req.date) + '. Quedó registrada para su docente.');
  await notifyTeachers(ctx, st.id, 'Excusa aceptada: ' + st.name + ' · ' + req.excusaType + ' ' + fmtDate(ctx, req.date));
  return getRequest(ctx.q, id);
}

export async function cancelRequest(ctx, id, personId) {
  const req = await loadSalida(ctx, id);
  if (!['pendiente', 'aprobada'].includes(req.status)) conflict('request_not_cancellable');
  const st = await ctx.getStudent(req.studentId);
  const p = await ctx.getPerson(personId);
  await patchRow(ctx.q, 'requests', id, { status: 'cancelada' });
  await hist(ctx, req, 'Cancelada por ' + p.name);
  await logEvent(ctx, 'Canceló solicitud de ' + st.name, p.name);
  await notifyRole(ctx, 'recepcion', 'Solicitud cancelada por el padre: ' + st.name + ' ' + (req.time ? fmtTime(req.time) : fmtDate(ctx, req.date)));
  if (req.kind === 'salida') await notifyRole(ctx, 'garita', 'Salida cancelada: ' + st.name + ' ' + fmtTime(req.time));
  for (const t of st.titulares) await releasePickupState(ctx, t, id);
  if (req.pickupBy && !st.titulares.includes(req.pickupBy)) await releasePickupState(ctx, req.pickupBy, id);
  return getRequest(ctx.q, id);
}

/* ---------- staff: cancel a pendiente/aprobada salida or excusa (L15) ---------- */
export async function staffCancelRequest(ctx, id, reason, byStaffId) {
  const req = await loadSalida(ctx, id);
  if (!['pendiente', 'aprobada'].includes(req.status)) conflict('request_not_cancellable');
  const st = await ctx.getStudent(req.studentId);
  const staff = await getStaff(ctx.q, byStaffId);
  const wasApproved = req.status === 'aprobada';
  await patchRow(ctx.q, 'requests', id, { status: 'cancelada' });
  await hist(ctx, req, 'Cancelada por el personal (' + staff.name + '): ' + reason);
  await logEvent(ctx, 'Canceló ' + (req.kind === 'salida' ? 'salida' : 'excusa') + ' de ' + st.name + ': ' + reason, staff.name);
  const what = req.kind === 'salida' ? 'Salida de ' + st.name + ' ' + fmtDate(ctx, req.date) + (req.time ? ' ' + fmtTime(req.time) : '') : 'Excusa de ' + st.name + ' (' + fmtDate(ctx, req.date) + ')';
  for (const t of st.titulares) {
    await notifyPerson(ctx, t, '⛔ ' + what + ' fue cancelada por el personal. Motivo: ' + reason + '.');
    await releasePickupState(ctx, t, id);
  }
  if (wasApproved && req.pickupBy) {
    const pk = await ctx.getPerson(req.pickupBy);
    if (pk && pk.hasAccount && !st.titulares.includes(pk.id)) {
      await notifyPerson(ctx, pk.id, '⛔ La salida de ' + st.name + ' que ibas a retirar fue cancelada por el personal. Motivo: ' + reason + '.');
    }
  }
  if (req.pickupBy && !st.titulares.includes(req.pickupBy)) await releasePickupState(ctx, req.pickupBy, id);
  if (wasApproved) await notifyRole(ctx, 'garita', '⛔ Salida cancelada por el personal: ' + st.name + (req.time ? ' ' + fmtTime(req.time) : ''));
  return getRequest(ctx.q, id);
}

/* ---------- garita: confirmación una_vez y retiro (used by Task 7) ---------- */
export async function requestConfirmation(ctx, id, byStaffId) {
  const req = await loadSalida(ctx, id);
  if (req.kind !== 'salida' || req.status !== 'aprobada') conflict('request_not_approved');
  /* Use the current eligibility, not the pickupKind frozen at approval: it may have changed since
     (a revocation followed by a new una_vez authorization, for instance). */
  const current = await pickupEligibility(ctx, req.studentId, req.pickupBy, req.date);
  if (current.kind !== 'una_vez') conflict('confirmation_not_needed');
  const st = await ctx.getStudent(req.studentId);
  const pk = await ctx.getPerson(req.pickupBy);
  const staff = await getStaff(ctx.q, byStaffId);
  await upsertConfirmation(ctx.q, { requestId: id, status: 'pendiente', requestedByStaff: byStaffId, requestedAt: ctx.now, answeredByPerson: null, answeredAt: null });
  await hist(ctx, req, 'Garita solicitó confirmación a los titulares (' + pk.name + ' presente)');
  await logEvent(ctx, 'Solicitó confirmación de entrega de ' + st.name + ' a ' + pk.name, staff.name);
  for (const t of st.titulares) {
    await notifyPerson(ctx, t, '⚠️ ' + pk.name + ' (' + pk.relation + ') está en la garita para retirar a ' + st.name + '. Es una autorización de UNA SOLA VEZ. ¿Confirmas la entrega? Responde SÍ o NO.', { buttons: ['Sí, confirmo', 'No'] });
    /* An urgent, blocking step: it takes over the chat (the person is physically at the gate),
       overwriting any draft in progress -- but any proactive alert already queued for this titular
       stays queued instead of being dropped. */
    const cs = await getConversation(ctx.q, t, ctx);
    await setConversation(ctx.q, t, { step: 'confirm_pickup', requestId: id, draft: null, alerts: (cs && cs.alerts) || [] }, ctx.now);
  }
  return getRequest(ctx.q, id);
}

/* `confirm_pickup` only ever acts on a *pendiente* confirmation: once it has been answered (denied
   or confirmed), the answer stands until garita explicitly requests a new one (requestConfirmation),
   which is what actually reopens it -- L7. Without this, whichever answer lands last would win,
   including a stale "Sí" arriving after a titular already said "NO". */
export async function confirmPickup(ctx, id, personId, yes) {
  const req = await loadSalida(ctx, id);
  if (req.status !== 'aprobada') conflict('request_not_approved');
  const current = await pickupEligibility(ctx, req.studentId, req.pickupBy, req.date);
  if (current.kind !== 'una_vez') conflict('confirmation_not_needed');
  if (!req.confirmation || req.confirmation.status !== 'pendiente') {
    conflict(req.confirmation && req.confirmation.status === 'negada' ? 'pickup_denied' : 'confirmation_not_requested');
  }
  const st = await ctx.getStudent(req.studentId);
  const pk = await ctx.getPerson(req.pickupBy);
  const p = await ctx.getPerson(personId);
  await upsertConfirmation(ctx.q, { requestId: id, status: yes ? 'confirmada' : 'negada', requestedByStaff: null, requestedAt: null, answeredByPerson: personId, answeredAt: ctx.now });
  await hist(ctx, req, (yes ? 'Entrega confirmada' : 'Entrega NEGADA') + ' por ' + p.name);
  await logEvent(ctx, (yes ? 'Confirmó' : 'Negó') + ' la entrega de ' + st.name + ' a ' + pk.name, p.name);
  await notifyRole(ctx, 'garita', (yes ? '✅ Confirmado' : '⛔ NEGADO') + ' por ' + p.name + ': entrega de ' + st.name + ' a ' + pk.name);
  for (const t of st.titulares.filter((x) => x !== personId)) {
    await notifyPerson(ctx, t, (yes ? '✅ ' : '⛔ ') + p.name + (yes ? ' confirmó' : ' negó') + ' la entrega de ' + st.name + ' a ' + pk.name + '.');
    await releasePickupState(ctx, t, id);
  }
  await releasePickupState(ctx, personId, id);
  return getRequest(ctx.q, id);
}

export async function markExit(ctx, id, byStaffId) {
  const req = await loadSalida(ctx, id);
  if (req.kind !== 'salida' || req.status !== 'aprobada') conflict('request_not_approved');
  if (req.date !== todayOf(ctx)) throw new HttpError(409, 'not_today', 'Esta salida es del ' + fmtDate(ctx, req.date) + ', no se puede marcar el retiro hoy.');
  const st = await ctx.getStudent(req.studentId);
  const pk = await ctx.getPerson(req.pickupBy);
  const officer = await getStaff(ctx.q, byStaffId);
  const el = await pickupEligibility(ctx, req.studentId, req.pickupBy, req.date);
  if (!el.ok) throw new HttpError(409, 'pickup_not_authorized', pk.name + ' ya no tiene autorización vigente para ' + st.name + '.');
  if (el.kind === 'una_vez' && !(req.confirmation && req.confirmation.status === 'confirmada')) {
    throw new HttpError(409, 'confirmation_required', 'Autorización de una sola vez: primero solicita la confirmación del titular.');
  }
  await patchRow(ctx.q, 'requests', id, { status: 'retirado', exitAt: ctx.now, exitBy: byStaffId });
  if (el.auth && el.auth.type === 'una_vez') await patchRow(ctx.q, 'authorizations', el.auth.id, { usedAt: ctx.now });
  await hist(ctx, req, 'Retirado por ' + pk.name + ' · marcado en garita por ' + officer.name);
  await logEvent(ctx, 'Marcó retirado a ' + st.name + ' (' + pk.name + ')', officer.name);
  const hora = fmtTime(nowHHMM(ctx.now, ctx.tz));
  for (const t of st.titulares) {
    await notifyPerson(ctx, t, '🚪 ' + st.name + ' salió por ' + req.pickupPoint + ' a las ' + hora + ', retirado(a) por ' + describePickup(req, pk) + '. Confirmó ' + officer.name + ' (' + (officer.title || roleName(officer.role)) + ').');
    await releaseConfirmState(ctx, t, id);
  }
  if (pk.hasAccount && !st.titulares.includes(pk.id)) { await notifyPerson(ctx, pk.id, '🚪 Registramos que retiraste a ' + st.name + ' a las ' + hora + '. ¡Gracias!'); await releaseConfirmState(ctx, pk.id, id); }
  await notifyTeachers(ctx, st.id, st.name + ' salió a las ' + hora);
  return getRequest(ctx.q, id);
}
