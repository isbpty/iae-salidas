import { randomBytes } from 'node:crypto';
import { constantEquals, attemptsBlocked, recordLoginFailure } from '../auth.js';
import { listUsers, insertAudit, purgeActivity } from '../db/repo.js';
import { findTesterByPin, listTesters, regenerateTesterPin, renameTester, setAllowedUsers, getTester, revokeTesterSessions } from '../testers.js';
import { summary, events as activityEvents, exportCsv } from '../activity-queries.js';
import { recordServerEvent, sanitizeFingerprint } from '../activity.js';
import { deleteOrphanAttachments } from '../commands/attachments.js';
import { pushEnabled, cleanSubscription, saveSubscription, removeSubscription, subscriptionCounts, sendTestNotice } from '../push.js';
import { NEXT } from './next.js';

/* R7: activity_events (una fila por petición no-304 más los lotes de telemetría) y audit_log (una fila por
   comando) crecen sin límite si nadie entra a /super y pulsa "Purgar" a mano. Cada carga del resumen de
   /super (la página principal del panel) aprovecha para borrar lo viejo, como mucho una vez por hora --
   reclamado atómicamente en app_meta, el mismo patrón que el cooldown de los avisos push (ver push.js,
   claimLoginAlert) -- para no sumarle dos DELETE a cada refresco del panel mientras está abierto. */
const AUTO_PURGE_COOLDOWN_S = 3600;
const ACTIVITY_RETENTION_DAYS = 30;
const AUDIT_RETENTION_DAYS = 180;
/* S9: mismo camino que la purga de actividad -- los adjuntos huérfanos (nunca vinculados a una
   solicitud ni al documento de una persona) de más de 24 h se borran aquí, sin comando ni cron aparte. */
const ORPHAN_ATTACHMENT_HOURS = 24;
async function claimAutoPurge(db, now) {
  const t = Math.floor(now.getTime() / 1000);
  const r = await db.query(`INSERT INTO app_meta(id, value) VALUES ('auto_purge_activity', $1)
    ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value WHERE app_meta.value <= $2 RETURNING value`, [t, t - AUTO_PURGE_COOLDOWN_S]);
  return r.length > 0;
}
async function autoPurgeOldActivity(db, now) {
  if (!(await claimAutoPurge(db, now))) return;
  try {
    await purgeActivity(db, new Date(now.getTime() - ACTIVITY_RETENTION_DAYS * 86400000));
    await db.query('DELETE FROM audit_log WHERE at < $1', [new Date(now.getTime() - AUDIT_RETENTION_DAYS * 86400000).toISOString()]);
    await deleteOrphanAttachments(db, new Date(now.getTime() - ORPHAN_ATTACHMENT_HOURS * 3600000));
  } catch (e) { console.error('purga automática de actividad/auditoría falló:', e.message); }
}

/* C6: la página /super, sacada tal cual de `createApp` (server/app.js): su propio acceso (PIN de super
   admin + SUPER_KEY, cookie `iae_super`), las lecturas del panel (`activity/*`), la gestión de probadores
   y los avisos push (`super/*`). Misma firma `(req, res, ctx)` que las demás rutas; `NEXT` si no es suya. */
export async function superRoutes(req, res, ctx) {
  const { db, config, deps, json, readBody, clientIp, userAgent, userOptions, superSession, superCookie, superToken, SUPER_TTL, path, act, url } = ctx;
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
      if (path === 'activity/summary') {
        const now = deps.now();
        await autoPurgeOldActivity(db, now);
        return json(res, 200, await summary(db, f, now));
      }
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
        const orphans = await deleteOrphanAttachments(db, new Date(now.getTime() - ORPHAN_ATTACHMENT_HOURS * 3600000));
        await audit('Borró ' + deleted + ' eventos de actividad anteriores a ' + days + ' días y ' + orphans + ' adjuntos huérfanos');
        return json(res, 200, { deleted, orphans });
      }
    }
    return json(res, 404, { error: 'not_found' });
  }
  return NEXT;
}
