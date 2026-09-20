import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './domain/errors.js';
import { randomBytes } from 'node:crypto';
import { cookieValue, sessionToken, verifySession, pinToken, verifyPinToken } from './session.js';
import { constantEquals, loginBlocked, recordLoginFailure, clearLoginFailures } from './auth.js';
import { listUsers, getUser, getRevision, getAttachment } from './db/repo.js';
import { findTesterByPin } from './testers.js';
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
  function startSession(res, user, proof, sid = randomBytes(8).toString('hex')) {
    const extra = { testerId: proof.testerId || null, testerName: proof.testerName || null, super: !!proof.super, sid };
    return json(res, 200, { user: { id: user.id, name: user.name, role: user.role }, tester: publicTester(extra), super: extra.super },
      { 'set-cookie': cookie(sessionToken(user.id, config.secret, 28800, extra), 28800) });
  }
  /* The view is built for the demo user; the cookie adds who really holds the device. */
  const decorate = (view, session) => ({ ...view, user: { ...view.user, super: !!session.super }, tester: publicTester(session) || { id: null, name: 'Compartido', super: false } });

  async function api(req, res, path) {
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
      return startSession(res, user, proof);
    }
    if (path === 'auth/logout' && req.method === 'POST') return json(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) });

    const auth = await sessionUser(req);
    if (!auth) return json(res, 401, { error: 'authentication_required' });
    const { user, session } = auth;

    /* Same tester, same session id, another demo user: no PIN again. */
    if (path === 'auth/switch' && req.method === 'POST') {
      const input = await readBody(req);
      const next = input.userId ? await getUser(db, String(input.userId)) : null;
      if (!next || !next.active) return json(res, 404, { error: 'user_not_found' });
      return startSession(res, next, session, session.sid);
    }
    if (path === 'me/view' && req.method === 'GET') {
      const revision = await getRevision(db);
      const etag = `"${revision}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'no-store' }); return res.end(); }
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
      const { result, revision } = await runCommand(deps, { userId: user.id, name, input, channel: 'web', super: !!session.super });
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

  async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const path = (url.searchParams.get('path') || url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '');
        return await api(req, res, path);
      }
      if (config.serverless) return json(res, 404, { error: 'not_found' });
      return await serveStatic(res, url.pathname);
    } catch (e) {
      const status = e.status || (e instanceof SyntaxError ? 400 : 500);
      if (status === 500) { console.error(e); return json(res, 500, { error: 'internal_error', message: null }); }
      return json(res, status, { error: e.code || e.message, message: e.detail || null });
    }
  }
  return { handler, publish };
}
