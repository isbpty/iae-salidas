import { timingSafeEqual } from 'node:crypto';
const LIMIT = 10;
const WINDOW_MS = 15 * 60 * 1000;

export function constantEquals(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function loginBlocked(q, keys, now) {
  for (const key of keys) {
    const [row] = await q.query('SELECT count, window_start FROM login_attempts WHERE key=$1', [key]);
    if (row && row.count >= LIMIT && now.getTime() - new Date(row.window_start).getTime() < WINDOW_MS) return true;
  }
  return false;
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
