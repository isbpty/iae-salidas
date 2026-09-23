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
  if (path === 'auth/super') return { kind: 'super_login', name: 'auth/super' };
  if (path === 'auth/super/logout') return { kind: 'super_logout', name: 'auth/super/logout' };
  /* La huella del propio panel /super se registra a mano (kind 'session_start') en la ruta que la recibe. */
  if (path === 'super/fp') return null;
  if (path.startsWith('super/')) return { kind: 'super_action', name: path };
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
const decodeUri = (v) => { try { return decodeURIComponent(String(v)); } catch { return String(v); } };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/* IP, user-agent y (solo en Vercel) geolocalización aproximada de una petición, a partir de las cabeceras
   `x-vercel-ip-*` que el edge de Vercel añade. Fuera de serverless (local, tests) esas cabeceras no existen
   y no hay forma honesta de saber dónde está el cliente: `geo` queda `null`. La IP solo se confía en
   `x-forwarded-for` cuando `serverless` es cierto (un listener directo dejaría que cualquiera la falsee). */
export function clientInfo(req, serverless) {
  const direct = (req.socket && req.socket.remoteAddress) || 'unknown';
  const ip = String(serverless ? req.headers['x-forwarded-for'] || direct : direct).split(',')[0].trim();
  const ua = String(req.headers['user-agent'] || '').slice(0, 200);
  return { ip, ua, geo: serverless ? geoFromHeaders(req.headers) : null };
}
function geoFromHeaders(h) {
  const country = h['x-vercel-ip-country'], region = h['x-vercel-ip-country-region'], city = h['x-vercel-ip-city'];
  const lat = h['x-vercel-ip-latitude'], lng = h['x-vercel-ip-longitude'], tz = h['x-vercel-ip-timezone'];
  if (!country && !region && !city && !lat && !lng && !tz) return null;
  return {
    country: country ? str(country, 5) : null,
    region: region ? str(region, 10) : null,
    city: city ? str(decodeUri(city), 80) : null,
    lat: lat != null ? num(lat) : null,
    lng: lng != null ? num(lng) : null,
    tz: tz ? str(tz, 40) : null,
  };
}

/* Huella del dispositivo (`session_start`, ver public/client/telemetry.js y public/client/super.js): lista
   blanca de claves, nada que por sí sola identifique a la persona (sin cookies de terceros, sin canvas
   fingerprinting). `fp` es el hash corto que el cliente ya calculó; se copia a su propia columna para poder
   agrupar "Dispositivos" por probador con un índice en vez de escanear `data` en cada carga de /super. */
const FP_KEYS = new Set([
  'width', 'height', 'lang', 'screenWidth', 'screenHeight', 'devicePixelRatio', 'colorDepth', 'languages',
  'platform', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'tz', 'connection', 'uaData', 'standalone', 'fp',
]);
export function sanitizeFingerprint(data) {
  if (!data || typeof data !== 'object') return null;
  const out = {};
  for (const k of Object.keys(data)) if (FP_KEYS.has(k)) out[k] = data[k];
  return Object.keys(out).length ? out : null;
}

/* Eventos del navegador: el servidor decide quién es (cookie), el cliente solo dice qué pasó. */
export async function ingestClientEvents(db, { session, user, ip, ua, now }, events) {
  const list = Array.isArray(events) ? events.slice(0, MAX_BATCH) : [];
  const rows = list.filter((e) => e && typeof e === 'object' && typeof e.kind === 'string').map((e) => {
    const clientAt = Number(e.at);
    const at = Number.isFinite(clientAt) && Math.abs(clientAt - now.getTime()) < DAY ? new Date(clientAt) : now;
    const kind = str(e.kind, 40);
    const isSessionStart = kind === 'session_start';
    const data = isSessionStart ? sanitizeFingerprint(e.data) : (e.data && typeof e.data === 'object' ? maskInput(e.data) : null);
    const fp = isSessionStart && data && typeof data.fp === 'string' ? str(data.fp, 64) : null;
    return {
      at, testerId: session.testerId || null, userId: user ? user.id : null, role: user ? user.role : null, sid: session.sid || null, source: 'client',
      kind, name: str(e.name, 120), screen: str(e.screen, 80), target: str(e.target, 120),
      durationMs: int(e.durationMs), ok: e.ok == null ? null : !!e.ok, error: str(e.error, 300), status: null, revision: null,
      ip, ua, data, fp,
    };
  });
  if (rows.length) await insertRows(db, 'activity_events', rows);
  return rows.length;
}
