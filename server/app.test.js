import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, call, loginAs, loginSuper } from './test-helpers.js';

test('health, options and login lifecycle', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  assert.deepEqual((await call(base, '/api/health')).json, { ok: true }, 'public health says nothing about the database or its activity');
  assert.equal((await call(base, '/api/auth/options')).status, 401, 'the user directory needs a session');
  assert.equal((await call(base, '/api/auth/login', { method: 'POST', body: { userId: 'u_p1', pin: '0000' } })).status, 401);
  assert.equal((await call(base, '/api/me/view')).status, 401);
  const cookie = await loginAs(base, 'u_p1');
  assert.match(cookie, /^iae_session=/);
  const options = (await call(base, '/api/auth/options', { cookie })).json;
  assert.ok(options.find((u) => u.id === 'u_p1' && u.role === 'parent'));
  const health = (await call(base, '/api/health', { cookie })).json;
  assert.equal(health.ok, true); assert.equal(health.db, 'pglite'); assert.equal(typeof health.revision, 'number', 'with a session, health adds revision and db');
  const view = await call(base, '/api/me/view', { cookie });
  assert.equal(view.status, 200);
  assert.equal(view.json.view.user.id, 'u_p1');
  assert.equal(view.json.revision, 1);
  const etag = view.headers.get('etag');
  assert.equal((await call(base, '/api/me/view', { cookie, headers: { 'if-none-match': etag } })).status, 304);
  const out = await call(base, '/api/auth/logout', { method: 'POST', cookie });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  await close(); await t.close();
});

test('ten wrong PINs lock the user out', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  for (let i = 0; i < 10; i++) await call(base, '/api/auth/login', { method: 'POST', body: { userId: 'u_s2', pin: 'no' } });
  assert.equal((await call(base, '/api/auth/login', { method: 'POST', body: { userId: 'u_s2', pin: '4321' } })).status, 429);
  await close(); await t.close();
});

test('unknown commands are 404 and commands need a session', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  assert.equal((await call(base, '/api/commands/nope', { method: 'POST', body: {} })).status, 401);
  const cookie = await loginAs(base, 'u_p1');
  assert.equal((await call(base, '/api/commands/nope', { method: 'POST', body: {}, cookie })).status, 404);
  await close(); await t.close();
});

test('static serving is limited to index.html and client/', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  assert.equal((await call(base, '/')).status, 200);
  assert.equal((await call(base, '/client/api.js')).status, 200);
  for (const p of ['/server/app.js', '/data/pglite', '/.env', '/package.json', '/client/../package.json', '/client/.hidden', '/docs/x.md']) {
    assert.equal((await call(base, p)).status, 404, p);
  }
  await close(); await t.close();
});

/* S11: mismo CSP para las páginas HTML que vercel.json manda en producción -- solo con text/html, nunca
   con los estáticos JS/CSS (la CSP en esos no significaría nada y podría confundir). */
test('S11: CSP en las páginas HTML, no en los estáticos', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const index = await call(base, '/');
  assert.equal(index.status, 200);
  const csp = index.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' https:\/\/cdnjs\.cloudflare\.com/);
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(csp, /img-src 'self' data: blob:/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /manifest-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  const superPage = await call(base, '/super');
  assert.equal(superPage.status, 200);
  assert.ok(superPage.headers.get('content-security-policy'), '/super lleva la misma cabecera');
  const script = await call(base, '/client/api.js');
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-security-policy'), null, 'un .js no lleva CSP: no es un documento');
  await close(); await t.close();
});

/* S9: un PDF no se ve embebido con la CSP `sandbox` del adjunto (Chrome lo descarga inerte en vez de
   mostrarlo); se sirve como descarga. Las imágenes siguen `inline`. */
test('S9: un PDF se sirve con Content-Disposition: attachment', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const cookie = await loginAs(base, 'u_p1');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const pdfBytes = Buffer.from('%PDF-1.4 minimal').toString('base64');
  const up = await call(base, '/api/commands/upload_attachment', { method: 'POST', cookie, body: { purpose: 'certificado', mime: 'application/pdf', name: 'reporte.pdf', dataBase64: pdfBytes } });
  assert.equal(up.status, 200);
  const pdf = await call(base, '/api/attachments/' + up.json.result.attachmentId, { cookie });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-disposition'), /^attachment; filename="reporte\.pdf"$/);
  const upImg = await call(base, '/api/commands/upload_attachment', { method: 'POST', cookie, body: { purpose: 'foto', mime: 'image/png', name: 'foto.png', dataBase64: png } });
  const img = await call(base, '/api/attachments/' + upImg.json.result.attachmentId, { cookie });
  assert.match(img.headers.get('content-disposition'), /^inline;/, 'una imagen sigue sirviéndose inline');
  await close(); await t.close();
});

