import { normalize, parseTime, parseDate, matchKid, extractPickupHint, detectIntent, REL_WORDS } from './nlp.js';
import { getPerson, getStudent, getRequest, insertChat, getConversation, setConversation, listRequests, getRoute, getStaff } from '../db/repo.js';
import { studentsOf, authorizedFor, pickupCandidates, pickupEligibility } from '../domain/eligibility.js';
import { createRequest, cancelRequest, confirmPickup, advanceAlert } from '../domain/requests.js';
import { whereIs, markNoBus } from '../domain/bus.js';
import { notifyPerson, notifyRole, logEvent } from '../domain/notifications.js';
import { addRequestEvent } from '../db/repo.js';
import { fmtDate, fmtTime, fmtClock, firstName, STATUS, LEG_NAMES } from '../domain/text.js';
import { todayISO, shiftISO } from '../domain/time.js';
import { HttpError } from '../domain/errors.js';

/* Friendly Spanish replies for the validation errors `createRequest` can throw. The bot already steers
   the conversation away from most of these (it only offers times/candidates it considers valid), but a
   draft can go stale between messages (e.g. an authorization gets revoked while the parent is still
   typing), so `createRequest` can still reject it. Without this, the error would bubble out of
   `handleIncoming` as a bare command failure instead of a chat message. */
const CREATE_REQUEST_ERRORS = {
  date_in_past: 'Esa fecha ya pasó. Escríbeme de nuevo con una fecha desde hoy en adelante.',
  time_in_past: 'Esa hora ya pasó hoy. Escríbeme de nuevo con una hora que no haya pasado.',
  invalid_date: 'No reconocí esa fecha. Intenta de nuevo, por ejemplo "mañana" o "25/09".',
  invalid_time: 'No reconocí esa hora. Intenta de nuevo, por ejemplo "3:30 pm".',
  pickup_not_candidate: 'Esa persona ya no aparece como autorizada para retirar. Regístrala en la app o elige a alguien más.',
};

const reply = (ctx, key, text, buttons = null, extra = {}) => ctx.transport.send(ctx, key, { text, buttons, location: extra.location || null, typing: true });
/* Every draft-progression step (ask_child, ask_time, ...) goes through here. It must never drop a
   proactive alert queued behind the draft (L9), so unless the caller explicitly sets `alerts` it is
   carried over from whatever is already stored for this chat. */
async function setState(ctx, key, state) {
  const alerts = state.alerts !== undefined ? state.alerts : ((await getConversation(ctx.q, key, ctx)) || {}).alerts || [];
  return setConversation(ctx.q, key, { ...state, alerts }, ctx.now);
}

function botMenu(ctx, p, kids) {
  const k = firstName(kids[0].name);
  return 'Hola ' + firstName(p.name) + ' 👋 Soy el asistente de ' + ctx.settings.school.short + ' Salidas.\n\nPuedo ayudarte con:\n1️⃣ Salida temprana: "Necesito retirar a ' + k + ' hoy a las 3:30 pm"\n2️⃣ Alguien más retira: "A ' + k + ' lo retira la abuela a las 2 pm"\n3️⃣ Excusa: "' + k + ' no irá mañana, tiene cita médica"\n4️⃣ Ubicación: "¿Dónde está ' + k + '?"\n5️⃣ Bus: "' + k + ' hoy no va en el bus"\n6️⃣ Escribe *estado* para ver tus solicitudes.';
}
/* Scores each candidate by how many hint words match their name (nombre+apellido outranks a lone
   apellido, L14): a hint like "Carmen Gómez" used to grab "Laura Gómez" just because they share a
   surname (`.some()` over any word, first hit wins). A full-name match is required before a
   multi-word hint resolves automatically; a lone surname is only trusted when that's literally all
   the hint offered (one word). A tie at the best score (several candidates matching equally well)
   returns null so the caller asks instead of guessing. */
