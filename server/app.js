import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './domain/errors.js';
import { randomBytes } from 'node:crypto';
import { cookieValue, sessionToken, verifySession, pinToken, verifyPinToken, signToken, verifyToken } from './session.js';
import { constantEquals, loginBlocked, recordLoginFailure, clearLoginFailures } from './auth.js';
import { listUsers, getUser, getRevision, getAttachment, insertAudit, purgeActivity } from './db/repo.js';
import { findTesterByPin, listTesters, regenerateTesterPin, renameTester } from './testers.js';
import { summary, events as activityEvents, exportCsv } from './activity-queries.js';
import { classify, maskInput, recordServerEvent, ingestClientEvents } from './activity.js';
import { runCommand } from './commands/run.js';
import { buildView } from './projections/index.js';
import { canSeeAttachment } from './projections/access.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

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
  async function sessionUser(req) {
    const session = verifySession(cookieValue(req.headers.cookie, 'iae_session'), config.secret);
    if (!session) return null;
    const user = await getUser(db, session.userId);
    return user && user.active ? { user, session } : null;
  }
  /* A PIN names a tester, or is the shared pilot PIN (tester null), or is wrong (undefined). */
  async function resolvePin(pin) {
    const value = String(pin == null ? '' : pin);
    if (config.sharedPin && constantEquals(value, config.pin)) return null;
    return (await findTesterByPin(db, value)) || undefined;
  }
  const publicTester = (t) => (t && t.testerId ? { id: t.testerId, name: t.testerName, super: !!t.super } : null);
  const userOptions = async () => (await listUsers(db)).map((u) => ({ id: u.id, name: u.name, role: u.role }));
  function startSession(res, user, proof, act, sid = randomBytes(8).toString('hex')) {
    const extra = { testerId: proof.testerId || null, testerName: proof.testerName || null, super: !!proof.super, sid };
    act.session = extra;
    return json(res, 200, { user: { id: user.id, name: user.name, role: user.role }, tester: publicTester(extra), super: extra.super },
      { 'set-cookie': cookie(sessionToken(user.id, config.secret, 28800, extra), 28800) });
  }
  /* The view is built for the demo user; the cookie adds who really holds the device. */
  const decorate = (view, session) => ({ ...view, tester: publicTester(session) || { id: null, name: 'Compartido', super: false } });
  /* ---- Página /super: acceso propio (PIN de super admin + SUPER_KEY) con una cookie aparte de una hora ---- */
  const SUPER_TTL = 3600;
  const superCookie = (token, maxAge) => `iae_super=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${maxAge}${config.secure ? '; Secure' : ''}`;
  const superSession = (req) => { const v = verifyToken(cookieValue(req.headers.cookie, 'iae_super'), config.secret); return v && v.kind === 'super' ? v : null; };

  async function api(req, res, path, act, url) {
    if (path === 'health') return json(res, 200, { ok: true, db: db.kind, revision: await getRevision(db) });
    if (path === 'auth/options' && req.method === 'GET') return json(res, 200, await userOptions());
    /* Step one: the PIN alone says who the tester is. Step two picks the demo user with the proof. */
    if (path === 'auth/pin' && req.method === 'POST') {
      const input = await readBody(req);
      const now = deps.now();
      const keys = ['ip:' + clientIp(req)];
      if (await loginBlocked(db, keys, now)) return json(res, 429, { error: 'too_many_attempts' });
      const tester = await resolvePin(input.pin);
      if (tester === undefined) { await recordLoginFailure(db, keys, now); return json(res, 401, { error: 'invalid_credentials' }); }
      await clearLoginFailures(db, keys);
      act.session = { testerId: tester ? tester.id : null, super: !!(tester && tester.super) };
      const token = pinToken(tester, config.secret);
      return json(res, 200, { tester: publicTester(verifyPinToken(token, config.secret)), pinToken: token, options: await userOptions() });
    }
    if (path === 'auth/login' && req.method === 'POST') {
      const input = await readBody(req);
      const now = deps.now();
      const keys = ['ip:' + clientIp(req), 'user:' + String(input.userId || '')];
      if (await loginBlocked(db, keys, now)) return json(res, 429, { error: 'too_many_attempts' });
      const user = input.userId ? await getUser(db, String(input.userId)) : null;
      let proof = null;
      if (user && user.active) {
        if (input.pinToken) proof = verifyPinToken(input.pinToken, config.secret);
        else { const tester = await resolvePin(input.pin); proof = tester === undefined ? null : { testerId: tester ? tester.id : null, testerName: tester ? tester.name : null, super: !!(tester && tester.super) }; }
      }
      if (!proof) { await recordLoginFailure(db, keys, now); return json(res, 401, { error: 'invalid_credentials' }); }
      await clearLoginFailures(db, keys);
      act.user = user; act.session = { testerId: proof.testerId || null, super: !!proof.super };
      return startSession(res, user, proof, act);
    }
    if (path === 'auth/logout' && req.method === 'POST') {
      const a = await sessionUser(req);
      if (a) { act.user = a.user; act.session = a.session; }
      return json(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) });
    }

    if (path === 'auth/super' && req.method === 'POST') {
      const input = await readBody(req);
      const now = deps.now();
      const keys = ['ip:' + clientIp(req)];
      if (await loginBlocked(db, keys, now)) return json(res, 429, { error: 'too_many_attempts' });
      const tester = await findTesterByPin(db, String(input.pin == null ? '' : input.pin));
      const keyOk = !!config.superKey && constantEquals(String(input.key == null ? '' : input.key), config.superKey);
      if (!tester || !tester.super || !keyOk) { await recordLoginFailure(db, keys, now); return json(res, 401, { error: 'invalid_credentials' }); }
      await clearLoginFailures(db, keys);
      const sid = randomBytes(8).toString('hex');
      act.session = { testerId: tester.id, testerName: tester.name, super: true, sid };
      return json(res, 200, { tester: { id: tester.id, name: tester.name } }, { 'set-cookie': superCookie(signToken({ kind: 'super', testerId: tester.id, testerName: tester.name, sid }, config.secret, SUPER_TTL), SUPER_TTL) });
    }
    if (path === 'auth/super/logout' && req.method === 'POST') {
      const sup = superSession(req);
      if (sup) act.session = { testerId: sup.testerId, testerName: sup.testerName, super: true, sid: sup.sid };
      return json(res, 200, { ok: true }, { 'set-cookie': superCookie('', 0) });
    }
    /* Lecturas del panel y gestión de probadores: solo con la cookie del super admin, nunca con la sesión de la app. */
    if (path.startsWith('activity/') || path.startsWith('super/')) {
      const sup = superSession(req);
      if (!sup) return json(res, 401, { error: 'super_required' });
      act.session = { testerId: sup.testerId, testerName: sup.testerName, super: true, sid: sup.sid };
      if (req.method === 'GET') {
        const f = Object.fromEntries(url.searchParams);
        if (path === 'activity/me') return json(res, 200, { tester: { id: sup.testerId, name: sup.testerName }, users: await userOptions() });
        if (path === 'activity/summary') return json(res, 200, await summary(db, f, deps.now()));
        if (path === 'activity/events') return json(res, 200, await activityEvents(db, f));
        if (path === 'activity/testers') return json(res, 200, await listTesters(db));
        if (path === 'activity/export.csv') {
          const csv = await exportCsv(db, f);
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="actividad.csv"', 'cache-control': 'no-store' });
          return res.end('\ufeff' + csv);
        }
      }
      if (req.method === 'POST') {
        const input = await readBody(req);
        const now = deps.now();
        const audit = (summary) => insertAudit(db, { at: now, actorUserId: null, actorRole: 'super', actorName: 'Super admin (' + sup.testerName + ')', command: path, channel: 'super', summary });
        if (path === 'super/regenerate') {
          const t = await regenerateTesterPin(db, String(input.testerId || ''));
          if (!t) return json(res, 404, { error: 'tester_not_found' });
          await audit('Regeneró el PIN de ' + t.name);
          return json(res, 200, t);
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

    const auth = await sessionUser(req);
    if (!auth) return json(res, 401, { error: 'authentication_required' });
    const { user, session } = auth;
    act.user = user; act.session = session;

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
      act.user = next;
      return startSession(res, next, session, act, session.sid);
    }
    if (path === 'me/view' && req.method === 'GET') {
      const revision = await getRevision(db);
      const etag = `"${revision}"`;
      act.revision = revision;
      if (req.headers['if-none-match'] === etag) { act.name = 'view_304'; res.writeHead(304, { etag, 'cache-control': 'no-store' }); return res.end(); }
      const view = await db.tx((q) => buildView(q, user.id, env()));
      return json(res, 200, { revision, view: decorate(view, session) }, { etag });
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

  async function serveStatic(res, pathname) {
    let file = null;
    if (pathname === '/' || pathname === '/index.html') file = join(ROOT, 'public', 'index.html');
    else if (pathname === '/super' || pathname === '/super.html') file = join(ROOT, 'public', 'super.html');
    else {
      const m = /^\/client\/([A-Za-z0-9_][A-Za-z0-9_.-]*)$/.exec(pathname);
      if (m) file = join(ROOT, 'public', 'client', m[1]);
    }
    if (!file) return json(res, 404, { error: 'not_found' });
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
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
    await recordServerEvent(db, {
      at: startedAt, testerId: s.testerId || null, userId: act.user ? act.user.id : null, role: act.user ? act.user.role : null, sid: s.sid || null,
      source: 'server', kind, name: act.name || c.name, screen: null, target: null, durationMs: Math.round(performance.now() - startedMs),
      ok, error: act.error || null, status, revision: act.revision == null ? null : act.revision, ip: clientIp(req), ua: userAgent(req),
      data: act.input ? maskInput(act.input) : null,
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
      return await serveStatic(res, url.pathname);
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