test('a spoofed X-Forwarded-For cannot walk around the login limit', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const attempt = (userId, ip, pin = 'no') => call(base, '/api/auth/login', { method: 'POST', body: { userId, pin }, headers: { 'x-forwarded-for': ip } });
  for (let i = 0; i < 10; i++) assert.equal((await attempt('u_s2', '10.0.0.' + i)).status, 401);
  assert.equal((await attempt('u_s2', '10.0.0.200', '4321')).status, 429, 'ten wrong PINs still lock the user');
  await close(); await t.close();
});

test('the per-IP limit counts the real socket, not the header', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const attempt = (userId, ip, pin = 'no') => call(base, '/api/auth/login', { method: 'POST', body: { userId, pin }, headers: { 'x-forwarded-for': ip } });
  /* Thirty PIN failures (the `pinguess:` limit) spread over ten different users, three each, every one claiming a
     different address: no single user key reaches its limit of 10, so only the IP key can block the next try. */
  const ids = ['u_p1', 'u_p2', 'u_p5', 'u_p6', 'u_p7', 'u_s1', 'u_s2', 'u_s3', 'u_s4', 'u_s5'];
  for (let round = 0; round < 3; round++) {
    for (const [i, userId] of ids.entries()) assert.equal((await attempt(userId, '10.0.' + round + '.' + (i + 1))).status, 401, userId);
  }
  assert.equal((await attempt('u_s6', '10.0.0.99', '4321')).status, 429);
  await close(); await t.close();
});

test('a body with multi-byte characters survives being read in chunks', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const cookie = await loginAs(base, 'u_p1');
  const reason = 'Señorita Muñoz 🎒🏫 '.repeat(4000).trim();
  assert.ok(Buffer.byteLength(reason, 'utf8') > 70000, 'big enough to span several chunks');
  const r = await call(base, '/api/commands/create_salida', { method: 'POST', cookie, body: { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason } });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.reason, reason, 'no character was cut in half at a chunk boundary');
  assert.equal(r.json.view.requests.find((x) => x.id === r.json.result.id).reason, reason);
  await close(); await t.close();
});

test('with DEMO_MODE off, demo-only commands answer 403 demo_only', async () => {
  const t = await makeTestApp({ config: { demoMode: false } });
  await assert.rejects(t.run('reset_demo', 'u_s1', {}), /demo_only/);
  await assert.rejects(t.run('seed_load', 'u_s1', { students: 50 }), /demo_only/);
  await assert.rejects(t.run('whatsapp_inbound', 'u_s1', { text: 'Sí, confirmo', chatKey: 'p1' }), /demo_only/);
  await assert.rejects(t.run('whatsapp_inbound', 'u_s1', { text: 'hola', chatKey: 'unknown' }), /demo_only/);
  const own = await t.run('whatsapp_inbound', 'u_p1', { text: 'hola', chatKey: 'p1' });
  assert.equal(own.result.chatKey, 'p1', 'a parent still writes on their own chat');
  const err = await t.run('reset_demo', 'u_s1', {}).catch((e) => e);
  assert.equal(err.status, 403);
  await t.close();
  const demo = await makeTestApp();
  assert.ok((await demo.run('reset_demo', 'u_s1', {})).revision, 'demo mode is on by default');
  assert.equal((await demo.run('whatsapp_inbound', 'u_s1', { text: 'hola', chatKey: 'p1' })).result.chatKey, 'p1');
  await demo.close();
});