async function resolvePickup(ctx, hint, studentId, requesterId, date) {
  if (!hint || hint === 'yo') return requesterId;
  const cands = await pickupCandidates(ctx, studentId, date);
  const words = hint.split(' ').filter((w) => w.length > 2);
  if (words.length) {
    const scored = cands
      .map((c) => ({ c, matched: words.filter((w) => normalize(c.person.name).split(' ').includes(w)).length }))
      .filter((x) => x.matched > 0);
    if (scored.length) {
      const top = Math.max(...scored.map((x) => x.matched));
      const full = top === words.length; // matched every word in the hint (nombre + apellido)
      if (full || words.length === 1) {
        const best = scored.filter((x) => x.matched === top);
        return best.length === 1 ? best[0].c.person.id : null; // tie: ask instead of guessing
      }
      // A multi-word hint with only a partial (surname-only) match is too weak to guess -- fall
      // through to the relation-word check below instead of picking the wrong person.
    }
  }
  const hit = cands.find((c) => words.some((w) => REL_WORDS[w] && normalize(c.person.relation) === normalize(REL_WORDS[w])));
  return hit ? hit.person.id : null;
}
const candidateLabels = (cands, p) => cands.map((c) => (c.person.id === p.id ? 'Yo' : firstName(c.person.name) + ' (' + c.person.relation + ')'));
async function statusSummary(ctx, p) {
  const kids = (await studentsOf(ctx, p.id)).map((k) => k.id);
  const list = (await listRequests(ctx.q, { studentIds: kids })).filter((r) => r.date >= shiftISO(ctx.now, ctx.tz, -1)).slice(0, 5);
  if (!list.length) return 'No tienes solicitudes recientes.';
  const lines = [];
  for (const r of list) {
    const st = await getStudent(ctx.q, r.studentId);
    const what = r.kind === 'salida' ? 'Salida ' + fmtDate(ctx, r.date) + ' ' + fmtTime(r.time) : 'Excusa ' + r.excusaType + ' ' + fmtDate(ctx, r.date);
    lines.push('• ' + firstName(st.name) + ' · ' + what + ' · ' + STATUS[r.status] + (r.pickupPoint && r.status === 'aprobada' ? ' (' + r.pickupPoint + ', código ' + r.code + ')' : ''));
  }
  return 'Tus solicitudes recientes:\n' + lines.join('\n');
}

export async function handleIncoming(ctx, key, text) {
  await insertChat(ctx.q, { chatKey: key, direction: 'in', text }, ctx.now);
  const p = key === 'unknown' ? null : await getPerson(ctx.q, key);
  if (!p || !p.hasAccount) {
    return reply(ctx, key, 'Hola 👋 Este número no está registrado en ' + ctx.settings.school.short + ' Salidas. Si eres padre o madre, regístrate en la app de padres o escribe a recepción al ' + ctx.settings.school.phone + '.');
  }
  const kids = await studentsOf(ctx, p.id);
  const n = normalize(text);
  const conv = await getConversation(ctx.q, key, ctx);
  if (conv && conv.step) return handleStep(ctx, key, p, kids, conv, n, text);
  if (!kids.length) {
    const auths = await authorizedFor(ctx, p.id);
    return reply(ctx, key, 'Hola ' + firstName(p.name) + '. No tienes hijos registrados como titular.' + (auths.length ? ' Estás autorizado(a) para retirar a: ' + auths.map((a) => a.student.name).join(', ') + '. Las solicitudes las crean los padres titulares.' : ''));
  }
  return dispatch(ctx, key, p, kids, n, text);
}
async function dispatch(ctx, key, p, kids, n, text) {
  const intent = detectIntent(n);
  if (intent === 'saludo') return reply(ctx, key, botMenu(ctx, p, kids));
  if (intent === 'estado') return reply(ctx, key, await statusSummary(ctx, p));
  if (intent === 'cancelar') return reply(ctx, key, 'No hay nada en proceso. ' + botMenu(ctx, p, kids));
  if (intent === 'nobus') return startNoBus(ctx, key, p, kids, n);
  if (intent === 'donde') return startDonde(ctx, key, p, kids, n);
  if (intent === 'salida') return startSalida(ctx, key, p, kids, n, text);
  if (intent === 'excusa') return startExcusa(ctx, key, p, kids, n, text);
  return reply(ctx, key, 'No te entendí 🤔\n\n' + botMenu(ctx, p, kids));
}

