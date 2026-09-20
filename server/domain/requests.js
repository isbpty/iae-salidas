import { uid } from './ids.js';
import { HttpError, notFound, conflict, badRequest } from './errors.js';
import { insertRequest, getRequest, patchRow, addRequestEvent, getStudent, getPerson, getStaff, listRequests, upsertConfirmation, setConversation, getConversation, clearConversation } from '../db/repo.js';
import { notifyPerson, notifyRole, notifyTeachers, logEvent } from './notifications.js';
import { pickupEligibility } from './eligibility.js';
import { evaluateAutoApprove } from './autoapprove.js';
import { fmtDate, fmtTime, firstName, CHANNEL, roleName } from './text.js';
import { nowHHMM } from './time.js';

export function describePickup(req, pk) {
  if (!pk) return '';
  return pk.name + (req.pickupBy === req.requestedBy ? ' (solicitante)' : ' (' + pk.relation + ')');
}
const hist = (ctx, req, text) => addRequestEvent(ctx.q, req.id, ctx.now, text);
async function uniqueCode(ctx, date) {
  const used = new Set((await listRequests(ctx.q, { date, kind: 'salida' })).map((r) => r.code));
  for (;;) { const c = String(1000 + Math.floor(Math.random() * 9000)); if (!used.has(c)) return c; }
}
async function loadSalida(ctx, id) {
  /* Lock the row for the rest of the transaction so two garita officers cannot both read
     `aprobada` and both write a transition. */
  await ctx.q.query('SELECT id FROM requests WHERE id=$1 FOR UPDATE', [id]);
  const req = await getRequest(ctx.q, id);
  if (!req) notFound('request_not_found');
  return req;
}

