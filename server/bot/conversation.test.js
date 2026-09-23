import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { listChat, getConversation, listRequests, listNotifications, patchRow, findTrip } from '../db/repo.js';
import { todayISO, shiftISO } from '../domain/time.js';

const lastBot = async (db, key) => (await listChat(db, key)).filter((m) => m.from === 'bot').at(-1);
const say = (t, user, text, chatKey) => t.run('whatsapp_inbound', user, chatKey ? { text, chatKey } : { text });

test('greeting, menu, unknown number and status', async () => {
  const t = await makeTestApp();
  await say(t, 'u_p1', 'hola');
  const m = await lastBot(t.db, 'p1');
  assert.match(m.text, /^Hola Carlos 👋 Soy el asistente de IAE Salidas\./);
  assert.ok(m.pendingUntil > t.clock.now.getTime(), 'bot replies are typed');
  assert.equal((await listChat(t.db, 'p1'))[0].from, 'user');
  await say(t, 'u_s1', 'hola', 'unknown');
  assert.match((await lastBot(t.db, 'unknown')).text, /^Hola 👋 Este número no está registrado en IAE Salidas/);
  await assert.rejects(say(t, 'u_p1', 'hola', 'p2'), /forbidden_chat_key/);
  await assert.rejects(say(t, 'u_s1', 'hola', 'p_nope'), /chat_key_not_found/);
  await say(t, 'u_p1', 'Estado');
  assert.equal((await lastBot(t.db, 'p1')).text, 'No tienes solicitudes recientes.');
  await say(t, 'u_p1', 'xyz');
  assert.match((await lastBot(t.db, 'p1')).text, /^No te entendí 🤔/);
  await t.close();
});

test('salida flow: confirm → auto-approved; short notice → pending; unknown pickup → ask', async () => {
  const t = await makeTestApp();
  await say(t, 'u_p1', 'Necesito retirar a Joseph hoy a las 3:30 pm');
  const c = await lastBot(t.db, 'p1');
  assert.equal(c.text, '📋 Confirma la solicitud:\n• Estudiante: Joseph Rodríguez (3°)\n• Fecha: hoy\n• Hora: 3:30 pm\n• Retira: tú\n\n¿Es correcto?');
  assert.deepEqual(c.buttons, ['Sí', 'No']);
  assert.equal((await getConversation(t.db, 'p1')).step, 'confirm');
  await say(t, 'u_p1', 'Sí');
  const [r] = await listRequests(t.db, { studentIds: ['e1'] });
  assert.equal(r.status, 'aprobada');
  assert.equal(r.channel, 'whatsapp');
  assert.equal(r.time, '15:30');
  assert.match((await lastBot(t.db, 'p1')).text, /^✅ Salida aprobada: Joseph Rodríguez hoy a las 3:30 pm/);
  assert.equal(await getConversation(t.db, 'p1'), null);

  // Sofía, not Joseph: Joseph already has an active (aprobada) salida today, and a second one for the
  // same student and date is now rejected as a duplicate (L15) -- so this exercises a different child.
  await say(t, 'u_p1', 'A Sofía la retira la abuela a las 11');
  assert.match((await lastBot(t.db, 'p1')).text, /• Retira: María Pérez \(Abuela\)/);
  await say(t, 'u_p1', 'Sí');
  const pend = (await listRequests(t.db, { studentIds: ['e2'] }))[0];
  assert.equal(pend.status, 'pendiente');
  assert.equal(pend.pickupBy, 'p3');
  assert.match((await lastBot(t.db, 'p1')).text, /^📝 Recibimos tu solicitud de salida de Sofía Rodríguez hoy a las 11:00 am/);

  await say(t, 'u_p1', 'A Joseph lo retira el vecino a las 2 pm');
  const ask = await lastBot(t.db, 'p1');
  assert.match(ask.text, /^"vecino" no aparece como persona autorizada para Joseph/);
  assert.deepEqual(ask.buttons, ['Yo', 'Ana (Mamá)', 'María (Abuela)', 'Luis (Tío)', 'Laura (Mamá)']);
  await say(t, 'u_p1', 'Luis (Tío)');
  assert.match((await lastBot(t.db, 'p1')).text, /• Retira: Luis Rodríguez \(Tío\)/);
  await say(t, 'u_p1', 'No');
  assert.match((await lastBot(t.db, 'p1')).text, /^Ok, la descarté\./);
  assert.equal(await getConversation(t.db, 'p1'), null);
  await t.close();
});

