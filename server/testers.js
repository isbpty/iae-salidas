/* Probadores del piloto: personas reales con un PIN propio. El PIN se guarda solo como hash scrypt
   y se muestra en claro una única vez, al crearlo o regenerarlo. */
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { insertRow, patchRow } from './db/repo.js';
import { camel } from './db/rows.js';

export const TESTER_COUNT = 10;
export function randomPin() { return String(randomInt(0, 1e6)).padStart(6, '0'); }
export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(String(pin), salt, 32).toString('hex')}`;
}
export function verifyPin(pin, stored) {
  const [algo, salt, hash] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const a = scryptSync(String(pin), salt, 32), b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const safe = ({ pinHash, ...t }) => t;
export const listTesters = async (q) => (await q.query('SELECT * FROM testers ORDER BY id')).map((r) => safe(camel(r)));
export const getTester = async (q, id) => { const r = (await q.query('SELECT * FROM testers WHERE id=$1', [id]))[0]; return r ? safe(camel(r)) : null; };
export const countTesters = async (q) => (await q.query('SELECT count(*)::int AS c FROM testers'))[0].c;

/* Crea t1..t10 si no existe ninguno. Devuelve los PINs en claro: es la única vez que se ven. */
export async function createTesters(q, now) {
  if (await countTesters(q)) return [];
  const out = [];
  for (let n = 1; n <= TESTER_COUNT; n++) {
    const pin = randomPin();
    const row = { id: 't' + n, name: n === 1 ? 'Super admin' : 'Probador ' + n, pinHash: hashPin(pin), super: n === 1, active: true, createdAt: now };
    await insertRow(q, 'testers', row);
    out.push({ id: row.id, name: row.name, pin });
  }
  return out;
}
export async function regenerateTesterPin(q, id) {
  const t = await getTester(q, id);
  if (!t) return null;
  const pin = randomPin();
  await patchRow(q, 'testers', id, { pinHash: hashPin(pin) });
  return { id, name: t.name, pin };
}
export async function renameTester(q, id, name) { await patchRow(q, 'testers', id, { name }); return getTester(q, id); }
/* Diez probadores: recorrerlos y verificar cada hash es barato y no revela por tiempo cuál existe. */
export async function findTesterByPin(q, pin) {
  const rows = await q.query('SELECT * FROM testers WHERE active ORDER BY id');
  let found = null;
  for (const r of rows) if (verifyPin(pin, r.pin_hash)) found = safe(camel(r));
  return found;
}