export async function createRequest(ctx, data) {
  const st = await getStudent(ctx.q, data.studentId);
  if (!st) notFound('student_not_found');
  const by = await getPerson(ctx.q, data.requestedBy);
  if (!by) notFound('person_not_found');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date || '')) badRequest('invalid_date');
  const req = { id: uid('r'), kind: data.kind, studentId: st.id, requestedBy: by.id, date: data.date, reason: String(data.reason || ''), channel: data.channel === 'whatsapp' ? 'whatsapp' : 'web', status: 'pendiente', createdAt: ctx.now, autoApproved: false };
  if (req.kind === 'salida') {
    if (!/^\d{2}:\d{2}$/.test(data.time || '')) badRequest('invalid_time');
    req.time = data.time;
    req.pickupBy = data.pickupBy || by.id;
    req.code = await uniqueCode(ctx, req.date);
    const el = await pickupEligibility(ctx, st.id, req.pickupBy);
    req.pickupKind = el.kind || 'no_autorizado';
  } else if (req.kind === 'excusa') {
    req.excusaType = data.excusaType === 'tardanza' ? 'tardanza' : 'ausencia';
    req.attachmentId = data.attachmentId || null;
    req.attachmentName = data.attachmentName || null;
  } else badRequest('invalid_kind');
  await insertRequest(ctx.q, req);
  const ch = CHANNEL[req.channel];
  const others = st.titulares.filter((t) => t !== by.id);
  if (req.kind === 'salida') {
    const pk = await getPerson(ctx.q, req.pickupBy);
    await hist(ctx, req, 'Solicitud creada por ' + by.name + ' vía ' + ch);
    await logEvent(ctx, 'Solicitud de salida de ' + st.name + ' creada por ' + by.name + ' (' + ch + ')');
    for (const t of others) await notifyPerson(ctx, t, 'ℹ️ ' + by.name + ' solicitó salida de ' + st.name + ' ' + fmtDate(ctx, req.date) + ' a las ' + fmtTime(req.time) + '. Retira: ' + describePickup(req, pk) + '.');
    const ev = await evaluateAutoApprove(ctx, req, st);
    if (ev.ok) {
      await approveRequest(ctx, req.id, { auto: true, pickupPoint: ctx.settings.defaultPickupPoint });
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
  const st = await getStudent(ctx.q, req.studentId);
  const pk = await getPerson(ctx.q, req.pickupBy);
  const staff = opts.auto ? null : await getStaff(ctx.q, opts.by);
  const pickupPoint = opts.pickupPoint || ctx.settings.defaultPickupPoint;
  await patchRow(ctx.q, 'requests', id, { status: 'aprobada', pickupPoint, decidedAt: ctx.now, autoApproved: !!opts.auto, decidedBy: opts.auto ? 'auto' : opts.by });
  const who = opts.auto ? 'Aprobada automáticamente (regla: titular, anticipación, autorizado vigente)' : 'Aprobada por ' + staff.name;
  await hist(ctx, req, who + ' · ' + pickupPoint);
  await logEvent(ctx, (opts.auto ? 'Auto-aprobó' : 'Aprobó') + ' salida de ' + st.name + ' · ' + pickupPoint, opts.auto ? 'Sistema' : staff.name);
  const needsConfirm = req.pickupKind === 'una_vez';
  const msg = '✅ Salida aprobada: ' + st.name + ' ' + fmtDate(ctx, req.date) + ' a las ' + fmtTime(req.time) + '. Retira: ' + describePickup(req, pk) +
    '. Punto de retiro: ' + pickupPoint + '. Código: ' + req.code + '.' + (needsConfirm ? ' ⚠️ Te pediremos confirmar cuando la persona llegue a la garita.' : '');
  for (const t of st.titulares) await notifyPerson(ctx, t, msg);
  if (pk.hasAccount && !st.titulares.includes(pk.id)) {
    await notifyPerson(ctx, pk.id, '👋 Estás autorizado(a) para retirar a ' + st.name + ' ' + fmtDate(ctx, req.date) + ' a las ' + fmtTime(req.time) + ' por ' + pickupPoint + '. Presenta tu cédula. Código: ' + req.code + '.');
  }
  if (needsConfirm) await hist(ctx, req, 'Requiere confirmación del titular cuando la persona llegue a la garita');
  // Aviso proactivo: solo cuando retira una persona nueva o con autorización temporal / de una vez
  const el = await pickupEligibility(ctx, req.studentId, req.pickupBy);
  const ageDays = el.auth ? Math.floor((ctx.now.getTime() - el.auth.createdAt) / 86400000) : null;
  const unusual = el.kind === 'temporal' || el.kind === 'una_vez' || (el.auth && ageDays < ctx.settings.newAuthDays);
  if (unusual) {
    const why = el.kind === 'temporal' ? 'autorización por tiempo (' + el.auth.validFrom + ' → ' + el.auth.validTo + ')' : el.kind === 'una_vez' ? 'autorización de una sola vez' : 'autorización registrada hace ' + ageDays + ' día(s)';
    await hist(ctx, req, 'Aviso proactivo a los titulares: persona ' + (el.kind === 'siempre' ? 'nueva' : el.kind));
    for (const t of st.titulares) {
      await notifyPerson(ctx, t, '⚠️ AVISO: hoy retira a ' + firstName(st.name) + ' ' + pk.name + ' (' + pk.relation + ') con ' + why + '. Si no lo reconoces responde NO y se cancela la salida.', { buttons: ['Es correcto', 'NO'] });
      await setConversation(ctx.q, t, { step: 'alert_pickup', requestId: req.id }, ctx.now);
    }
  }
  await notifyRole(ctx, 'garita', 'Salida aprobada: ' + st.name + ' ' + fmtTime(req.time) + ' · retira ' + pk.name + ' · ' + pickupPoint);
  await notifyTeachers(ctx, st.id, 'Salida aprobada: ' + st.name + ' ' + fmtTime(req.time));
  return getRequest(ctx.q, id);
}

export async function rejectRequest(ctx, id, reason, byStaffId) {
  const req = await loadSalida(ctx, id);
  if (req.status !== 'pendiente') conflict('request_not_pending');
  const st = await getStudent(ctx.q, req.studentId);
  const staff = await getStaff(ctx.q, byStaffId);
  await patchRow(ctx.q, 'requests', id, { status: 'rechazada', decidedAt: ctx.now, decidedBy: byStaffId, rejectReason: reason });
  await hist(ctx, req, 'Rechazada por ' + staff.name + ': ' + reason);
  await logEvent(ctx, 'Rechazó ' + (req.kind === 'salida' ? 'salida' : 'excusa') + ' de ' + st.name + ': ' + reason, staff.name);
  const what = req.kind === 'salida' ? 'Salida de ' + st.name + ' ' + fmtDate(ctx, req.date) + ' ' + fmtTime(req.time) : 'Excusa de ' + st.name + ' (' + fmtDate(ctx, req.date) + ')';
  for (const t of st.titulares) await notifyPerson(ctx, t, '❌ ' + what + ' no fue aprobada. Motivo: ' + reason + '. Contacta a recepción al ' + ctx.settings.school.phone + '.');
  return getRequest(ctx.q, id);
}

export async function acceptExcusa(ctx, id, byStaffId) {
  const req = await loadSalida(ctx, id);
  if (req.kind !== 'excusa' || req.status !== 'pendiente') conflict('request_not_pending');
  const st = await getStudent(ctx.q, req.studentId);
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
  const st = await getStudent(ctx.q, req.studentId);
  const p = await getPerson(ctx.q, personId);
  await patchRow(ctx.q, 'requests', id, { status: 'cancelada' });
  await hist(ctx, req, 'Cancelada por ' + p.name);
  await logEvent(ctx, 'Canceló solicitud de ' + st.name, p.name);
  await notifyRole(ctx, 'recepcion', 'Solicitud cancelada por el padre: ' + st.name + ' ' + (req.time ? fmtTime(req.time) : fmtDate(ctx, req.date)));
  if (req.kind === 'salida') await notifyRole(ctx, 'garita', 'Salida cancelada: ' + st.name + ' ' + fmtTime(req.time));
  return getRequest(ctx.q, id);
}

/* ---------- garita: confirmación una_vez y retiro (used by Task 7) ---------- */
export async function requestConfirmation(ctx, id, byStaffId) {
  const req = await loadSalida(ctx, id);
  if (req.kind !== 'salida' || req.status !== 'aprobada') conflict('request_not_approved');
  if (req.pickupKind !== 'una_vez') conflict('confirmation_not_needed');
  const st = await getStudent(ctx.q, req.studentId);
  const pk = await getPerson(ctx.q, req.pickupBy);
  const staff = await getStaff(ctx.q, byStaffId);
  await upsertConfirmation(ctx.q, { requestId: id, status: 'pendiente', requestedByStaff: byStaffId, requestedAt: ctx.now, answeredByPerson: null, answeredAt: null });
  await hist(ctx, req, 'Garita solicitó confirmación a los titulares (' + pk.name + ' presente)');
  await logEvent(ctx, 'Solicitó confirmación de entrega de ' + st.name + ' a ' + pk.name, staff.name);
  for (const t of st.titulares) {
    await notifyPerson(ctx, t, '⚠️ ' + pk.name + ' (' + pk.relation + ') está en la garita para retirar a ' + st.name + '. Es una autorización de UNA SOLA VEZ. ¿Confirmas la entrega? Responde SÍ o NO.', { buttons: ['Sí, confirmo', 'No'] });
    await setConversation(ctx.q, t, { step: 'confirm_pickup', requestId: id }, ctx.now);
  }
  return getRequest(ctx.q, id);
}

export async function confirmPickup(ctx, id, personId, yes) {
  const req = await loadSalida(ctx, id);
  if (req.status !== 'aprobada') conflict('request_not_approved');
  const st = await getStudent(ctx.q, req.studentId);
  const pk = await getPerson(ctx.q, req.pickupBy);
  const p = await getPerson(ctx.q, personId);
  await upsertConfirmation(ctx.q, { requestId: id, status: yes ? 'confirmada' : 'negada', requestedByStaff: null, requestedAt: null, answeredByPerson: personId, answeredAt: ctx.now });
  await hist(ctx, req, (yes ? 'Entrega confirmada' : 'Entrega NEGADA') + ' por ' + p.name);
  await logEvent(ctx, (yes ? 'Confirmó' : 'Negó') + ' la entrega de ' + st.name + ' a ' + pk.name, p.name);
  await notifyRole(ctx, 'garita', (yes ? '✅ Confirmado' : '⛔ NEGADO') + ' por ' + p.name + ': entrega de ' + st.name + ' a ' + pk.name);
  for (const t of st.titulares.filter((x) => x !== personId)) {
    await notifyPerson(ctx, t, (yes ? '✅ ' : '⛔ ') + p.name + (yes ? ' confirmó' : ' negó') + ' la entrega de ' + st.name + ' a ' + pk.name + '.');
    const cs = await getConversation(ctx.q, t);
    if (cs && cs.step === 'confirm_pickup') await clearConversation(ctx.q, t);
  }
  await clearConversation(ctx.q, personId);
  return getRequest(ctx.q, id);
}

export async function markExit(ctx, id, byStaffId) {
  const req = await loadSalida(ctx, id);
  if (req.kind !== 'salida' || req.status !== 'aprobada') conflict('request_not_approved');
  const st = await getStudent(ctx.q, req.studentId);
  const pk = await getPerson(ctx.q, req.pickupBy);
  const officer = await getStaff(ctx.q, byStaffId);
  const el = await pickupEligibility(ctx, req.studentId, req.pickupBy);
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
    const cs = await getConversation(ctx.q, t);
    if (cs && cs.step === 'alert_pickup') await clearConversation(ctx.q, t);
  }
  if (pk.hasAccount && !st.titulares.includes(pk.id)) await notifyPerson(ctx, pk.id, '🚪 Registramos que retiraste a ' + st.name + ' a las ' + hora + '. ¡Gracias!');
  await notifyTeachers(ctx, st.id, st.name + ' salió a las ' + hora);
  return getRequest(ctx.q, id);
}