test('ask_child and ask_time steps, cancel mid-flow', async () => {
  const t = await makeTestApp();
  await say(t, 'u_p1', 'Necesito retirar temprano');
  const a = await lastBot(t.db, 'p1');
  assert.equal(a.text, '¿A cuál de tus hijos? ');
  assert.deepEqual(a.buttons, ['Joseph', 'Sofía']);
  await say(t, 'u_p1', 'Sofía');
  assert.match((await lastBot(t.db, 'p1')).text, /^¿A qué hora necesitas que Sofía salga hoy\?/);
  await say(t, 'u_p1', 'a las 4 pm');
  assert.match((await lastBot(t.db, 'p1')).text, /• Hora: 4:00 pm/);
  await say(t, 'u_p1', 'cancelar');
  assert.match((await lastBot(t.db, 'p1')).text, /^Listo, cancelé el proceso\./);
  assert.equal(await getConversation(t.db, 'p1'), null);
  await t.close();
});

test('excusa flow with attachment chip', async () => {
  const t = await makeTestApp();
  await say(t, 'u_p7', 'Emily no irá mañana, tiene cita médica');
  const c = await lastBot(t.db, 'p7');
  assert.match(c.text, /^📋 Confirma la excusa:\n• Estudiante: Emily Chen \(9°\)\n• Tipo: ausencia\n• Fecha: mañana/);
  assert.deepEqual(c.buttons, ['Sí', 'No', '📎 Adjuntar certificado']);
  await say(t, 'u_p7', '📎 Adjuntar certificado');
  const chat = await listChat(t.db, 'p7');
  assert.ok(chat.some((m) => m.text === '📎 Recibí certificado_medico.jpg ✅'));
  assert.match((await lastBot(t.db, 'p7')).text, /• Adjunto: certificado_medico\.jpg/);
  await say(t, 'u_p7', 'Sí');
  const [e] = await listRequests(t.db, { studentIds: ['e4'], kind: 'excusa' });
  assert.equal(e.status, 'pendiente');
  assert.equal(e.date, '2026-09-19');
  assert.equal(e.attachmentName, 'certificado_medico.jpg');
  await t.close();
});

test('where-is and no-bus intents', async () => {
  const t = await makeTestApp();
  await say(t, 'u_p1', '¿Dónde está Joseph?');
  const w = await lastBot(t.db, 'p1');
  assert.match(w.text, /^🚌 Joseph va en el Bus 12/);
  assert.equal(w.location.routeId, 'r1');
  await say(t, 'u_p1', 'Sofía hoy no va en el bus');
  assert.equal((await lastBot(t.db, 'p1')).text, '🚌 Listo. Avisé a la monitora Kenia Pérez que Sofía hoy no va en el Bus 12 (ida (mañana) y vuelta (tarde)).');
  assert.equal((await listNotifications(t.db, { staffId: 's7' })).length, 1);
  await say(t, 'u_p1', '¿dónde está?');
  assert.deepEqual((await lastBot(t.db, 'p1')).buttons, ['Joseph', 'Sofía']);
  await say(t, 'u_p1', 'Joseph');
  assert.match((await lastBot(t.db, 'p1')).text, /^🚌 Joseph va en el Bus 12/);
  await t.close();
});

