import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, call, loginAs, loginSuper } from './test-helpers.js';
import { MemoryPush } from './transports/push.js';

const post = (base, path, body, cookie) => call(base, path, { method: 'POST', body, cookie });
const VAPID = { vapidPublicKey: 'BPublicaDePrueba', vapidPrivateKey: 'privada-de-prueba', vapidSubject: 'mailto:super@example.com' };
const sub = (n) => ({ endpoint: 'https://push.example.com/send/' + n, keys: { p256dh: 'BKey' + n, auth: 'auth' + n } });
const MIN = 60000;

/* App with VAPID keys, a MemoryPush, the testers created and the super admin signed in. */
async function setup(ctx, { config = VAPID, push = new MemoryPush() } = {}) {
  const t = await makeTestApp({ config, push });
  const srv = await t.listen();
  const { result: made } = await t.run('create_testers', 'u_s1');
  const sup = await loginSuper(srv.base, made[0].pin);
  /* Closed even when an assertion fails, so a failing test cannot keep the runner alive. */
  ctx.after(async () => { await srv.close(); await t.close(); });
  return { t, push, made, sup, base: srv.base };
}
const pushRows = (t) => t.db.query("SELECT tester_id, name, ok, error, data FROM activity_events WHERE kind = 'push' ORDER BY id");
const quietErrors = () => { const orig = console.error; const lines = []; console.error = (...a) => lines.push(a.join(' ')); return { lines, restore: () => { console.error = orig; } }; };

test('a tester login sends one push to every subscription: tester, user, role and Panama time', async (ctx) => {
  const { t, push, made, sup, base } = await setup(ctx);
  assert.equal((await post(base, '/api/super/push/subscribe', { subscription: sub(1) }, sup)).status, 200);
  assert.equal((await post(base, '/api/super/push/subscribe', { subscription: sub(2) }, sup)).status, 200);
  assert.equal((await post(base, '/api/super/push/subscribe', { subscription: sub(2) }, sup)).status, 200, 'subscribing twice is idempotent');
  const cfg = await call(base, '/api/super/push/config', { cookie: sup });
  assert.deepEqual(cfg.json, { enabled: true, publicKey: VAPID.vapidPublicKey, subscribed: true, devices: 2 });

  const [u] = await t.db.query("SELECT name FROM users WHERE id = 'u_p1'");
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_p1', pin: made[1].pin })).status, 200);
  assert.equal(push.sent.length, 2, 'one per subscription');
  assert.deepEqual(push.sent.map((s) => s.subscription.endpoint).sort(), [sub(1).endpoint, sub(2).endpoint]);
  assert.deepEqual(push.sent[0].subscription.keys, push.sent[0].subscription.endpoint.endsWith('1') ? sub(1).keys : sub(2).keys);
  const p = push.sent[0].payload;
  assert.equal(p.title, 'IAE Salidas · entró Probador 2');
  assert.equal(p.body, 'Probador 2 entró como ' + u.name + ' (Padre/Madre) · 10:30', 'NOW is 15:30Z = 10:30 in Panama');
  assert.equal(p.url, '/super?tester=t2');
  const rows = await pushRows(t);
  assert.equal(rows.length, 1); assert.equal(rows[0].ok, true); assert.equal(rows[0].tester_id, 't2'); assert.equal(rows[0].name, 'login_alert');
  assert.equal(rows[0].data.sent, 2);
});

test('10 minute cooldown per tester; auth/switch and the shared PIN never notify', async (ctx) => {
  const { t, push, made, sup, base } = await setup(ctx);
  await post(base, '/api/super/push/subscribe', { subscription: sub(1) }, sup);
  const cookie = await loginAs(base, 'u_p1', made[1].pin);
  assert.equal(push.sent.length, 1);
  await loginAs(base, 'u_s2', made[1].pin);
  assert.equal(push.sent.length, 1, 'same tester again within 10 min: no push');
  await loginAs(base, 'u_p1', made[2].pin);
  assert.equal(push.sent.length, 2, 'another tester has its own cooldown');
  assert.equal(push.sent[1].payload.url, '/super?tester=t3');

  t.clock.now = new Date(t.clock.now.getTime() + 11 * MIN);
  assert.equal((await post(base, '/api/auth/switch', { userId: 'u_s2' }, cookie)).status, 200);
  assert.equal(push.sent.length, 2, 'switching user is not a new login');
  await loginAs(base, 'u_p1', '4321');
  assert.equal(push.sent.length, 2, 'the shared PIN has no tester');
  await loginAs(base, 'u_s2', made[1].pin);
  assert.equal(push.sent.length, 3, 'after 10 minutes the same tester notifies again');
  assert.match(push.sent[2].payload.body, /^Probador 2 entró como .+ \(Recepción\) · 10:4\d$/);
});

