import { randomBytes } from 'node:crypto';
import { pinToken, verifyPinToken } from '../session.js';
import { attemptsBlocked, recordLoginFailure, clearLoginFailures, consumeTokenId, PIN_GUESS_LIMIT } from '../auth.js';
import { getUser } from '../db/repo.js';
import { testerAccess, revokeTesterSessions, allowsUser } from '../testers.js';
import { alertTesterLogin } from '../push.js';
import { NEXT } from './next.js';

/* C6: rutas de entrada a la app, sacadas tal cual de `createApp` (server/app.js). Firma común
   `(req, res, ctx)`: `ctx` trae los ayudantes que arma `createApp` una vez (json, readBody, cookie,
   sessionUser, …) más `path`/`act`/`url` de la petición. Devuelven `NEXT` si la ruta no es suya. */

/* Sin sesión: paso uno (PIN), paso dos (usuario) y salir. */
export async function authRoutes(req, res, ctx) {
  const { db, config, deps, json, readBody, clientIp, userAgent, geoOf, tokenCurrent, sessionUser, resolvePin, publicTester, userOptions, startSession, cookie, path, act } = ctx;
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
  return NEXT;
}

/* Con sesión (las llama routes/app.js después de comprobarla): el directorio de "Cambiar usuario" y el cambio en sí. */
export async function sessionAuthRoutes(req, res, ctx, auth) {
  const { db, json, readBody, userOptions, startSession, path, act } = ctx;
  const { session, access } = auth;
  /* The user directory is for "Cambiar usuario", already signed in; step one of the login brings its own. */
  if (path === 'auth/options' && req.method === 'GET') return json(res, 200, await userOptions(access && access.allowedUsers));

  /* Same tester, same session id, another demo user: no PIN again. */
  if (path === 'auth/switch' && req.method === 'POST') {
    const input = await readBody(req);
    const next = input.userId ? await getUser(db, String(input.userId)) : null;
    if (!next || !next.active) return json(res, 404, { error: 'user_not_found' });
    if (!allowsUser(access, next.id)) return json(res, 403, { error: 'user_not_allowed' });
    act.user = next;
    return startSession(res, next, session, act, session.sid);
  }
  return NEXT;
}