test('proactive alert answered NO cancels; confirm_pickup answered through chat', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p4', reason: 'x' });
  assert.equal((await getConversation(t.db, 'p2')).step, 'alert_pickup');
  await say(t, 'u_p2', 'NO');
  assert.equal((await listRequests(t.db, { studentIds: ['e1'] }))[0].status, 'cancelada');
  assert.match((await lastBot(t.db, 'p2')).text, /^⛔ Cancelé la salida y avisé a la garita/);
  assert.match((await listNotifications(t.db, { role: 'garita' })).at(-1).text, /^⛔ Ana Pérez NO reconoce a Luis Rodríguez · salida de Joseph Rodríguez CANCELADA$/);
  assert.match((await listNotifications(t.db, { personId: 'p1' })).at(-1).text, /^⛔ Ana Pérez no reconoció a Luis Rodríguez; la salida de Joseph fue cancelada\.$/);
  assert.equal(await getConversation(t.db, 'p1'), null);

  const { result: r2 } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p5', reason: 'x' });
  await t.run('approve_request', 'u_s2', { requestId: r2.id });
  await say(t, 'u_p1', 'Es correcto');
  assert.match((await lastBot(t.db, 'p1')).text, /^👍 Gracias, queda confirmado\./);
  await t.run('request_confirmation', 'u_s6', { requestId: r2.id });
  await say(t, 'u_p1', 'Sí, confirmo');
  assert.match((await lastBot(t.db, 'p1')).text, /^✅ Gracias, confirmaste la entrega\./);
  assert.equal((await listRequests(t.db, { studentIds: ['e1'] }))[0].confirmation.status, 'confirmada');
  await t.close();
});

test('validation errors from create_salida reach the parent as a chat reply, not a crash', async () => {
  const t = await makeTestApp();
  await say(t, 'u_p1', 'Necesito retirar a Joseph hoy a las 8 am');
  assert.match((await lastBot(t.db, 'p1')).text, /• Hora: 8:00 am/);
  await say(t, 'u_p1', 'Sí');
  const m = await lastBot(t.db, 'p1');
  assert.match(m.text, /hora ya pasó/i);
  assert.equal((await listRequests(t.db, { studentIds: ['e1'] })).length, 0, 'nothing was created');
  assert.equal(await getConversation(t.db, 'p1'), null, 'the bot does not get stuck');
  await t.close();
});

test('cancelling from the app releases the other titular stuck in confirm_pickup, and their stale reply no longer crashes the bot (L8)', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p5', reason: 'x' });
  await t.run('approve_request', 'u_s2', { requestId: r.id });
  await say(t, 'u_p1', 'Es correcto'); // Carlos clears his own proactive alert first
  await t.run('request_confirmation', 'u_s6', { requestId: r.id });
  assert.equal((await getConversation(t.db, 'p1')).step, 'confirm_pickup');
  assert.equal((await getConversation(t.db, 'p2')).step, 'confirm_pickup');
  await t.run('cancel_request', 'u_p1', { requestId: r.id }); // Carlos cancels from the app
  assert.equal(await getConversation(t.db, 'p2'), null, "Ana's stuck confirm_pickup state is released");
  // Ana's stale "Sí, confirmo" no longer rolls back her own message with a 409, and no longer gets stuck.
  await say(t, 'u_p2', 'Sí, confirmo');
  assert.match((await lastBot(t.db, 'p2')).text, /^No te entendí 🤔/);
  await say(t, 'u_p2', 'hola');
  assert.match((await lastBot(t.db, 'p2')).text, /^Hola Ana/);
  await t.close();
});

test('a stale conversation state (older than 2h) is ignored, not resumed as an answer (L8)', async () => {
  const t = await makeTestApp();
  await say(t, 'u_p1', 'Necesito retirar temprano'); // enters ask_child, leaving a draft behind
  assert.equal((await getConversation(t.db, 'p1')).step, 'ask_child');
  t.clock.now = new Date(t.clock.now.getTime() + 3 * 3600 * 1000); // +3h, same day
  await say(t, 'u_p1', 'Sofía');
  assert.match((await lastBot(t.db, 'p1')).text, /^No te entendí 🤔/, '"Sofía" is not read as a 3h-late answer to "¿A cuál de tus hijos?"');
  assert.equal(await getConversation(t.db, 'p1'), null);
  await t.close();
});

test('a conversation state from a different school day is ignored even if under 2h old (L8)', async () => {
  const t = await makeTestApp({ now: new Date('2026-09-19T04:50:00Z') }); // 2026-09-18 23:50 in America/Panama
  await say(t, 'u_p1', 'Necesito retirar temprano');
  assert.equal((await getConversation(t.db, 'p1')).step, 'ask_child');
  t.clock.now = new Date('2026-09-19T05:10:00Z'); // 2026-09-19 00:10 Panama: 20 minutes later, but a new day
  await say(t, 'u_p1', 'Sofía');
  assert.match((await lastBot(t.db, 'p1')).text, /^No te entendí 🤔/, "yesterday's draft is dropped once the school day turns over, even minutes later");
  assert.equal(await getConversation(t.db, 'p1'), null);
  await t.close();
});

