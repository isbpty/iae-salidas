import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { makeCtx } from './context.js';
import { notifyPerson, notifyRole, notifyTeachers, logEvent } from './notifications.js';
import { listNotifications, listChat, listAudit } from '../db/repo.js';

test('notifyPerson stores a notification and mirrors it to the WhatsApp chat when the person has a phone', async () => {
  const t = await makeTestApp();
  await t.db.tx(async (q) => {
    const ctx = await makeCtx(q, t.deps, 'u_s2', { command: 'x' });
    await notifyPerson(ctx, 'p1', 'hola Carlos', { buttons: ['Sí', 'No'] });
    await notifyRole(ctx, 'garita', 'aviso garita');
    await notifyTeachers(ctx, 'e1', 'aviso 3°');
    await logEvent(ctx, 'hizo algo', 'Yadira Batista');
  });
  const n = await listNotifications(t.db, { personId: 'p1' });
  assert.equal(n.length, 1);
  assert.deepEqual(n[0].buttons, ['Sí', 'No']);
  assert.equal(n[0].read, false);
  const chat = await listChat(t.db, 'p1');
  assert.equal(chat.length, 1);
  assert.equal(chat[0].from, 'bot');
  assert.equal(chat[0].pendingUntil, null, 'notifications are not typed, they arrive instantly');
  assert.equal((await listNotifications(t.db, { role: 'garita' })).length, 1);
  assert.equal((await listNotifications(t.db, { staffId: 's3' })).length, 1, 'Diana teaches 3°');
  assert.equal((await listNotifications(t.db, { staffId: 's4' })).length, 0);
  const audit = await listAudit(t.db, 1);
  assert.equal(audit[0].summary, 'hizo algo');
  assert.equal(audit[0].actorName, 'Yadira Batista');
  await t.close();
});