async function startSalida(ctx, key, p, kids, n, raw) {
  const draft = { kind: 'salida', requestedBy: p.id, channel: 'whatsapp', studentId: matchKid(n, kids), date: parseDate(n, ctx), time: parseTime(n), pickupHint: extractPickupHint(n), reason: raw };
  return continueSalida(ctx, key, p, kids, { step: 'salida', draft });
}
async function continueSalida(ctx, key, p, kids, conv) {
  const d = conv.draft;
  if (!d.studentId) { await setState(ctx, key, { step: 'ask_child', draft: d }); return reply(ctx, key, '¿A cuál de tus hijos? ', kids.map((k) => firstName(k.name))); }
  const kid = await getStudent(ctx.q, d.studentId);
  if (!d.time) { await setState(ctx, key, { step: 'ask_time', draft: d }); return reply(ctx, key, '¿A qué hora necesitas que ' + firstName(kid.name) + ' salga ' + fmtDate(ctx, d.date) + '? (ej. 3:30 pm)'); }
  if (d.pickupBy === undefined || d.pickupBy === null) {
    const pid = await resolvePickup(ctx, d.pickupHint, d.studentId, p.id, d.date);
    if (!pid) {
      await setState(ctx, key, { step: 'ask_pickup', draft: d });
      return reply(ctx, key, '"' + d.pickupHint + '" no aparece como persona autorizada para ' + firstName(kid.name) + '. Puedes registrarla en la app. ¿Quién va a retirar?', candidateLabels(await pickupCandidates(ctx, d.studentId, d.date), p));
    }
    d.pickupBy = pid;
  }
  await setState(ctx, key, { step: 'confirm', draft: d });
  const pk = await getPerson(ctx.q, d.pickupBy);
  const el = await pickupEligibility(ctx, d.studentId, d.pickupBy, d.date);
  return reply(ctx, key, '📋 Confirma la solicitud:\n• Estudiante: ' + kid.name + ' (' + kid.grade + ')\n• Fecha: ' + fmtDate(ctx, d.date) + '\n• Hora: ' + fmtTime(d.time) + '\n• Retira: ' + (pk.id === p.id ? 'tú' : pk.name + ' (' + pk.relation + ')') + (el.kind === 'una_vez' ? ' · autorización de una sola vez' : '') + '\n\n¿Es correcto?', ['Sí', 'No']);
}
async function startExcusa(ctx, key, p, kids, n, raw) {
  const draft = { kind: 'excusa', requestedBy: p.id, channel: 'whatsapp', studentId: matchKid(n, kids), date: parseDate(n, ctx), excusaType: /tard/.test(n) ? 'tardanza' : 'ausencia', reason: raw };
  return continueExcusa(ctx, key, p, kids, { step: 'excusa', draft });
}
async function continueExcusa(ctx, key, p, kids, conv) {
  const d = conv.draft;
  if (!d.studentId) { await setState(ctx, key, { step: 'ask_child', draft: d }); return reply(ctx, key, '¿Para cuál de tus hijos es la excusa?', kids.map((k) => firstName(k.name))); }
  const kid = await getStudent(ctx.q, d.studentId);
  await setState(ctx, key, { step: 'confirm', draft: d });
  return reply(ctx, key, '📋 Confirma la excusa:\n• Estudiante: ' + kid.name + ' (' + kid.grade + ')\n• Tipo: ' + d.excusaType + '\n• Fecha: ' + fmtDate(ctx, d.date) + '\n• Motivo: ' + d.reason + (d.attachment ? '\n• Adjunto: ' + d.attachment : '\n\nPuedes adjuntar el certificado con 📎 antes de confirmar.') + '\n\n¿Es correcto?', ['Sí', 'No', '📎 Adjuntar certificado']);
}
async function startDonde(ctx, key, p, kids, n) {
  const sid = matchKid(n, kids);
  if (!sid) { await setState(ctx, key, { step: 'ask_child', draft: { kind: 'donde' } }); return reply(ctx, key, '¿De cuál de tus hijos quieres saber?', kids.map((k) => firstName(k.name))); }
  return finishDonde(ctx, key, p, sid);
}
async function finishDonde(ctx, key, p, sid) {
  const w = await whereIs(ctx, sid);
  await logEvent(ctx, 'Consultó la ubicación de ' + (await getStudent(ctx.q, sid)).name + ' por WhatsApp', p.name);
  return reply(ctx, key, w.text, null, w.location ? { location: w.location } : {});
}
async function startNoBus(ctx, key, p, kids, n) {
  // "mañana" is ambiguous ("tomorrow" vs "in the morning") -- leg comes only from explicit "ida" or a
  // "de/en la mañana" time-of-day phrase, never from a bare "mañana" (that's the date, via parseDate,
  // fixed for this same ambiguity in nlp.js). Otherwise "Joseph mañana no va en el bus" used to be
  // read as the ida leg of *today* instead of both legs of tomorrow (L12).
  const morning = /\bida\b/.test(n) || /\b(en|de)\s+la\s+manana\b/.test(n);
  const afternoon = /tarde|vuelta|regreso/.test(n);
  const legs = morning && !afternoon ? ['ida'] : afternoon && !morning ? ['vuelta'] : ['ida', 'vuelta'];
  const date = parseDate(n, ctx);
  const sid = matchKid(n, kids);
  if (!sid) { await setState(ctx, key, { step: 'ask_child', draft: { kind: 'nobus', legs, date } }); return reply(ctx, key, '¿Cuál de tus hijos no va en el bus?', kids.map((k) => firstName(k.name))); }
  return finishNoBus(ctx, key, p, { studentId: sid, legs, date });
}
async function finishNoBus(ctx, key, p, d) {
  const st = await getStudent(ctx.q, d.studentId);
  if (!st.routeId) return reply(ctx, key, firstName(st.name) + ' no tiene ruta de bus registrada. Puedes asignarla en la app.');
  const date = d.date || todayISO(ctx.now, ctx.tz);
  const { route: r, alreadyRegistered } = await markNoBus(ctx, d.studentId, p.id, d.legs, date);
  const when = fmtDate(ctx, date);
  const legsTxt = d.legs.map((l) => LEG_NAMES[l]).join(' y ');
  if (alreadyRegistered) return reply(ctx, key, 'Ya tenía registrado que ' + firstName(st.name) + ' ' + when + ' no va en el ' + r.name + ' (' + legsTxt + ').');
  // A route with no monitora assigned used to crash here (getStaff(null).name, 500, L12) -- Recepción
  // is notified instead so the family still gets confirmation the opt-out was registered.
  const who = r.monitorId ? 'Avisé a la monitora ' + (await getStaff(ctx.q, r.monitorId)).name : 'Avisé a Recepción (la ruta no tiene monitora asignada)';
  return reply(ctx, key, '🚌 Listo. ' + who + ' que ' + firstName(st.name) + ' ' + when + ' no va en el ' + r.name + ' (' + legsTxt + ').');
}

