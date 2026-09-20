/* Registro técnico de actividad: una fila por petición al servidor y por evento del cliente.
   Nunca hace fallar la petición que registra. Los datos sensibles se enmascaran antes de guardarse. */
import { insertActivity, insertRows } from './db/repo.js';

const SECRET_KEYS = new Set(['pin', 'pintoken', 'password', 'cedula', 'phone', 'secret']);
const BULK_KEYS = new Set(['database64', 'bytes']);
const MAX_STRING = 200;
const MAX_BATCH = 100;
const MAX_DEPTH = 4;

export function maskInput(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => maskInput(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.toLowerCase();
    if (SECRET_KEYS.has(key)) out[k] = v == null || v === '' ? v : '***';
    else if (BULK_KEYS.has(key)) out[k] = '<' + (typeof v === 'string' ? v.length : (v && v.length) || 0) + ' bytes>';
    else out[k] = maskInput(v, depth + 1);
  }
  return out;
}

/* Which API paths get a server event, and how it is named. `null` = not recorded (noise or long-lived). */
export function classify(path, method) {
  if (path === 'auth/pin') return { kind: 'pin', name: 'auth/pin' };
  if (path === 'auth/login') return { kind: 'login', name: 'auth/login' };
  if (path === 'auth/logout') return { kind: 'logout', name: 'auth/logout' };
  if (path === 'auth/switch') return { kind: 'switch_user', name: 'auth/switch' };
  if (path === 'me/view') return { kind: 'view', name: 'view' };
  if (path.startsWith('commands/')) return { kind: 'command', name: path.slice('commands/'.length) };
  if (path.startsWith('attachments/')) return { kind: 'attachment', name: path.slice('attachments/'.length) };
  if (path === 'health' || path === 'auth/options' || path === 'telemetry' || path === 'events' || path.startsWith('activity')) return null;
  return { kind: 'other', name: method + ' ' + path };
}

export async function recordServerEvent(db, ev) {
  try { await insertActivity(db, ev); } catch (e) { console.error('activity: evento perdido:', e.message); }
}

const str = (v, max) => (v == null ? null : String(v).slice(0, max));
const int = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? Math.min(n, 2147483647) : null; };
const DAY = 86400000;

/* Eventos del navegador: el servidor decide quién es (cookie), el cliente solo dice qué pasó. */
export async function ingestClientEvents(db, { session, user, ip, ua, now }, events) {
  const list = Array.isArray(events) ? events.slice(0, MAX_BATCH) : [];
  const rows = list.filter((e) => e && typeof e === 'object' && typeof e.kind === 'string').map((e) => {
    const clientAt = Number(e.at);
    const at = Number.isFinite(clientAt) && Math.abs(clientAt - now.getTime()) < DAY ? new Date(clientAt) : now;
    return {
      at, testerId: session.testerId || null, userId: user.id, role: user.role, sid: session.sid || null, source: 'client',
      kind: str(e.kind, 40), name: str(e.name, 120), screen: str(e.screen, 80), target: str(e.target, 120),
      durationMs: int(e.durationMs), ok: e.ok == null ? null : !!e.ok, error: str(e.error, 300), status: null, revision: null,
      ip, ua, data: e.data && typeof e.data === 'object' ? maskInput(e.data) : null,
    };
  });
  if (rows.length) await insertRows(db, 'activity_events', rows);
  return rows.length;
}