test('a proactive alert queues behind a draft in progress instead of overwriting it, and surfaces once the draft ends (L9)', async () => {
  const t = await makeTestApp();
  // Carlos starts a salida draft for Sofía and stops partway, at ask_time.
  await say(t, 'u_p1', 'Necesito retirar a Sofía temprano');
  assert.equal((await getConversation(t.db, 'p1')).step, 'ask_time');

  // Meanwhile, an unrelated approval for Joseph fires a proactive alert to both of his titulares.
  const { result: r } = await t.run('create_salida', 'u_p2', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p4', reason: 'x' });
  assert.equal(r.status, 'aprobada', 'temporal authorizations still auto-approve');
  const cs = await getConversation(t.db, 'p1');
  assert.equal(cs.step, 'ask_time', "the draft in progress survives the alert -- it is not overwritten");
  assert.equal(cs.draft.studentId, 'e2');
  assert.deepEqual(cs.alerts, [{ requestId: r.id }], 'the alert waits behind the draft instead');

  // Carlos finishes his own draft undisturbed...
  await say(t, 'u_p1', '4 pm');
  await say(t, 'u_p1', 'Sí');
  assert.match((await lastBot(t.db, 'p1')).text, /^✅ Salida aprobada: Sofía Rodríguez hoy a las 4:00 pm/);
  // ...and only then does the queued alert surface.
  assert.deepEqual(await getConversation(t.db, 'p1'), { step: 'alert_pickup', requestId: r.id, draft: null, alerts: [] });
  await say(t, 'u_p1', 'Es correcto');
  assert.match((await lastBot(t.db, 'p1')).text, /^👍 Gracias, queda confirmado\./);
  assert.equal(await getConversation(t.db, 'p1'), null);
  await t.close();
});

test('two proactive alerts in a row: NO cancels the one currently shown, then the next queued one surfaces (L9)', async () => {
  const t = await makeTestApp();
  const { result: r1 } = await t.run('create_salida', 'u_p2', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p4', reason: 'x' });
  assert.equal(r1.status, 'aprobada');
  const { result: r2 } = await t.run('create_salida', 'u_p2', { studentId: 'e1', date: '2026-09-19', time: '13:00', pickupBy: 'p4', reason: 'y' });
  assert.equal(r2.status, 'aprobada');
  assert.deepEqual(await getConversation(t.db, 'p1'), { step: 'alert_pickup', requestId: r1.id, draft: null, alerts: [{ requestId: r2.id }] });

  await say(t, 'u_p1', 'NO'); // answers the alert currently shown (r1), not silently the last one queued
  assert.equal((await listRequests(t.db, { studentIds: ['e1'], date: '2026-09-18' }))[0].status, 'cancelada');
  assert.equal((await listRequests(t.db, { studentIds: ['e1'], date: '2026-09-19' }))[0].status, 'aprobada', 'r2 is untouched');
  assert.equal((await getConversation(t.db, 'p1')).step, 'alert_pickup');
  assert.equal((await getConversation(t.db, 'p1')).requestId, r2.id, 'the second, still-unanswered alert now surfaces');
  await say(t, 'u_p1', 'NO');
  assert.equal((await listRequests(t.db, { studentIds: ['e1'], date: '2026-09-19' }))[0].status, 'cancelada');
  assert.equal(await getConversation(t.db, 'p1'), null);
  await t.close();
});

test('unrecognized text on a proactive alert repeats the question instead of dropping it (L9)', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p4', reason: 'x' });
  assert.equal(r.status, 'aprobada');
  assert.equal((await getConversation(t.db, 'p2')).step, 'alert_pickup');
  await say(t, 'u_p2', '¿quién es?');
  assert.match((await lastBot(t.db, 'p2')).text, /Responde "Es correcto" o "NO"/);
  assert.equal((await getConversation(t.db, 'p2')).step, 'alert_pickup', 'the alert is still pending, not silently dropped');
  await say(t, 'u_p2', 'NO');
  assert.equal((await listRequests(t.db, { studentIds: ['e1'] }))[0].status, 'cancelada');
  await t.close();
});

test('a late "NO" on a proactive alert after the student already left points to Recepción and warns the school (L9)', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p4', reason: 'x' });
  assert.equal(r.status, 'aprobada');
  await t.run('mark_exit', 'u_s6', { requestId: r.id });
  // Carlos never answered the earlier proactive alert; his late NO arrives after the student left.
  await say(t, 'u_p1', 'NO');
  const m = await lastBot(t.db, 'p1');
  assert.match(m.text, /ya salió a las 10:30 am con Luis Rodríguez/);
  assert.match(m.text, /llama a recepción al \+507 6800-0000/);
  assert.match((await listNotifications(t.db, { role: 'recepcion' })).at(-1).text, /NO reconoce a Luis Rodríguez.*ya salió/);
  assert.equal(await getConversation(t.db, 'p1'), null);
  await t.close();
});

