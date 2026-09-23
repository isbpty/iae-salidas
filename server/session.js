import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
const sign = (payload, secret) => createHmac('sha256', secret).update(payload).digest('base64url');

/* Any JSON payload, signed, with its issue time and an expiry. Session cookies and the short-lived PIN token share this.
   `iat` is in seconds with a millisecond fraction (RFC 7519 allows it): a tester's `sessions_valid_after` can then
   revoke a token issued one millisecond earlier without also refusing a login made right after the revocation. */
export function signToken(value, secret, ttlSeconds) {
  const nowMs = Date.now();
  const payload = encode({ ...value, iat: nowMs / 1000, exp: Math.floor(nowMs / 1000) + ttlSeconds });
  return `${payload}.${sign(payload, secret)}`;
}
export function verifyToken(token, secret) {
  try {
    const [payload, sig] = String(token || '').split('.');
    const expected = sign(payload, secret);
    if (!sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const value = JSON.parse(Buffer.from(payload, 'base64url'));
    return value.exp > Math.floor(Date.now() / 1000) ? value : null;
  } catch { return null; }
}
/* Session: who the demo user is, which real tester holds the device, and the session id (`sid`). */
export function sessionToken(userId, secret, ttlSeconds = 8 * 3600, extra = {}) { return signToken({ userId, ...extra }, secret, ttlSeconds); }
export const verifySession = verifyToken;
/* Issue time of a verified token in milliseconds (0 for a token from before `iat` existed). */
export const issuedAtMs = (token) => (token && typeof token.iat === 'number' ? Math.round(token.iat * 1000) : 0);
/* Step one of the login proved a PIN; this token carries that proof to step two for ten minutes, once (`jti`). */
export function pinToken(tester, secret) { return signToken({ kind: 'pin', testerId: tester ? tester.id : null, testerName: tester ? tester.name : null, super: !!(tester && tester.super), jti: randomBytes(12).toString('base64url') }, secret, 600); }
export function verifyPinToken(token, secret) { const v = verifyToken(token, secret); return v && v.kind === 'pin' ? v : null; }
export function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) { const [key, ...rest] = part.trim().split('='); if (key === name) return decodeURIComponent(rest.join('=')); }
  return null;
}
