/* Probadores del piloto: personas reales con un PIN propio. El PIN se guarda solo como hash scrypt
   (más un HMAC con SESSION_SECRET para encontrarlo con una lectura) y se muestra en claro una única vez,
   al crearlo o regenerarlo. */
import { createHmac, randomBytes, randomInt, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { insertRow, patchRow } from './db/repo.js';
import { camel } from './db/rows.js';

const scryptAsync = promisify(scrypt);
export const TESTER_COUNT = 10;
export function randomPin() { return String(randomInt(0, 1e6)).padStart(6, '0'); }
export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(String(pin), salt, 32).toString('hex')}`;
}
/* Asynchronous: scrypt runs on the libuv pool instead of freezing every other request (review S5). */
export async function verifyPin(pin, stored) {
  const [algo, salt, hash] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const a = await scryptAsync(String(pin), salt, 32), b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
/* HMAC-SHA256(SESSION_SECRET, pin): finds the row with one indexed read, and works as a pepper (a dump of the
   table cannot be brute-forced without the secret). It never proves the PIN on its own: scrypt still does. */
export function pinLookup(pin, secret) {
  if (!secret) throw new Error('secret_required_for_pin_lookup');
  return createHmac('sha256', secret).update(String(pin)).digest('hex');
}

const safe = ({ pinHash, pinLookup: _lookup, ...t }) => t;
export const listTesters = async (q) => (await q.query('SELECT * FROM testers ORDER BY length(id), id')).map((r) => safe(camel(r)));
export const getTester = async (q, id) => { const r = (await q.query('SELECT * FROM testers WHERE id=$1', [id]))[0]; return r ? safe(camel(r)) : null; };
export const countTesters = async (q) => (await q.query('SELECT count(*)::int AS c FROM testers'))[0].c;

/* A fresh PIN whose lookup no other tester holds (the unique index would refuse it). */
async function freshPin(q, secret) {
  for (;;) {
    const pin = randomPin();
    const lookup = pinLookup(pin, secret);
    if (!(await q.query('SELECT 1 FROM testers WHERE pin_lookup=$1', [lookup])).length) return { pin, lookup };
  }
}

/* Crea t1..t10 si no existe ninguno. Devuelve los PINs en claro: es la única vez que se ven. */
export async function createTesters(q, now, secret) {
  if (await countTesters(q)) return [];
  const out = [];
  for (let n = 1; n <= TESTER_COUNT; n++) {
    const { pin, lookup } = await freshPin(q, secret);
    const row = { id: 't' + n, name: n === 1 ? 'Super admin' : 'Probador ' + n, pinHash: hashPin(pin), pinLookup: lookup, super: n === 1, active: true, createdAt: now };
    await insertRow(q, 'testers', row);
    out.push({ id: row.id, name: row.name, pin });
  }
  return out;
}
/* A new PIN also closes every session the tester had open. */
export async function regenerateTesterPin(q, id, secret) {
  const t = await getTester(q, id);
  if (!t) return null;
  const { pin, lookup } = await freshPin(q, secret);
  await patchRow(q, 'testers', id, { pinHash: hashPin(pin), pinLookup: lookup, sessionsValidAfter: new Date() });
  return { id, name: t.name, pin };
}
export async function renameTester(q, id, name) { await patchRow(q, 'testers', id, { name }); return getTester(q, id); }
/* `userIds`: list of demo user ids the tester may open, or null for all of them. */
export async function setAllowedUsers(q, id, userIds) {
  await q.query('UPDATE testers SET allowed_users=$2 WHERE id=$1', [id, userIds == null ? null : JSON.stringify(userIds)]);
  return getTester(q, id);
}
/* Session tokens issued before this instant stop counting. It uses the wall clock, like the tokens' `iat`. */
export async function revokeTesterSessions(q, id, at = new Date()) {
  await q.query('UPDATE testers SET sessions_valid_after=$2 WHERE id=$1', [id, at.toISOString()]);
}
/* What the router needs to accept a token of this tester: one indexed read by primary key. */
export async function testerAccess(q, id) {
  const r = (await q.query('SELECT active, super, allowed_users, sessions_valid_after FROM testers WHERE id=$1', [id]))[0];
  if (!r) return null;
  return { active: !!r.active, super: !!r.super, allowedUsers: Array.isArray(r.allowed_users) ? r.allowed_users : null, validAfterMs: r.sessions_valid_after ? new Date(r.sessions_valid_after).getTime() : 0 };
}
export const allowsUser = (access, userId) => !access || !access.allowedUsers || access.allowedUsers.includes(userId);

/* One indexed read by the PIN's HMAC and one scrypt to confirm it. Testers created before the lookup existed
   (pin_lookup NULL, see migration 006) are still checked the old way, one by one, and get their lookup
   written on their first successful login; once all have it, a wrong PIN costs no scrypt at all. */
export async function findTesterByPin(q, pin, secret) {
  const value = String(pin == null ? '' : pin);
  const lookup = pinLookup(value, secret);
  const [hit] = await q.query('SELECT * FROM testers WHERE pin_lookup=$1 AND active', [lookup]);
  if (hit && (await verifyPin(value, hit.pin_hash))) return safe(camel(hit));
  for (const r of await q.query('SELECT * FROM testers WHERE pin_lookup IS NULL AND active ORDER BY id')) {
    if (!(await verifyPin(value, r.pin_hash))) continue;
    await q.query('UPDATE testers SET pin_lookup=$1 WHERE id=$2 AND NOT EXISTS (SELECT 1 FROM testers WHERE pin_lookup=$1)', [lookup, r.id]);
    return safe(camel(r));
  }
  return null;
}