test('without VAPID keys push is off: nothing is sent, nothing fails', async (ctx) => {
  const push = new MemoryPush();
  const { t, made, sup, base } = await setup(ctx, { config: {}, push });
  assert.deepEqual((await call(base, '/api/super/push/config', { cookie: sup })).json, { enabled: false });
  assert.equal((await post(base, '/api/super/push/subscribe', { subscription: sub(1) }, sup)).json.error, 'push_not_configured');
  assert.equal((await post(base, '/api/super/push/test', {}, sup)).json.error, 'push_not_configured');
  /* A row left from an earlier configuration must not be used either. */
  await t.db.query("INSERT INTO push_subscriptions(tester_id, endpoint, keys, created_at) VALUES ('t1', $1, $2, now())", [sub(9).endpoint, JSON.stringify(sub(9).keys)]);
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_p1', pin: made[1].pin })).status, 200);
  assert.equal(push.sent.length, 0);
  assert.equal((await pushRows(t)).length, 0);
});

test('a 404/410 from the push service deletes that subscription; other failures only count', async (ctx) => {
  const push = new MemoryPush();
  const { t, made, sup, base } = await setup(ctx, { push });
  for (const n of [1, 2, 3]) await post(base, '/api/super/push/subscribe', { subscription: sub(n) }, sup);
  push.fail(410, sub(1).endpoint);
  push.fail(404, sub(2).endpoint);
  const r = await post(base, '/api/super/push/test', {}, sup);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { sent: 1, removed: 2, failed: 0 });
  assert.equal(push.sent[0].payload.title, 'IAE Salidas · prueba');
  const left = await t.db.query('SELECT endpoint, failures, last_ok_at FROM push_subscriptions');
  assert.deepEqual(left.map((x) => x.endpoint), [sub(3).endpoint]);
  assert.ok(left[0].last_ok_at);

  push.fail(500, sub(3).endpoint);
  const e = quietErrors();
  try { assert.equal((await post(base, '/api/auth/login', { userId: 'u_p1', pin: made[1].pin })).status, 200); } finally { e.restore(); }
  assert.equal((await t.db.query('SELECT failures FROM push_subscriptions'))[0].failures, 1, 'a 500 keeps the subscription');
  const rows = await pushRows(t);
  assert.deepEqual(rows.map((x) => [x.name, x.ok]), [['test', true], ['login_alert', false]]);
  assert.match(rows[1].error, /500/);
  assert.ok(e.lines.some((l) => /push/.test(l)), 'the failure goes to console.error');
});

test('/api/super/push/* needs the super cookie; test can target one device; unsubscribe removes it', async (ctx) => {
  const { t, push, made, sup, base } = await setup(ctx);
  const app = await loginAs(base, 'u_s1', made[0].pin);
  for (const [method, path] of [['GET', 'config'], ['POST', 'subscribe'], ['POST', 'unsubscribe'], ['POST', 'test']]) {
    const body = method === 'POST' ? { subscription: sub(1) } : undefined;
    assert.equal((await call(base, '/api/super/push/' + path, { method, body })).status, 401, path + ' without cookie');
    assert.equal((await call(base, '/api/super/push/' + path, { method, body, cookie: app })).status, 401, path + ' with an app session');
  }
  assert.equal((await t.db.query('SELECT count(*)::int AS n FROM push_subscriptions'))[0].n, 0);
  for (const bad of [null, {}, { endpoint: 'http://insecure.example.com/x', keys: sub(1).keys }, { endpoint: sub(1).endpoint }, { endpoint: sub(1).endpoint, keys: { p256dh: 'x'.repeat(500), auth: 'a' } }]) {
    assert.equal((await post(base, '/api/super/push/subscribe', { subscription: bad }, sup)).json.error, 'invalid_subscription');
  }
  await post(base, '/api/super/push/subscribe', { subscription: sub(1) }, sup);
  await post(base, '/api/super/push/subscribe', { subscription: sub(2) }, sup);
  const before = push.sent.length;
  assert.deepEqual((await post(base, '/api/super/push/test', { endpoint: sub(2).endpoint }, sup)).json, { sent: 1, removed: 0, failed: 0 });
  assert.equal(push.sent.length, before + 1); assert.equal(push.sent.at(-1).subscription.endpoint, sub(2).endpoint);
  assert.equal((await post(base, '/api/super/push/unsubscribe', { endpoint: sub(2).endpoint }, sup)).status, 200);
  assert.deepEqual((await t.db.query('SELECT endpoint FROM push_subscriptions')).map((x) => x.endpoint), [sub(1).endpoint]);
  const rows = await t.db.query("SELECT tester_id FROM push_subscriptions");
  assert.equal(rows[0].tester_id, 't1', 'the subscription remembers which super admin made it');
});