test('resolvePickup (L14): a full name match resolves directly, a surname-only match on a name that was not asked for does not', async () => {
  const t = await makeTestApp();
  // "Hoy retira a Joseph Laura Gómez a las 2 pm": full first+last name match -> resolves straight to
  // Laura Gómez (also a titular of Joseph) without asking, even though Ana Pérez, María Pérez and Luis
  // Rodríguez are also candidates.
  await say(t, 'u_p1', 'Hoy retira a Joseph Laura Gómez a las 2 pm');
  assert.match((await lastBot(t.db, 'p1')).text, /• Retira: Laura Gómez/);
  await say(t, 'u_p1', 'No'); // discard, don't actually create it

  // "Carmen Gómez" shares a surname with titular Laura Gómez but is not her -- a lone surname match
  // on a two-word hint used to be trusted anyway and silently picked Laura (L14). Now it must ask.
  await say(t, 'u_p1', 'A Joseph lo retira Carmen Gómez a las 2 pm');
  const ask = await lastBot(t.db, 'p1');
  assert.match(ask.text, /^"carmen gomez" no aparece como persona autorizada para Joseph/);
  assert.ok(!ask.buttons.includes('Laura Gómez (Mamá)'), 'not silently resolved to the wrong Gómez');
  await t.close();
});

test('mark_no_bus via chat (L12): "mañana" registers the opt-out for tomorrow, not today, and a route with no monitora notifies Recepción instead of crashing', async () => {
  const t = await makeTestApp();
  await say(t, 'u_p1', 'Joseph mañana no va en el bus');
  const tomorrow = shiftISO(t.clock.now, 'America/Panama', 1);
  const today = todayISO(t.clock.now, 'America/Panama');
  assert.match((await lastBot(t.db, 'p1')).text, /^🚌 Listo\. Avisé a la monitora Kenia Pérez que Joseph mañana no va en el Bus 12/);
  assert.deepEqual((await findTrip(t.db, tomorrow, 'r1', 'ida')).noBus, ['e1']);
  assert.equal(await findTrip(t.db, today, 'r1', 'ida'), null, "today's trip was never touched -- 'mañana' meant tomorrow, not this morning's leg");

  await patchRow(t.db, 'routes', 'r1', { monitorStaffId: null });
  await say(t, 'u_p1', 'Sofía hoy no va en el bus');
  assert.match((await lastBot(t.db, 'p1')).text, /^🚌 Listo\. Avisé a Recepción \(la ruta no tiene monitora asignada\) que Sofía hoy no va en el Bus 12/);
  await t.close();
});

test('a candidate who loses eligibility between drafting and confirming gets a friendly reply', async () => {
  const t = await makeTestApp();
  await say(t, 'u_p1', 'A Joseph lo retira la abuela a las 11');
  assert.match((await lastBot(t.db, 'p1')).text, /• Retira: María Pérez \(Abuela\)/);
  await t.run('revoke_authorization', 'u_p1', { authorizationId: 'a1' });
  await say(t, 'u_p1', 'Sí');
  const m = await lastBot(t.db, 'p1');
  assert.match(m.text, /ya no|no aparece|no está autorizad/i);
  assert.equal((await listRequests(t.db, { studentIds: ['e1'] })).length, 0, 'nothing was created');
  await t.close();
});
