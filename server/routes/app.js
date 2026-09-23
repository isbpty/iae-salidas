import { cookieValue, verifySession } from '../session.js';
import { getRevision, getAttachment } from '../db/repo.js';
import { ingestClientEvents } from '../activity.js';
import { runCommand } from '../commands/run.js';
import { buildView } from '../projections/index.js';
import { canSeeAttachment } from '../projections/access.js';
import { sessionAuthRoutes } from './auth.js';
import { NEXT } from './next.js';

/* C6: las rutas de la app con sesión, sacadas tal cual de `createApp` (server/app.js): la vista
   (`me/view`, con su 304 barato), telemetría, adjuntos, comandos y el canal SSE (`events`). Van al final
   del router: lo que no reconocen termina en 404. */
export async function appRoutes(req, res, ctx) {
  const { db, config, deps, json, readBody, clientIp, userAgent, sessionUser, env, decorate, publish, clients, path, act } = ctx;
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
  const { user, session } = auth;
  act.user = user; act.session = session;

  const handled = await sessionAuthRoutes(req, res, ctx, auth);
  if (handled !== NEXT) return handled;

  /* Eventos del navegador (pantallas, clics, errores JS). El servidor sella quién los manda. */
  if (path === 'telemetry' && req.method === 'POST') {
    const input = await readBody(req);
    const stored = await ingestClientEvents(db, { session, user, ip: clientIp(req), ua: userAgent(req), now: act.startedAt }, input.events);
    return json(res, 200, { ok: true, stored });
  }
  if (path.startsWith('attachments/') && req.method === 'GET') {
    const att = await getAttachment(db, path.slice('attachments/'.length));
    if (!att) return json(res, 404, { error: 'not_found' });
    if (!(await db.tx((q) => canSeeAttachment(q, user, att, env())))) return json(res, 403, { error: 'forbidden_attachment' });
    const filename = String(att.name || 'adjunto').replace(/[^A-Za-z0-9._-]/g, '_');
    /* S9: un PDF no se ve embebido con la CSP `sandbox` de abajo (Chrome lo descarga en vez de mostrarlo
       inerte); servirlo directamente como descarga es más claro que un visor roto. Las imágenes siguen
       `inline` para la vista previa en garita/padres. */
    const disposition = att.mime === 'application/pdf' ? 'attachment' : 'inline';
    res.writeHead(200, {
      'content-type': att.mime,
      'cache-control': 'private, max-age=300',
      'content-length': att.size,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': `${disposition}; filename="${filename}"`,
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