test('the login answers even when the push service hangs (waits at most pushWaitMs)', async (ctx) => {
  const push = new MemoryPush();
  const { made, sup, base } = await setup(ctx, { config: { ...VAPID, pushWaitMs: 100 }, push });
  await post(base, '/api/super/push/subscribe', { subscription: sub(1) }, sup);
  push.hang();
  const e = quietErrors();
  const started = Date.now();
  let r;
  try { r = await post(base, '/api/auth/login', { userId: 'u_p1', pin: made[1].pin }); } finally { e.restore(); }
  assert.equal(r.status, 200);
  assert.ok(Date.now() - started < 2000, 'did not wait for the push service');
  assert.ok(e.lines.some((l) => /push/.test(l) && /3 s|tiempo|timeout/i.test(l)));
  push.release();
  await new Promise((r) => setTimeout(r, 100)); // let the late send finish before the database closes (ctx.after)
});

test('the super admin logging into the app is not a tester to watch: no push', async (ctx) => {
  const { push, made, sup, base } = await setup(ctx);
  await post(base, '/api/super/push/subscribe', { subscription: sub(1) }, sup);
  assert.equal((await post(base, '/api/auth/login', { userId: 'u_s1', pin: made[0].pin })).status, 200);
  assert.equal(push.sent.length, 0);
});

test('installable /super: manifest, service worker (root scope, no-cache) and icons are served', async (ctx) => {
  const { base } = await setup(ctx);
  const sw = await call(base, '/super-sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
  assert.match(sw.text, /addEventListener\('push'/);
  const m = await call(base, '/super-manifest.webmanifest');
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type'), /application\/manifest\+json/);
  assert.equal(m.json.start_url, '/super'); assert.equal(m.json.display, 'standalone'); assert.equal(m.json.name, 'IAE Super');
  for (const icon of m.json.icons) assert.equal((await call(base, icon.src)).status, 200, icon.src);
  assert.equal((await call(base, '/icons/apple-touch-icon.png')).headers.get('content-type'), 'image/png');
  assert.equal((await call(base, '/icons/..%2Fsuper.html')).status, 404);
  assert.equal((await call(base, '/icons/nope.png')).status, 404);
  const html = (await call(base, '/super')).text;
  assert.match(html, /rel="manifest" href="\/super-manifest\.webmanifest"/);
  assert.match(html, /apple-mobile-web-app-capable/);
});

test('createPushSender: off without keys or with unusable keys, a WebPushSender with real ones', async (t) => {
  const { createPushSender, WebPushSender } = await import('./transports/push.js');
  const webpush = (await import('web-push')).default;
  assert.equal(createPushSender({}), null);
  const err = t.mock.method(console, 'error', () => {});
  assert.equal(createPushSender({ vapidPublicKey: 'corta', vapidPrivateKey: 'corta', vapidSubject: 'mailto:a@b.c' }), null);
  assert.equal(err.mock.callCount(), 1);
  const keys = webpush.generateVAPIDKeys();
  assert.ok(createPushSender({ vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, vapidSubject: 'mailto:a@b.c' }) instanceof WebPushSender);
});
