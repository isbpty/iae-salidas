import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './domain/errors.js';
import { randomBytes, createHash } from 'node:crypto';
import { cookieValue, sessionToken, verifySession, signToken, verifyToken, issuedAtMs } from './session.js';
import { constantEquals } from './auth.js';
import { listUsers, getUser, getRevision } from './db/repo.js';
import { findTesterByPin, testerAccess, allowsUser } from './testers.js';
import { classify, maskInput, recordServerEvent, clientInfo } from './activity.js';
import { authRoutes } from './routes/auth.js';
import { superRoutes } from './routes/super.js';
import { appRoutes } from './routes/app.js';
import { NEXT } from './routes/next.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json; charset=utf-8' };
/* S11: mismo CSP que vercel.json (que sirve los estáticos en producción) para que un servidor local o de
   pruebas responda igual. `style-src 'unsafe-inline'` porque las páginas usan atributos `style="…"` en
   línea; `img-src … blob:` por los QR dibujados en <canvas>/data URL; `worker-src` por el service worker
   de /super; solo se manda con páginas HTML, nunca con JS/CSS/JSON. */
const CSP = "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'";

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
  const userAgent = (req) => String(req.headers['user-agent'] || '').slice(0, 200);
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

  /* C6: las rutas viven en server/routes/ (auth.js, super.js, app.js), todas con la firma `(req, res, ctx)`.
     Los ayudantes de arriba se arman una sola vez aquí; cada petición solo les suma `path`, `act` y `url`. */
  const shared = { db, config, deps, json, readBody, cookie, clientIp, userAgent, geoOf, tokenCurrent, sessionUser, resolvePin, publicTester, userOptions, startSession, decorate, env, publish, clients, SUPER_TTL, superCookie, superToken, superSession };
  const ROUTES = [authRoutes, superRoutes, appRoutes];
  async function api(req, res, path, act, url) {
    /* Public health says only that the process answers; revision and database kind need a session. */
    if (path === 'health') {
      const known = (await sessionUser(req)) || (await superSession(req));
      return json(res, 200, known ? { ok: true, db: db.kind, revision: await getRevision(db) } : { ok: true });
    }
    const ctx = { ...shared, path, act, url };
    for (const route of ROUTES) {
      const handled = await route(req, res, ctx);
      if (handled !== NEXT) return handled;
    }
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
      const extra = { ...(pathname === '/super-sw.js' ? { 'service-worker-allowed': '/' } : {}), ...(extname(file) === '.html' ? { 'content-security-policy': CSP } : {}) };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'no-cache', ...extra }); return res.end(); }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', etag, ...extra });
      res.end(data);
    } catch { json(res, 404, { error: 'not_found' }); }
  }

  /* Cada petición /api/* deja un evento con quién, qué, cuánto tardó y cómo terminó. */
  async function recordRequest(req, path, act, startedAt, startedMs, res) {
    const c = classify(path, req.method);
    /* A 304 poll every 3 s per device says nothing new: skipping it keeps the log (and Neon writes) small.
       R8: a 200 also costs an INSERT after the response already left; when it comes from the poll loop
       (public/client/api.js sends `x-iae-poll: 1` on every call except the very first, boot() load) it is
       just as uninteresting as the 304s -- only the initial load of a screen is worth a row. */
    if (!c || act.name === 'view_304' || (c.kind === 'view' && req.headers['x-iae-poll'] === '1')) return;
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
      return json(res, status, { error: e.code || e.message, message: e.detail || null, ...(e.extra || {}) });
    } finally {
      if (isApi) { if (!act.error && res.statusCode >= 400) act.error = res.errorCode || null; await recordRequest(req, path, act, startedAt, startedMs, res); }
    }
  }
  return { handler, publish };
}