/* Ends the current interactive step. If the titular has a proactive alert queued behind it (L9: a
   draft, an urgent confirm_pickup, or an earlier alert never overwrites a later one), that alert
   surfaces next; otherwise the conversation goes idle. Prefer this over clearState whenever a step
   concludes normally, so a queued alert is never silently dropped. */
const finishStep = (ctx, key) => advanceAlert(ctx, key);

async function continueDraft(ctx, key, p, kids, conv) {
  const d = conv.draft;
  if (d && d.kind === 'excusa') return continueExcusa(ctx, key, p, kids, conv);
  if (d && d.kind === 'donde') { await finishStep(ctx, key); return finishDonde(ctx, key, p, d.studentId); }
  if (d && d.kind === 'nobus') { await finishStep(ctx, key); return finishNoBus(ctx, key, p, d); }
  return continueSalida(ctx, key, p, kids, conv);
}

/* A proactive "does this look right?" notice (L9). Unlike confirm_pickup it is never urgent enough
   to interrupt a draft (see queueAlert in domain/requests.js), so by the time this runs there is
   never a draft to protect -- just this alert, possibly with more queued behind it. */
async function handleAlertPickup(ctx, key, p, kids, conv, n) {
  const req = await getRequest(ctx.q, conv.requestId);
  if (!req || !['aprobada', 'pendiente', 'retirado'].includes(req.status)) {
    await finishStep(ctx, key);
    return reply(ctx, key, 'Esa salida ya fue cancelada.\n\n' + botMenu(ctx, p, kids));
  }
  const kid = await getStudent(ctx.q, req.studentId);
  const pk = await getPerson(ctx.q, req.pickupBy);
  if (/^(no|n)\b/.test(n)) {
    if (req.status === 'retirado') {
      /* Late NO: the student already left through the gate. Nothing to cancel any more -- point
         the titular to Recepción and make sure the school hears about the mismatch too. */
      const hora = fmtClock(ctx, req.exitAt);
      await notifyRole(ctx, 'recepcion', '⚠️ ' + p.name + ' dice que NO reconoce a ' + pk.name + ', pero ' + firstName(kid.name) + ' ya salió con esa persona a las ' + hora + '. Contactar a la familia.');
      await finishStep(ctx, key);
      return reply(ctx, key, '🚪 ' + firstName(kid.name) + ' ya salió a las ' + hora + ' con ' + pk.name + '; llama a recepción al ' + ctx.settings.school.phone + '.');
    }
    await cancelRequest(ctx, req.id, p.id);
    await addRequestEvent(ctx.q, req.id, ctx.now, 'Cancelada: el titular NO reconoció a la persona que retira');
    await notifyRole(ctx, 'garita', '⛔ ' + p.name + ' NO reconoce a ' + pk.name + ' · salida de ' + kid.name + ' CANCELADA');
    for (const t of kid.titulares.filter((x) => x !== p.id)) {
      await notifyPerson(ctx, t, '⛔ ' + p.name + ' no reconoció a ' + pk.name + '; la salida de ' + firstName(kid.name) + ' fue cancelada.');
    }
    // cancelRequest already released (and, if queued, advanced) this titular's own chat state.
    return reply(ctx, key, '⛔ Cancelé la salida y avisé a la garita. Recepción te contactará al ' + ctx.settings.school.phone + '.');
  }
  if (/correcto|^(si|sí|s|ok|dale)\b|conozco|reconozco/.test(n)) {
    await finishStep(ctx, key);
    return reply(ctx, key, '👍 Gracias, queda confirmado. Te aviso cuando ' + firstName(kid.name) + ' salga.');
  }
  // Unrecognized text must repeat the question, never silently drop the alert (L9).
  return reply(ctx, key, '¿Reconoces a ' + pk.name + ' (' + pk.relation + ') retirando a ' + firstName(kid.name) + '? Responde "Es correcto" o "NO".', ['Es correcto', 'NO']);
}