test('the Vercel entry answers 503 with a generic message and logs the detail', async () => {
  const prev = process.env.SESSION_SECRET;
  const logged = [];
  const origError = console.error;
  console.error = (...a) => logged.push(a);
  try {
    process.env.SESSION_SECRET = '';
    const { default: handler } = await import('../api/index.js?fail=' + Date.now());
    const res = { headers: {}, statusCode: 0, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    await handler({ url: '/api/health', method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(JSON.parse(res.body), { error: 'service_unavailable' });
    assert.ok(logged.some((a) => String(a[a.length - 1] && a[a.length - 1].message).includes('SESSION_SECRET')), 'the real reason goes to the log');
  } finally {
    console.error = origError;
    if (prev === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prev;
  }
});

test('R4/R1: un sondeo 304 en me/view solo lee la revisión, sin getUser ni testers', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const cookie = await loginAs(base, 'u_p1');
  const first = await call(base, '/api/me/view', { cookie });
  const etag = first.headers.get('etag');
  const origQuery = t.db.query;
  const calls = [];
  t.db.query = (sql, params) => { calls.push(sql); return origQuery(sql, params); };
  try {
    const res = await call(base, '/api/me/view', { cookie, headers: { 'if-none-match': etag } });
    assert.equal(res.status, 304);
    assert.ok(calls.some((s) => /app_meta/i.test(s)), 'reads the revision');
    assert.ok(!calls.some((s) => /from\s+users/i.test(s)), 'a matching 304 does no getUser query');
    assert.ok(!calls.some((s) => /from\s+testers/i.test(s)), 'a matching 304 does no tester query');
    /* A token without a valid signature never touches the database. */
    const before = calls.length;
    const bad = await call(base, '/api/me/view', { cookie: 'iae_session=not-a-real-token', headers: { 'if-none-match': etag } });
    assert.equal(bad.status, 401);
    assert.equal(calls.length, before, 'an invalid signature runs no DB query at all');
  } finally { t.db.query = origQuery; }
  await close(); await t.close();
});

test('R4/R1: cuando la revisión cambió, el sondeo sí construye la vista completa', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const cookie = await loginAs(base, 'u_p1');
  const first = await call(base, '/api/me/view', { cookie });
  const staleEtag = first.headers.get('etag');
  await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' });
  const res = await call(base, '/api/me/view', { cookie, headers: { 'if-none-match': staleEtag } });
  assert.equal(res.status, 200);
  assert.ok(res.json.view.requests.length >= 1);
  await close(); await t.close();
});

test('R8: un 200 de sondeo (x-iae-poll) en me/view no deja fila de actividad; la carga inicial sí', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const cookie = await loginAs(base, 'u_p1');
  const first = await call(base, '/api/me/view', { cookie }); // carga inicial: sin el header, se registra
  const staleEtag = first.headers.get('etag');
  await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' });
  const polled = await call(base, '/api/me/view', { cookie, headers: { 'if-none-match': staleEtag, 'x-iae-poll': '1' } });
  assert.equal(polled.status, 200, 'sí cambió algo: no es un 304, es un 200 real del sondeo');
  const views = await t.db.query("SELECT * FROM activity_events WHERE kind = 'view'");
  assert.equal(views.length, 1, 'solo la carga inicial dejó fila; el 200 marcado como sondeo no');
  await close(); await t.close();
});

test('R7: el resumen de /super purga sola la actividad de más de 30 días y la auditoría de más de 180, como mucho una vez por hora', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const { result: made } = await t.run('create_testers', 'u_s1');
  const sup = await loginSuper(base, made[0].pin);
  const now = t.clock.now;
  const oldActivity = new Date(now.getTime() - 31 * 86400000).toISOString();
  const recentActivity = new Date(now.getTime() - 5 * 86400000).toISOString();
  const oldAudit = new Date(now.getTime() - 181 * 86400000).toISOString();
  const recentAudit = new Date(now.getTime() - 10 * 86400000).toISOString();
  await t.db.query(`INSERT INTO activity_events(at, source, kind, name, ok) VALUES ($1,'server','other','x',true), ($2,'server','other','y',true)`, [oldActivity, recentActivity]);
  await t.db.query(`INSERT INTO audit_log(at, command) VALUES ($1,'old_cmd'), ($2,'recent_cmd')`, [oldAudit, recentAudit]);

  await call(base, '/api/activity/summary', { cookie: sup });
  const kept = await t.db.query("SELECT name FROM activity_events WHERE name IN ('x','y')");
  assert.deepEqual(kept.map((r) => r.name), ['y'], 'solo se borra lo anterior a 30 días');
  const auditKept = await t.db.query("SELECT command FROM audit_log WHERE command IN ('old_cmd','recent_cmd')");
  assert.deepEqual(auditKept.map((r) => r.command), ['recent_cmd'], 'solo se borra la auditoría anterior a 180 días');

  /* segunda llamada casi enseguida: el cooldown de una hora no vuelve a purgar aunque haya algo viejo */
  await t.db.query(`INSERT INTO activity_events(at, source, kind, name, ok) VALUES ($1,'server','other','z',true)`, [oldActivity]);
  await call(base, '/api/activity/summary', { cookie: sup });
  assert.equal((await t.db.query("SELECT count(*)::int AS c FROM activity_events WHERE name = 'z'"))[0].c, 1, 'sin pasar una hora, no vuelve a purgar');
  await close(); await t.close();
});

test('R6: los estáticos llevan ETag débil y responden 304', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const first = await call(base, '/client/api.js');
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.match(etag, /^W\//, 'weak etag');
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const second = await call(base, '/client/api.js', { headers: { 'if-none-match': etag } });
  assert.equal(second.status, 304);
  await close(); await t.close();
});
