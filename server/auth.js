import { timingSafeEqual } from 'node:crypto';
const LIMIT = 10;
/* Guessing a PIN (step one, or the one-step login with `pin`) shares one counter per address, with room for a
   whole school behind one NAT address; /super and the rest keep 10. */
export const PIN_GUESS_LIMIT = 30;
const WINDOW_MS = 15 * 60 * 1000;

export function constantEquals(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
/* An address that failed this many times inside the window is "suspect" for the per-user counter. */
const SUSPECT = 3;
async function failures(q, key, now) {
  const [row] = await q.query('SELECT count, window_start FROM login_attempts WHERE key=$1', [key]);
  return row && now.getTime() - new Date(row.window_start).getTime() < WINDOW_MS ? row.count : 0;
}
export async function loginBlocked(q, keys, now, limit = LIMIT) {
  for (const key of keys) if ((await failures(q, key, now)) >= limit) return true;
  return false;
}
/* One counter per surface and address (`pinguess:<ip>`, `login:<ip>` for PIN tokens, `super:<ip>`), never cleared
   by a success: a valid PIN must not buy more guesses. The per-user counter (`user:<id>`, 10) only blocks an
   address that is failing too, so a stranger cannot lock somebody else out of their account from afar. */
export async function attemptsBlocked(q, { ip, user, limit = LIMIT }, now) {
  const ipFails = await failures(q, ip, now);
  if (ipFails >= limit) return true;
  return !!user && ipFails >= SUSPECT && (await failures(q, user, now)) >= LIMIT;
}
/* A plain counter of uses (not only failures), e.g. `lookup:<userId>`: true when the limit is already reached,
   otherwise counts this use. */
export async function spendAttempt(q, key, now, limit) {
  if (await loginBlocked(q, [key], now, limit)) return false;
  await recordLoginFailure(q, [key], now);
  return true;
}
/* A PIN token logs in once: its id is kept (as a `jti:` row) for longer than the token lives. Each use also
   sweeps rows whose window is over: expired failure counters restart at 1 anyway. */
export async function consumeTokenId(q, jti, now) {
  if (!jti) return false;
  await q.query("DELETE FROM login_attempts WHERE window_start < $1", [new Date(now.getTime() - WINDOW_MS).toISOString()]);
  const rows = await q.query('INSERT INTO login_attempts(key, count, window_start) VALUES ($1, 0, $2) ON CONFLICT (key) DO NOTHING RETURNING key', ['jti:' + jti, now.toISOString()]);
  return rows.length === 1;
}
export async function recordLoginFailure(q, keys, now) {
  const cutoff = new Date(now.getTime() - WINDOW_MS).toISOString();
  for (const key of keys) {
    await q.query(`INSERT INTO login_attempts(key, count, window_start) VALUES ($1, 1, $2)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN login_attempts.window_start < $3 THEN 1 ELSE login_attempts.count + 1 END,
        window_start = CASE WHEN login_attempts.window_start < $3 THEN $2 ELSE login_attempts.window_start END`, [key, now.toISOString(), cutoff]);
  }
}
export async function clearLoginFailures(q, keys) { for (const key of keys) await q.query('DELETE FROM login_attempts WHERE key=$1', [key]); }
