/* Avisos push al celular del super admin (página /super instalada): cuando un probador entra a la app.
   Las suscripciones viven en push_subscriptions; el envío va por deps.push (WebPushSender o MemoryPush). */
import { recordServerEvent } from './activity.js';
import { getSettings } from './db/repo.js';
import { nowHHMM } from './domain/time.js';
import { roleName } from './domain/text.js';

export const LOGIN_ALERT_COOLDOWN_S = 600;
const KEY_RE = /^[A-Za-z0-9_-]{1,200}={0,2}$/;

/* Push is on only with the three VAPID values and a sender (createPushSender returns null on bad keys). */
export const pushEnabled = (deps) => !!(deps.push && deps.config.vapidPublicKey && deps.config.vapidPrivateKey && deps.config.vapidSubject);

/* PushSubscription.toJSON() → { endpoint, keys: { p256dh, auth } }, or null when it is not one. */
export function cleanSubscription(s) {
  if (!s || typeof s !== 'object' || typeof s.endpoint !== 'string' || s.endpoint.length > 1024 || !s.keys || typeof s.keys !== 'object') return null;
  let url;
  try { url = new URL(s.endpoint); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const { p256dh, auth } = s.keys;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !KEY_RE.test(p256dh) || !KEY_RE.test(auth)) return null;
  return { endpoint: s.endpoint, keys: { p256dh, auth } };
}

export async function saveSubscription(db, { testerId, subscription, ua, now }) {
  await db.query(`INSERT INTO push_subscriptions(tester_id, endpoint, keys, ua, created_at, failures) VALUES ($1, $2, $3, $4, $5, 0)
    ON CONFLICT (endpoint) DO UPDATE SET tester_id = EXCLUDED.tester_id, keys = EXCLUDED.keys, ua = EXCLUDED.ua, failures = 0`,
  [testerId, subscription.endpoint, JSON.stringify(subscription.keys), ua || null, now.toISOString()]);
}
export async function removeSubscription(db, endpoint) {
  return (await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 RETURNING id', [String(endpoint || '')])).length;
}
export async function subscriptionCounts(db, testerId) {
  const [r] = await db.query('SELECT count(*)::int AS devices, count(*) FILTER (WHERE tester_id = $1)::int AS mine FROM push_subscriptions', [testerId]);
  return { devices: r.devices, mine: r.mine };
}

/* Sends one payload to every subscription (or only `endpoint`). 404/410 = the browser dropped it: the row goes.
   Never throws for a failed device; returns the tally and the first error. */
export async function sendToAll(deps, payload, { now, endpoint = null } = {}) {
  const { db } = deps;
  const subs = endpoint
    ? await db.query('SELECT id, endpoint, keys FROM push_subscriptions WHERE endpoint = $1', [endpoint])
    : await db.query('SELECT id, endpoint, keys FROM push_subscriptions ORDER BY id');
  const out = { sent: 0, removed: 0, failed: 0, error: null };
  await Promise.all(subs.map(async (s) => {
    const keys = typeof s.keys === 'string' ? JSON.parse(s.keys) : s.keys;
    try {
      await deps.push.send({ endpoint: s.endpoint, keys }, payload);
      out.sent++;
      await db.query('UPDATE push_subscriptions SET last_ok_at = $2, failures = 0 WHERE id = $1', [s.id, now.toISOString()]);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { out.removed++; await db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]); return; }
      out.failed++;
      out.error ||= (e.statusCode ? e.statusCode + ' ' : '') + String(e.message || e).slice(0, 200);
      await db.query('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1', [s.id]);
    }
  }));
  return out;
}

