import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './domain/errors.js';
import { randomBytes, createHash } from 'node:crypto';
import { cookieValue, sessionToken, verifySession, pinToken, verifyPinToken, signToken, verifyToken, issuedAtMs } from './session.js';
import { constantEquals, attemptsBlocked, recordLoginFailure, clearLoginFailures, consumeTokenId, PIN_GUESS_LIMIT } from './auth.js';
import { listUsers, getUser, getRevision, getAttachment, insertAudit, purgeActivity } from './db/repo.js';
import { findTesterByPin, listTesters, regenerateTesterPin, renameTester, setAllowedUsers, getTester, revokeTesterSessions, testerAccess, allowsUser } from './testers.js';
import { summary, events as activityEvents, exportCsv } from './activity-queries.js';
import { classify, maskInput, recordServerEvent, ingestClientEvents, clientInfo, sanitizeFingerprint } from './activity.js';
import { runCommand } from './commands/run.js';
import { buildView } from './projections/index.js';
import { canSeeAttachment } from './projections/access.js';
import { pushEnabled, cleanSubscription, saveSubscription, removeSubscription, subscriptionCounts, sendTestNotice, alertTesterLogin } from './push.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json; charset=utf-8' };

export function createApp(deps) {
  const { db, config } = deps;
  const clients = new Set();
  const publish = (revision) => {
    const line = `data: ${JSON.stringify({ type: 'changed', revision })}\n\n`;
    for (const res of clients) res.write(line);
  };
  const env = () => ({ now: deps.now(), transport: deps.transport, gps: deps.gps, serverless: config.serverless });
  const json = (res, status, value, headers = {}) => {
    if (status >= 400 && value && value.error) res.errorCode = value.error;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(value));
  };
  const cookie = (token, maxAge) => `iae_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${config.secure ? '; Secure' : ''}`;
  async function readBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > 1.5e6) throw new HttpError(413, 'too_large');
      chunks.push(buf);
    }
    /* Concatenate first: a multi-byte character may straddle two chunks. */
    const raw = Buffer.concat(chunks, bytes).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  }
  /* Only a platform proxy (Vercel) may name the client; a direct listener would let anyone
     spoof the header and walk around the per-IP login limit. */
  const clientIp = (req) => {
    const direct = (req.socket && req.socket.remoteAddress) || 'unknown';
    const source = config.serverless ? req.headers['x-forwarded-for'] || direct : direct;
    return String(source).split(',')[0].trim();
  };
  /* Geolocalización aproximada (Task 15): solo existe detrás del edge de Vercel (`x-vercel-ip-*`); en local
     y en los tests siempre es `null`. Se pide aparte de `clientIp`/`userAgent` porque solo un puñado de
     eventos la guardan (login, login_failed, pin, switch_user, super_login) y el aviso push de entrada. */
  const geoOf = (req) => clientInfo(req, config.serverless).geo;
  /* A token of a tester counts while the tester is active and it was issued after their last logout or new PIN
     (`sessions_valid_after`). Tokens of the shared PIN carry no tester and only expire. */
  const tokenCurrent = (token, access) => !!access && access.active && issuedAtMs(token) >= access.validAfterMs;
  async function sessionUser(req) {
    const session = verifySession(cookieValue(req.headers.cookie, 'iae_session'), config.secret);
    if (!session || !session.userId) return null;
    const user = await getUser(db, session.userId);
    if (!user || !user.active) return null;
    let access = null;
    if (session.testerId) {
      access = await testerAccess(db, session.testerId);
      if (!tokenCurrent(session, access) || !allowsUser(access, user.id)) return null;
    }
    return { user, session, access };
  }
  /* A PIN names a tester, or is the shared pilot PIN (tester null), or is wrong (undefined). */
  async function resolvePin(pin) {
    const value = String(pin == null ? '' : pin);
    if (config.sharedPin && constantEquals(value, config.pin)) return null;
    return (await findTesterByPin(db, value, config.secret)) || undefined;
  }
  const publicTester = (t) => (t && t.testerId ? { id: t.testerId, name: t.testerName, super: !!t.super } : null);
  /* The demo users a tester may open (`allowed_users`, null = all). */
  const userOptions = async (allowed = null) => (await listUsers(db)).filter((u) => !allowed || allowed.includes(u.id)).map((u) => ({ id: u.id, name: u.name, role: u.role }));
  function startSession(res, user, proof, act, sid = randomBytes(8).toString('hex')) {
    const extra = { testerId: proof.testerId || null, testerName: proof.testerName || null, super: !!proof.super, sid };
    act.session = extra;
    return json(res, 200, { user: { id: user.id, name: user.name, role: user.role }, tester: publicTester(extra), super: extra.super },
      { 'set-cookie': cookie(sessionToken(user.id, config.secret, 28800, extra), 28800) });
  }
  /* The view is built for the demo user; the cookie adds who really holds the device. */
  const decorate = (view, session) => ({ ...view, tester: publicTester(session) || { id: null, name: 'Compartido', super: false }, demoMode: config.demoMode !== false });
  /* ---- Página /super: acceso propio (PIN de super admin + SUPER_KEY) con una cookie aparte de una hora ---- */
  const SUPER_TTL = 3600;
  const superCookie = (token, maxAge) => `iae_super=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${maxAge}${config.secure ? '; Secure' : ''}`;
  const superToken = (tester, sid) => signToken({ kind: 'super', testerId: tester.id, testerName: tester.name, sid }, config.secret, SUPER_TTL);
  async function superSession(req) {
    const v = verifyToken(cookieValue(req.headers.cookie, 'iae_super'), config.secret);
    if (!v || v.kind !== 'super') return null;
    const access = await testerAccess(db, v.testerId);
    return access && access.super && tokenCurrent(v, access) ? v : null;
  }

  async function api(req, res, path, act, url) {
    /* Public health says only that the process answers; revision and database kind need a session. */
    if (path === 'health') {
      const known = (await sessionUser(req)) || (await superSession(req));
      return json(res, 200, known ? { ok: true, db: db.kind, revision: await getRevision(db) } : { ok: true });
    }
    /* Step one: the PIN alone says who the tester is. Step two picks the demo user with the proof. */
    if (path === 'auth/pin' && req.method === 'POST') {
      const input = await readBody(req);
      const now = deps.now();
      const ipKey = 'pinguess:' + clientIp(req);
      if (await attemptsBlocked(db, { ip: ipKey, limit: PIN_GUESS_LIMIT }, now)) return json(res, 429, { error: 'too_many_attempts' });
      const tester = await resolvePin(input.pin);
      if (tester === undefined) { await recordLoginFailure(db, [ipKey], now); return json(res, 401, { error: 'invalid_credentials' }); }
      act.session = { testerId: tester ? tester.id : null, super: !!(tester && tester.super) };
      const token = pinToken(tester, config.secret);
      return json(res, 200, { tester: publicTester(verifyPinToken(token, config.secret)), pinToken: token, options: await userOptions(tester ? tester.allowedUsers : null) });
    }
    if (path === 'auth/login' && req.method === 'POST') {
      const input = await readBody(req);
      const now = deps.now();
      /* A typed PIN shares the step-one counter (`pinguess:`); a PIN token cannot be guessed and has its own. */
      const ipKey = (input.pinToken ? 'login:' : 'pinguess:') + clientIp(req), userKey = 'user:' + String(input.userId || '');
      const limit = input.pinToken ? undefined : PIN_GUESS_LIMIT;
      if (await attemptsBlocked(db, { ip: ipKey, user: userKey, limit }, now)) return json(res, 429, { error: 'too_many_attempts' });
      const user = input.userId ? await getUser(db, String(input.userId)) : null;
      let proof = null, token = null;
      if (user && user.active) {
        if (input.pinToken) proof = token = verifyPinToken(input.pinToken, config.secret);
        else { const tester = await resolvePin(input.pin); proof = tester === undefined ? null : { testerId: tester ? tester.id : null, testerName: tester ? tester.name : null, super: !!(tester && tester.super) }; }
      }
      let access = null;
      if (proof && proof.testerId) {
        access = await testerAccess(db, proof.testerId);
        /* A PIN token issued before a logout or a new PIN no longer proves anything. */
        if (!access || !access.active || (token && !tokenCurrent(token, access))) proof = null;
      }
      if (!proof) { await recordLoginFailure(db, [ipKey, userKey], now); return json(res, 401, { error: 'invalid_credentials' }); }
      /* The PIN was right: not a guess, so no failure is counted, and the token stays usable for another user. */
      if (!allowsUser(access, user.id)) return json(res, 403, { error: 'user_not_allowed' });
      if (token && !(await consumeTokenId(db, token.jti, now))) { await recordLoginFailure(db, [ipKey, userKey], now); return json(res, 401, { error: 'invalid_credentials' }); }
      await clearLoginFailures(db, [userKey]);
      act.user = user; act.session = { testerId: proof.testerId || null, super: !!proof.super };
      const sid = randomBytes(8).toString('hex');
      /* A tester came in (not the shared PIN, not the super admin themselves): notice to the /super devices, 3 s at most. */
      if (proof.testerId && !proof.super) {
        await alertTesterLogin(deps, { tester: { id: proof.testerId, name: proof.testerName }, user, sid, ip: clientIp(req), ua: userAgent(req), geo: geoOf(req), now });
      }
      return startSession(res, user, proof, act, sid);
    }
    /* Logout closes every session of that tester, on every device (tokens are not stored one by one). */
    if (path === 'auth/logout' && req.method === 'POST') {
      const a = await sessionUser(req);
      if (a) { act.user = a.user; act.session = a.session; if (a.session.testerId) await revokeTesterSessions(db, a.session.testerId); }
      return json(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) });
    }

    if (path === 'auth/super' && req.method === 'POST') {
      /* A SUPER_KEY too short to trust closes /super without spending any PIN work. */
      if (config.superKeyError) return json(res, 503, { error: config.superKeyError });
      const input = await readBody(req);
      const now = deps.now();
      const ipKey = 'super:' + clientIp(req);
      if (await attemptsBlocked(db, { ip: ipKey }, now)) return json(res, 429, { error: 'too_many_attempts' });
      /* The PIN is always checked, right key or not, so the answer time says nothing about the key. */
      const tester = await findTesterByPin(db, String(input.pin == null ? '' : input.pin), config.secret);
      const keyOk = !!config.superKey && constantEquals(String(input.key == null ? '' : input.key), config.superKey);
      if (!tester || !tester.super || !keyOk) { await recordLoginFailure(db, [ipKey], now); return json(res, 401, { error: 'invalid_credentials' }); }
      const sid = randomBytes(8).toString('hex');
      act.session = { testerId: tester.id, testerName: tester.name, super: true, sid };
      return json(res, 200, { tester: { id: tester.id, name: tester.name } }, { 'set-cookie': superCookie(superToken(tester, sid), SUPER_TTL) });
    }
    if (path === 'auth/super/logout' && req.method === 'POST') {
      const sup = await superSession(req);
      if (sup) { act.session = { testerId: sup.testerId, testerName: sup.testerName, super: true, sid: sup.sid }; await revokeTesterSessions(db, sup.testerId); }
      return json(res, 200, { ok: true }, { 'set-cookie': superCookie('', 0) });
    }
    /* Lecturas del panel y gestión de probadores: solo con la cookie del super admin, nunca con la sesión de la app. */
    if (path.startsWith('activity/') || path.startsWith('super/')) {
      const sup = await superSession(req);
      if (!sup) return json(res, 401, { error: 'super_required' });
      act.session = { testerId: sup.testerId, testerName: sup.testerName, super: true, sid: sup.sid };
      if (req.method === 'GET') {
        const f = Object.fromEntries(url.searchParams);
        if (path === 'activity/me') return json(res, 200, { tester: { id: sup.testerId, name: sup.testerName }, users: await userOptions() });
        if (path === 'activity/summary') return json(res, 200, await summary(db, f, deps.now()));
        if (path === 'activity/events') return json(res, 200, await activityEvents(db, f));
        if (path === 'activity/testers') return json(res, 200, await listTesters(db));
        /* Avisos en el celular: la clave pública viaja al navegador; sin claves VAPID la función está apagada. */
        if (path === 'super/push/config') {
          if (!pushEnabled(deps)) return json(res, 200, { enabled: false });
          const c = await subscriptionCounts(db, sup.testerId);
          return json(res, 200, { enabled: true, publicKey: config.vapidPublicKey, subscribed: c.mine > 0, devices: c.devices });
        }
        if (path === 'activity/export.csv') {
          const csv = await exportCsv(db, f);
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="actividad.csv"', 'cache-control': 'no-store' });
          return res.end('\ufeff' + csv);
        }
      }
      if (req.method === 'POST') {
        const input = await readBody(req);
        const now = deps.now();
        if (path.startsWith('super/push/')) {
          if (!pushEnabled(deps)) return json(res, 409, { error: 'push_not_configured' });
          if (path === 'super/push/subscribe') {
            const subscription = cleanSubscription(input.subscription);
            if (!subscription) return json(res, 400, { error: 'invalid_subscription' });
            await saveSubscription(db, { testerId: sup.testerId, subscription, ua: userAgent(req), now });
            return json(res, 200, { ok: true, devices: (await subscriptionCounts(db, sup.testerId)).devices });
          }
          if (path === 'super/push/unsubscribe') return json(res, 200, { removed: await removeSubscription(db, input.endpoint) });
          if (path === 'super/push/test') {
            const endpoint = input.endpoint ? String(input.endpoint) : null;
            const r = await sendTestNotice(deps, { sup, endpoint, now, ip: clientIp(req), ua: userAgent(req) });
            return json(res, 200, { sent: r.sent, removed: r.removed, failed: r.failed, ...(r.error ? { error: r.error } : {}) });
          }
          return json(res, 404, { error: 'not_found' });
        }
        /* Huella del propio navegador del super admin (Task 15): misma lista blanca que la de los probadores
           (ver activity.js), guardada a mano como un `session_start` de cliente porque esta sesión no lleva
           la cookie de la app (`ingestClientEvents` la exige). No pasa por `recordRequest` (classify la ignora). */
        if (path === 'super/fp') {
          const data = sanitizeFingerprint(input.fp);
          await recordServerEvent(db, {
            at: now, testerId: sup.testerId, userId: null, role: 'super', sid: sup.sid, source: 'client', kind: 'session_start', name: 'super',
            screen: null, target: null, durationMs: null, ok: true, error: null, status: null, revision: null,
            ip: clientIp(req), ua: userAgent(req), data, fp: data && typeof data.fp === 'string' ? String(data.fp).slice(0, 64) : null,
          });
          return json(res, 200, { ok: true });
        }
        const audit = (summary) => insertAudit(db, { at: now, actorUserId: null, actorRole: 'super', actorName: 'Super admin (' + sup.testerName + ')', command: path, channel: 'super', summary });
        if (path === 'super/regenerate') {
          const t = await regenerateTesterPin(db, String(input.testerId || ''), config.secret);
          if (!t) return json(res, 404, { error: 'tester_not_found' });
          await audit('Regeneró el PIN de ' + t.name);
          /* A new PIN closes every session of that tester; the page that asked for its own new PIN stays open. */
          const own = t.id === sup.testerId ? { 'set-cookie': superCookie(superToken({ id: sup.testerId, name: sup.testerName }, sup.sid), SUPER_TTL) } : {};
          return json(res, 200, t, own);
        }
        if (path === 'super/allowed') {
          const t = await getTester(db, String(input.testerId || ''));
          if (!t) return json(res, 404, { error: 'tester_not_found' });
          let ids = null;
          if (input.userIds != null) {
            if (!Array.isArray(input.userIds)) return json(res, 400, { error: 'invalid_user_ids' });
            ids = [...new Set(input.userIds.map((x) => String(x).trim()).filter(Boolean))];
            const known = new Set((await listUsers(db)).map((u) => u.id));
            if (ids.some((id) => !known.has(id))) return json(res, 400, { error: 'unknown_user' });
          }
          const saved = await setAllowedUsers(db, t.id, ids);
          await audit(ids ? 'Limitó a ' + t.name + ' a los usuarios ' + (ids.join(', ') || '(ninguno)') : 'Permitió a ' + t.name + ' entrar con cualquier usuario');
          return json(res, 200, saved);
        }
        if (path === 'super/rename') {
          const name = String(input.name || '').trim().slice(0, 60);
          if (!name) return json(res, 400, { error: 'name_required' });
          const t = await renameTester(db, String(input.testerId || ''), name);
          if (!t) return json(res, 404, { error: 'tester_not_found' });
          await audit('Renombró al probador ' + t.id + ' como ' + name);
          return json(res, 200, t);
        }
        if (path === 'super/purge') {
          const days = Math.min(3650, Math.max(0, Math.round(Number(input.beforeDays)) || 30));
          const deleted = await purgeActivity(db, new Date(now.getTime() - days * 86400000));
          await audit('Borró ' + deleted + ' eventos de actividad anteriores a ' + days + ' días');
          return json(res, 200, { deleted });
        }
      }
      return json(res, 404, { error: 'not_found' });
    }

    /* R1/R4: el sondeo de la vista (cada 3-10 s desde el cliente) es, con mucho, la petición más frecuente.
       Cuando nada cambió basta con la firma HMAC de la cookie (sin consulta) y una lectura de la revisión: ni
       `getUser` ni la comprobación del probador hacen falta para responder 304. Una sesión revocada solo se
       rechaza en el momento en que algo sí cambió (siguiente 200), lo cual es aceptable. Un token con firma
       inválida nunca llega a tocar la base de datos. */
    if (path === 'me/view' && req.method === 'GET') {
      const bare = verifySession(cookieValue(req.headers.cookie, 'iae_session'), config.secret);
      if (!bare || !bare.userId) return json(res, 401, { error: 'authentication_required' });
      const revision = await getRevision(db);
      const etag = `"${revision}"`;
      act.revision = revision;
      if (req.headers['if-none-match'] === etag) { act.name = 'view_304'; res.writeHead(304, { etag, 'cache-control': 'no-store' }); return res.end(); }
      const auth = await sessionUser(req);
      if (!auth) return json(res, 401, { error: 'authentication_required' });
      act.user = auth.user; act.session = auth.session;
      const view = await db.tx((q) => buildView(q, auth.user.id, env()));
      return json(res, 200, { revision, view: decorate(view, auth.session) }, { etag });
    }

    const auth = await sessionUser(req);
    if (!auth) return json(res, 401, { error: 'authentication_required' });
    const { user, session, access } = auth;
    act.user = user; act.session = session;

    /* The user directory is for "Cambiar usuario", already signed in; step one of the login brings its own. */
    if (path === 'auth/options' && req.method === 'GET') return json(res, 200, await userOptions(access && access.allowedUsers));

    /* Eventos del navegador (pantallas, clics, errores JS). El servidor sella quién los manda. */
    if (path === 'telemetry' && req.method === 'POST') {
      const input = await readBody(req);
      const stored = await ingestClientEvents(db, { session, user, ip: clientIp(req), ua: userAgent(req), now: act.startedAt }, input.events);
      return json(res, 200, { ok: true, stored });
    }

    /* Same tester, same session id, another demo user: no PIN again. */
    if (path === 'auth/switch' && req.method === 'POST') {
      const input = await readBody(req);
      const next = input.userId ? await getUser(db, String(input.userId)) : null;
      if (!next || !next.active) return json(res, 404, { error: 'user_not_found' });
      if (!allowsUser(access, next.id)) return json(res, 403, { error: 'user_not_allowed' });
      act.user = next;
      return startSession(res, next, session, act, session.sid);
    }
    if (path.startsWith('attachments/') && req.method === 'GET') {
      const att = await getAttachment(db, path.slice('attachments/'.length));
      if (!att) return json(res, 404, { error: 'not_found' });
      if (!(await db.tx((q) => canSeeAttachment(q, user, att, env())))) return json(res, 403, { error: 'forbidden_attachment' });
      const filename = String(att.name || 'adjunto').replace(/[^A-Za-z0-9._-]/g, '_');
      res.writeHead(200, {
        'content-type': att.mime,
        'cache-control': 'private, max-age=300',
        'content-length': att.size,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'content-disposition': `inline; filename="${filename}"`,
      });
      return res.end(Buffer.from(att.bytes));
    }
    if (path.startsWith('commands/') && req.method === 'POST') {
      const name = path.slice('commands/'.length);
      const input = await readBody(req);
      act.input = input;
      const { result, revision } = await runCommand(deps, { userId: user.id, name, input, channel: 'web' });
      act.revision = revision;
      publish(revision);
      const view = await db.tx((q) => buildView(q, user.id, env()));
      return json(res, 200, { ok: true, result, revision, view: decorate(view, session) }, { etag: `"${revision}"` });
    }
    if (path === 'events' && req.method === 'GET' && !config.serverless) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'connected', revision: await getRevision(db) })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    return json(res, 404, { error: 'not_found' });
  }

  async function serveStatic(req, res, pathname) {
    let file = null;
    if (pathname === '/' || pathname === '/index.html') file = join(ROOT, 'public', 'index.html');
    else if (pathname === '/super' || pathname === '/super.html') file = join(ROOT, 'public', 'super.html');
    /* The installable /super: manifest and service worker from the site root (vercel.json sets the same headers). */
    else if (pathname === '/super-manifest.webmanifest' || pathname === '/super-sw.js') file = join(ROOT, 'public', pathname.slice(1));
    else {
      const m = /^\/(client|icons)\/([A-Za-z0-9_][A-Za-z0-9_.-]*)$/.exec(pathname);
      if (m) file = join(ROOT, 'public', m[1], m[2]);
    }
    if (!file) return json(res, 404, { error: 'not_found' });
    try {
      const data = await readFile(file);
      /* Weak ETag over the bytes: cheap to compute, lets a browser (or vercel.json's own `no-cache`) skip the
         download when nothing changed instead of re-fetching the whole file on every page load (R6). */
      const etag = 'W/"' + createHash('sha1').update(data).digest('hex').slice(0, 16) + '"';
      const extra = pathname === '/super-sw.js' ? { 'service-worker-allowed': '/' } : {};
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'no-cache', ...extra }); return res.end(); }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', etag, ...extra });
      res.end(data);
    } catch { json(res, 404, { error: 'not_found' }); }
  }

  const userAgent = (req) => String(req.headers['user-agent'] || '').slice(0, 200);
  /* Cada petición /api/* deja un evento con quién, qué, cuánto tardó y cómo terminó. */
  async function recordRequest(req, path, act, startedAt, startedMs, res) {
    const c = classify(path, req.method);
    /* A 304 poll every 3 s per device says nothing new: skipping it keeps the log (and Neon writes) small. */
    if (!c || act.name === 'view_304') return;
    const status = res.statusCode || 0;
    const ok = status < 400;
    const kind = c.kind === 'login' && !ok ? 'login_failed' : c.kind;
    /* Anonymous polls (a 401 before logging in) are noise, not activity. Failed logins do count. */
    if (!act.user && !['login', 'login_failed', 'pin', 'super_login', 'super_logout', 'super_action'].includes(kind)) return;
    const s = act.session || {};
    /* Desde dónde y con qué se conecta cada probador (Task 15): la geolocalización aproximada (solo existe
       en Vercel) se guarda junto al resto de `data` en los eventos que cuentan como "entrar" o "cambiar de
       usuario", no en cada petición (sería ruido y repetiría lo mismo cientos de veces por sesión). */
    const geo = ['login', 'login_failed', 'pin', 'switch_user', 'super_login'].includes(kind) ? geoOf(req) : null;
    const base = act.input ? maskInput(act.input) : null;
    await recordServerEvent(db, {
      at: startedAt, testerId: s.testerId || null, userId: act.user ? act.user.id : null, role: act.user ? act.user.role : null, sid: s.sid || null,
      source: 'server', kind, name: act.name || c.name, screen: null, target: null, durationMs: Math.round(performance.now() - startedMs),
      ok, error: act.error || null, status, revision: act.revision == null ? null : act.revision, ip: clientIp(req), ua: userAgent(req),
      data: geo ? { ...(base || {}), geo } : base,
    });
  }
  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const path = isApi ? (url.searchParams.get('path') || url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '') : null;
    const startedAt = deps.now(), startedMs = performance.now();
    const act = { startedAt };
    try {
      if (isApi) return await api(req, res, path, act, url);
      if (config.serverless) return json(res, 404, { error: 'not_found' });
      return await serveStatic(req, res, url.pathname);
    } catch (e) {
      const status = e.status || (e instanceof SyntaxError ? 400 : 500);
      act.error = status === 500 ? 'internal_error' : e.code || e.message;
      if (status === 500) { console.error(e); return json(res, 500, { error: 'internal_error', message: null }); }
      return json(res, status, { error: e.code || e.message, message: e.detail || null });
    } finally {
      if (isApi) { if (!act.error && res.statusCode >= 400) act.error = res.errorCode || null; await recordRequest(req, path, act, startedAt, startedMs, res); }
    }
  }
  return { handler, publish };
}
