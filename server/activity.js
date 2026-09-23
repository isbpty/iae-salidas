/* Registro técnico de actividad: una fila por petición al servidor y por evento del cliente.
   Nunca hace fallar la petición que registra (salvo el límite de lotes: ver checkBatchRate). Los datos
   sensibles se enmascaran antes de guardarse. */
import { insertActivity, insertRows } from './db/repo.js';
import { HttpError } from './domain/errors.js';

const SECRET_KEYS = new Set(['pin', 'pintoken', 'password', 'cedula', 'phone', 'secret']);
const BULK_KEYS = new Set(['database64', 'bytes']);
const MAX_STRING = 200;
const MAX_BATCH = 100;
const MAX_DEPTH = 4;
/* S7: tope de tamaño del `data` de un evento del cliente (ya enmascarado). Cuesta poco de más volver a
   serializar: solo se hace una vez, después de maskInput, no por cada clave. */
const MAX_DATA_BYTES = 2048;
/* S7: kinds que el cliente puede mandar por telemetría (ver public/client/telemetry.js y simulator.js).
   Cualquier otro (en particular 'command', que es cómo el propio servidor marca sus acciones) se descarta
   silenciosamente: así un evento falso no puede hacerse pasar por una acción o un error del servidor
   (ver server/activity-queries.js, summary/where, que además filtran por source='server'). */
const CLIENT_KINDS = new Set(['screen_enter', 'screen_leave', 'click', 'js_error', 'promise_rejection', 'visibility', 'simulator']);
const CLIENT_KIND_PREFIXES = ['modal_', 'form_', 'session_'];
const isAllowedClientKind = (kind) => CLIENT_KINDS.has(kind) || CLIENT_KIND_PREFIXES.some((p) => kind.startsWith(p));

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
   agrupar "Dispositivos" por probador con un índice en vez de escanear `data` en cada carga de /super.
   Cada valor va acotado además de la clave: la lista blanca por sí sola no impide que un cliente hostil
   mande, por ejemplo, `platform` con un string de un megabyte o `languages` con miles de entradas. */
const FP_KEYS = new Set([
  'width', 'height', 'lang', 'screenWidth', 'screenHeight', 'devicePixelRatio', 'colorDepth', 'languages',
  'platform', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'tz', 'connection', 'uaData', 'standalone', 'fp',
]);
const UA_DATA_KEYS = new Set(['brands', 'mobile', 'platform']);
const FP_STRING_MAX = 120;
const FP_ARRAY_MAX = 10;
const FP_HEX_RE = /^[0-9a-f]{8,64}$/i;
/* Un valor de huella "razonable": string corto, número finito, booleano, o un array corto de strings
   cortos (p. ej. `navigator.languages`, `uaData.brands`). Cualquier otra forma (objeto anidado salvo
   `uaData`, función, string larguísimo) se descarta en vez de guardarse tal cual. */
function boundFpValue(v) {
  if (typeof v === 'string') return v.slice(0, FP_STRING_MAX);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v == null) return v;
  if (Array.isArray(v)) return v.slice(0, FP_ARRAY_MAX).filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => (typeof x === 'string' ? x.slice(0, FP_STRING_MAX) : x));
  return undefined; // objeto (salvo uaData, aparte) u otra cosa rara: se descarta
}
function boundUaData(v) {
  if (!v || typeof v !== 'object') return undefined;
  const out = {};
  for (const k of Object.keys(v)) { if (!UA_DATA_KEYS.has(k)) continue; const b = boundFpValue(v[k]); if (b !== undefined) out[k] = b; }
  return Object.keys(out).length ? out : undefined;
}
export function sanitizeFingerprint(data) {
  if (!data || typeof data !== 'object') return null;
  const out = {};
  for (const k of Object.keys(data)) {
    if (!FP_KEYS.has(k)) continue;
    const v = k === 'uaData' ? boundUaData(data[k]) : boundFpValue(data[k]);
    if (v !== undefined) out[k] = v;
  }
  if (typeof out.fp === 'string' && !FP_HEX_RE.test(out.fp)) delete out.fp;
  return Object.keys(out).length ? out : null;
}

/* S7: máximo ~30 lotes de telemetría por minuto por `sid`, para que un cliente descontrolado (o hostil) no
   haga crecer activity_events sin límite. Un `Map` en memoria por instancia basta: en Vercel cada instancia
   lleva su propia cuenta, así que el límite real con varias instancias vivas es más alto que 30/min, pero
   sigue acotando el peor caso por instancia (documentado en el README de despliegue). */
