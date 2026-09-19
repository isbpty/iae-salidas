/* Prueba de carga de extremo a extremo contra la API (local o producción).
   Simula muchos padres a la vez: cada uno inicia sesión, pide su vista, crea una salida por la app
   y vuelve a pedir la vista; recepción aprueba en paralelo. Mide latencias y errores.

   Uso: npm run load:test -- --base https://iaemc2.vercel.app --pin 4321 --parents 50 --rounds 2
   (por defecto: --base http://localhost:3000, --pin del .env, --parents 20, --rounds 1) */
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : dflt; };
const BASE = arg('base', 'http://localhost:3000');
const PIN = arg('pin', process.env.PILOT_PIN || '4321');
const PARENTS = Number(arg('parents', 20));
const ROUNDS = Number(arg('rounds', 1));

const lat = { login: [], view: [], create: [], approve: [] };
const errors = [];
const timed = async (bucket, fn) => { const t0 = performance.now(); try { return await fn(); } catch (e) { errors.push(bucket + ': ' + e.message); return null; } finally { lat[bucket].push(performance.now() - t0); } };
async function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 304) return { status: 304 };
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${json.error || ''}`);
  return { status: res.status, json, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const login = (userId) => timed('login', async () => (await call('/api/auth/login', { method: 'POST', body: { userId, pin: PIN } })).cookie);
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

const options = (await call('/api/auth/options')).json;
const parents = options.filter((u) => u.role === 'parent').slice(0, PARENTS);
const reception = options.find((u) => u.role === 'recepcion');
console.log(`base ${BASE} · ${parents.length} padres · ${ROUNDS} ronda(s)`);
const recCookie = await login(reception.id);
const later = new Date(Date.now() + 30 * 60000); // 30 min: queda pendiente y recepción aprueba

for (let round = 1; round <= ROUNDS; round++) {
  const t0 = performance.now();
  const created = await Promise.all(parents.map(async (p) => {
    const cookie = await login(p.id);
    if (!cookie) return null;
    const v = await timed('view', () => call('/api/me/view', { cookie }));
    const kid = v && v.json.view.students[0];
    if (!kid) return null;
    const date = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, '0')}-${String(later.getDate()).padStart(2, '0')}`;
    const r = await timed('create', () => call('/api/commands/create_salida', { method: 'POST', cookie, body: { studentId: kid.id, date, time: hhmm(later), pickupBy: v.json.view.me.id, reason: 'Prueba de carga' } }));
    await timed('view', () => call('/api/me/view', { cookie, headers: { 'if-none-match': `"${r ? r.json.revision : 0}"` } }));
    return r && r.json.result.status === 'pendiente' ? r.json.result.id : null;
  }));
  const pending = created.filter(Boolean);
  await Promise.all(pending.map((id) => timed('approve', () => call('/api/commands/approve_request', { method: 'POST', cookie: recCookie, body: { requestId: id, pickupPoint: 'Puerta Principal' } }))));
  console.log(`ronda ${round}: ${created.filter(Boolean).length} salidas creadas, ${pending.length} aprobadas por recepción en ${Math.round(performance.now() - t0)} ms`);
}
for (const [k, v] of Object.entries(lat)) if (v.length) console.log(`${k.padEnd(8)} n=${v.length}  p50=${pct(v, 0.5)} ms  p95=${pct(v, 0.95)} ms  max=${pct(v, 1)} ms`);
console.log(errors.length ? `errores (${errors.length}):\n  ` + errors.slice(0, 10).join('\n  ') : 'sin errores');
