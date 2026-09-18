import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './domain/errors.js';
import { cookieValue, sessionToken, verifySession } from './session.js';
import { constantEquals, loginBlocked, recordLoginFailure, clearLoginFailures } from './auth.js';
import { listUsers, getUser, getRevision } from './db/repo.js';
import { runCommand } from './commands/run.js';
import { buildView } from './projections/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export function createApp(deps) {
  const { db, config } = deps;
  const clients = new Set();
  const publish = (revision) => {
    const line = `data: ${JSON.stringify({ type: 'changed', revision })}\n\n`;
    for (const res of clients) res.write(line);
  };
  const env = () => ({ now: deps.now(), transport: deps.transport, gps: deps.gps });
  const json = (res, status, value, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(value));
  };
  const cookie = (token, maxAge) => `iae_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${config.secure ? '; Secure' : ''}`;
  async function readBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 1.5e6) throw new HttpError(413, 'too_large'); }
    return raw ? JSON.parse(raw) : {};
  }
  const clientIp = (req) => String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
  async function sessionUser(req) {
    const session = verifySession(cookieValue(req.headers.cookie, 'iae_session'), config.secret);
    if (!session) return null;
    const user = await getUser(db, session.userId);
    return user && user.active ? user : null;
  }

  async function api(req, res, path) {
    if (path === 'health') return json(res, 200, { ok: true, db: db.kind, revision: await getRevision(db) });
    if (path === 'auth/options' && req.method === 'GET') return json(res, 200, (await listUsers(db)).map((u) => ({ id: u.id, name: u.name, role: u.role })));
    if (path === 'auth/login' && req.method === 'POST') {
      const input = await readBody(req);
      const now = deps.now();
      const keys = ['ip:' + clientIp(req), 'user:' + String(input.userId || '')];
      if (await loginBlocked(db, keys, now)) return json(res, 429, { error: 'too_many_attempts' });
      const user = input.userId ? await getUser(db, String(input.userId)) : null;
      if (!user || !user.active || !constantEquals(String(input.pin == null ? '' : input.pin), config.pin)) {
        await recordLoginFailure(db, keys, now);
        return json(res, 401, { error: 'invalid_credentials' });
      }
      await clearLoginFailures(db, keys);
      return json(res, 200, { user: { id: user.id, name: user.name, role: user.role } }, { 'set-cookie': cookie(sessionToken(user.id, config.secret), 28800) });
    }
    if (path === 'auth/logout' && req.method === 'POST') return json(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) });

    const user = await sessionUser(req);
    if (!user) return json(res, 401, { error: 'authentication_required' });

    if (path === 'me/view' && req.method === 'GET') {
      const revision = await getRevision(db);
      const etag = `"${revision}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'no-store' }); return res.end(); }
      const view = await db.tx((q) => buildView(q, user.id, env()));
      return json(res, 200, { revision, view }, { etag });
    }
    if (path.startsWith('commands/') && req.method === 'POST') {
      const name = path.slice('commands/'.length);
      const input = await readBody(req);
      const { result, revision } = await runCommand(deps, { userId: user.id, name, input, channel: 'web' });
      publish(revision);
      const view = await db.tx((q) => buildView(q, user.id, env()));
      return json(res, 200, { ok: true, result, revision, view }, { etag: `"${revision}"` });
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
    if (pathname === '/' || pathname === '/index.html') file = join(ROOT, 'index.html');
    else {
      const m = /^\/client\/([A-Za-z0-9_][A-Za-z0-9_.-]*)$/.exec(pathname);
      if (m) file = join(ROOT, 'client', m[1]);
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
      if (status === 500) console.error(e);
      return json(res, status, { error: e.code || e.message, message: e.detail || null });
    }
  }
  return { handler, publish };
}