/* One activity row per dispatch (not per device), so /super shows when a notice did not arrive. */
async function recordPush(db, ev, result) {
  const ok = !result.error && result.failed === 0;
  if (!ok) console.error('push: ' + ev.name + ' falló:', result.error || 'error');
  await recordServerEvent(db, { ...ev, source: 'server', kind: 'push', ok, error: ok ? null : result.error || 'push_failed',
    data: { sent: result.sent || 0, removed: result.removed || 0, failed: result.failed || 0 } });
}
const tzOf = async (db) => (await getSettings(db)).timezone || 'America/Panama';
const roleLabel = (r) => (r === 'parent' ? 'Padre/Madre' : roleName(r));

/* The 10-minute window per tester is claimed atomically in app_meta (value = unix seconds of the last notice),
   so two logins at the same instant on two instances send one notice. */
async function claimLoginAlert(db, testerId, now) {
  const t = Math.floor(now.getTime() / 1000);
  const r = await db.query(`INSERT INTO app_meta(id, value) VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value WHERE app_meta.value <= $3 RETURNING value`, ['push_alert_' + testerId, t, t - LOGIN_ALERT_COOLDOWN_S]);
  return r.length > 0;
}

/* After a successful auth/login of a named tester: "Probador X entró como Y (rol) · HH:MM" to every device. */
export async function notifyTesterLogin(deps, { tester, user, sid, ip, ua, now }) {
  if (!pushEnabled(deps) || !tester || !tester.id) return null;
  const { db } = deps;
  if (!(await subscriptionCounts(db, tester.id)).devices) return null;
  if (!(await claimLoginAlert(db, tester.id, now))) return null;
  const name = tester.name || tester.id;
  const payload = {
    title: 'IAE Salidas · entró ' + name,
    body: name + ' entró como ' + user.name + ' (' + roleLabel(user.role) + ') · ' + nowHHMM(now, await tzOf(db)),
    url: '/super?tester=' + encodeURIComponent(tester.id),
    tag: 'login-' + tester.id,
  };
  let result;
  try { result = await sendToAll(deps, payload, { now }); } catch (e) { result = { sent: 0, removed: 0, failed: 0, error: String(e.message || e) }; }
  await recordPush(db, { at: now, testerId: tester.id, userId: user.id, role: user.role, sid, name: 'login_alert', ip, ua }, result);
  return result;
}

/* "Probar" in /super: a notice to every device, or only to the one that asked. */
export async function sendTestNotice(deps, { sup, endpoint, now, ip, ua }) {
  const payload = { title: 'IAE Salidas · prueba', body: 'Los avisos funcionan en este dispositivo · ' + nowHHMM(now, await tzOf(deps.db)), url: '/super', tag: 'test' };
  const result = await sendToAll(deps, payload, { now, endpoint });
  await recordPush(deps.db, { at: now, testerId: sup.testerId, sid: sup.sid, name: 'test', ip, ua }, result);
  return result;
}

/* The login waits for the notice at most `config.pushWaitMs` (3 s): a slow push service never holds a tester at
   the door. On time-out the send keeps going in the background (a long-lived server finishes it; a serverless
   function may be frozen first), and a failed row is left so /super shows the notice may not have arrived. */
export const PUSH_WAIT_MS = 3000;
export async function alertTesterLogin(deps, info) {
  if (!pushEnabled(deps)) return null;
  const waitMs = deps.config.pushWaitMs || PUSH_WAIT_MS;
  const sending = notifyTesterLogin(deps, info).catch((e) => { console.error('push: aviso de entrada falló:', e.message || e); return null; });
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), waitMs); });
  const r = await Promise.race([sending, late]);
  clearTimeout(timer);
  if (r !== 'timeout') return r;
  console.error('push: tiempo de espera agotado (' + waitMs + ' ms) enviando el aviso de entrada de ' + info.tester.id + '; el login no espera más');
  await recordServerEvent(deps.db, { at: info.now, testerId: info.tester.id, userId: info.user.id, role: info.user.role, sid: info.sid, source: 'server', kind: 'push',
    name: 'login_alert', ok: false, error: 'timeout', ip: info.ip, ua: info.ua, data: { waitMs } });
  return null;
}
