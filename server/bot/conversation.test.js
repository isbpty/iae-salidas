import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { listChat, getConversation, listRequests, listNotifications } from '../db/repo.js';

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

  await say(t, 'u_p1', 'A Joseph lo retira la abuela a las 11');
  assert.match((await lastBot(t.db, 'p1')).text, /• Retira: María Pérez \(Abuela\)/);
  await say(t, 'u_p1', 'Sí');
  const pend = (await listRequests(t.db, { studentIds: ['e1'] }))[0];
  assert.equal(pend.status, 'pendiente');
  assert.equal(pend.pickupBy, 'p3');
  assert.match((await lastBot(t.db, 'p1')).text, /^📝 Recibimos tu solicitud de salida de Joseph Rodríguez hoy a las 11:00 am/);

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