async function handleConfirmPickup(ctx, key, p, kids, conv, n) {
  const req = await getRequest(ctx.q, conv.requestId);
  if (!req || req.status !== 'aprobada') {
    // The request stopped needing an answer through another channel (L8): explain, don't crash.
    await finishStep(ctx, key);
    return reply(ctx, key, 'Esa salida ya fue cancelada o retirada.\n\n' + botMenu(ctx, p, kids));
  }
  const answer = async (yes) => {
    try {
      await confirmPickup(ctx, req.id, p.id, yes);
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) {
        await finishStep(ctx, key);
        return reply(ctx, key, 'Esa confirmación ya no está disponible' + (e.code === 'pickup_denied' ? ': ya se había negado antes' : '') + '. Si hace falta, pide a garita que la vuelva a solicitar.');
      }
      throw e;
    }
    return yes
      ? reply(ctx, key, '✅ Gracias, confirmaste la entrega. Te avisamos cuando ' + firstName((await getStudent(ctx.q, req.studentId)).name) + ' salga.')
      : reply(ctx, key, '⛔ Entendido, NO se entregará al estudiante. La garita fue notificada.');
  };
  if (/^(si|sí|s|yes|confirmo|si, confirmo|ok|dale)\b/.test(n)) return answer(true);
  if (/^(no|n)\b/.test(n)) return answer(false);
  return reply(ctx, key, 'Responde SÍ para confirmar o NO para negar la entrega.', ['Sí, confirmo', 'No']);
}