const BATCH_WINDOW_MS = 60000;
const MAX_BATCHES_PER_MIN = 30;
const MAX_TRACKED_SIDS = 2000;
const batchWindows = new Map(); // sid -> { start, count }
function checkBatchRate(sid, now) {
  if (!sid) return;
  const t = now.getTime();
  const w = batchWindows.get(sid);
  if (!w || t - w.start >= BATCH_WINDOW_MS) { batchWindows.set(sid, { start: t, count: 1 }); return; }
  w.count += 1;
  if (w.count > MAX_BATCHES_PER_MIN) throw new HttpError(429, 'too_many_batches');
  /* Poda perezosa: evita que el Map crezca sin límite si hay muchos `sid` de un solo uso. */
  if (batchWindows.size > MAX_TRACKED_SIDS) for (const [k, v] of batchWindows) { if (t - v.start >= BATCH_WINDOW_MS) batchWindows.delete(k); }
}

/* R7: `ua` (hasta 200 caracteres) solo se guarda en el primer evento de cada `sid`; el resto de filas de esa
   sesión lo dejan en null (se puede volver a mirar el primero). También en memoria por instancia: el peor
   caso es repetir el `ua` una vez más por instancia nueva, no por cada evento. */
const uaSeenSids = new Set();
const MAX_TRACKED_UA_SIDS = 5000;
export function firstUa(sid, ua) {
  if (!sid) return ua;
  if (uaSeenSids.has(sid)) return null;
  if (uaSeenSids.size >= MAX_TRACKED_UA_SIDS) uaSeenSids.clear();
  uaSeenSids.add(sid);
  return ua;
}

/* Eventos del navegador: el servidor decide quién es (cookie), el cliente solo dice qué pasó.
   S7: un `kind` fuera de la lista blanca (en particular 'command', reservado a las acciones que el propio
   servidor registra) se descarta; ídem un `data` que, ya enmascarado, pese más de 2 KB en JSON (se guarda
   el evento igual, solo que sin `data`). R7: máximo ~30 lotes por minuto por `sid` (429 too_many_batches,
   antes de tocar la base) y `ua` solo en el primer evento de cada `sid`. `session_start` sigue sin tope de
   2 KB (su `data` ya pasa por su propia lista blanca acotada, sanitizeFingerprint) para no perder la huella
   completa del dispositivo. */
export async function ingestClientEvents(db, { session, user, ip, ua, now }, events) {
  checkBatchRate(session && session.sid, now);
  const list = Array.isArray(events) ? events.slice(0, MAX_BATCH) : [];
  const rows = list
    .filter((e) => e && typeof e === 'object' && typeof e.kind === 'string' && isAllowedClientKind(str(e.kind, 40)))
    .map((e) => {
      const clientAt = Number(e.at);
      const at = Number.isFinite(clientAt) && Math.abs(clientAt - now.getTime()) < DAY ? new Date(clientAt) : now;
      const kind = str(e.kind, 40);
      const isSessionStart = kind === 'session_start';
      let data = isSessionStart ? sanitizeFingerprint(e.data) : (e.data && typeof e.data === 'object' ? maskInput(e.data) : null);
      if (!isSessionStart && data != null) { try { if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_DATA_BYTES) data = null; } catch { data = null; } }
      const fp = isSessionStart && data && typeof data.fp === 'string' ? str(data.fp, 64) : null;
      /* `session_start` siempre lleva su `ua`: de ahí sale el navegador/dispositivo que /super muestra
         (deviceLabel en activity-queries.js). El resto de eventos del mismo `sid` (clics, pantallas…) son
         los que se repiten decenas de veces por sesión, así que solo el primero de ellos lo guarda. */
      const rowUa = isSessionStart ? ua : firstUa(session.sid, ua);
      return {
        at, testerId: session.testerId || null, userId: user ? user.id : null, role: user ? user.role : null, sid: session.sid || null, source: 'client',
        kind, name: str(e.name, 120), screen: str(e.screen, 80), target: str(e.target, 120),
        durationMs: int(e.durationMs), ok: e.ok == null ? null : !!e.ok, error: str(e.error, 300), status: null, revision: null,
        ip, ua: rowUa, data, fp,
      };
    });
  if (rows.length) await insertRows(db, 'activity_events', rows);
  return rows.length;
}