async function handleAskChild(ctx, key, p, kids, conv, n) {
  const d = conv.draft;
  const kid = kids.find((k) => new RegExp('\\b' + normalize(firstName(k.name)) + '\\b').test(n));
  if (!kid) return reply(ctx, key, 'No reconocí el nombre. Elige uno:', kids.map((k) => firstName(k.name)));
  d.studentId = kid.id;
  return continueDraft(ctx, key, p, kids, conv);
}
async function handleAskTime(ctx, key, p, kids, conv, n) {
  const d = conv.draft;
  const t = parseTime(n);
  if (!t) return reply(ctx, key, 'No entendí la hora. Escríbela como 3:30 pm o 15:30.');
  d.time = t;
  const nd = parseDate(n, ctx);
  if (nd !== todayISO(ctx.now, ctx.tz)) d.date = nd;
  return continueDraft(ctx, key, p, kids, conv);
}
async function handleAskPickup(ctx, key, p, kids, conv, n) {
  const d = conv.draft;
  if (/^(no|nadie|ninguno|ninguna)\b/.test(n)) { await finishStep(ctx, key); return reply(ctx, key, 'Ok, descarté la solicitud. Registra a la persona en la app y vuelve a escribirme.'); }
  const hint = /^yo\b/.test(n) ? 'yo' : n.replace(/\(.*\)/, '').trim();
  const pid = await resolvePickup(ctx, hint, d.studentId, p.id, d.date);
  if (!pid) return reply(ctx, key, 'Esa persona no está autorizada. Elige una de la lista o regístrala en la app.', candidateLabels(await pickupCandidates(ctx, d.studentId, d.date), p));
  d.pickupBy = pid;
  return continueDraft(ctx, key, p, kids, conv);
}
async function handleConfirmDraft(ctx, key, p, kids, conv, n) {
  const d = conv.draft;
  if (/adjunt|certificado|📎/.test(n)) { d.attachment = 'certificado_medico.jpg'; await reply(ctx, key, '📎 Recibí certificado_medico.jpg ✅'); return continueDraft(ctx, key, p, kids, conv); }
  if (/^(si|sí|s|yes|correcto|ok|dale|confirmo)\b/.test(n)) {
    await finishStep(ctx, key);
    const { pickupHint, attachment, ...data } = d;
    try {
      await createRequest(ctx, { ...data, attachmentName: attachment || null });
    } catch (e) {
      if (e instanceof HttpError && e.status === 400) {
        return reply(ctx, key, '⚠️ ' + (CREATE_REQUEST_ERRORS[e.code] || 'No pude crear la solicitud, intenta de nuevo.') + '\n\n' + botMenu(ctx, p, kids));
      }
      throw e;
    }
    return;
  }
  if (/^(no|n)\b/.test(n)) { await finishStep(ctx, key); return reply(ctx, key, 'Ok, la descarté. Escríbeme de nuevo con los datos correctos, por ejemplo: "Necesito retirar a ' + firstName(kids[0].name) + ' hoy a las 3:30 pm".'); }
  return reply(ctx, key, 'Responde Sí para enviar o No para descartar.', ['Sí', 'No']);
}

/* One small handler per step (C8) instead of a long if-chain over conv.step. */
const STEP_HANDLERS = {
  alert_pickup: handleAlertPickup,
  confirm_pickup: handleConfirmPickup,
  ask_child: handleAskChild,
  ask_time: handleAskTime,
  ask_pickup: handleAskPickup,
  confirm: handleConfirmDraft,
};

async function handleStep(ctx, key, p, kids, conv, n, raw) {
  if (/\bcancelar\b/.test(n)) { await finishStep(ctx, key); return reply(ctx, key, 'Listo, cancelé el proceso. ' + botMenu(ctx, p, kids)); }
  const handler = STEP_HANDLERS[conv.step];
  if (handler) return handler(ctx, key, p, kids, conv, n, raw);
  await finishStep(ctx, key);
  return reply(ctx, key, botMenu(ctx, p, kids));
}
