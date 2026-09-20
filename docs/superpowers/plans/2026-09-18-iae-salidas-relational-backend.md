# IAE Salidas · Relational Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser-only prototype and its JSON "bridge" with a server-owned, PostgreSQL-backed IAE Salidas that runs the same UI on many devices at once, enforcing roles on the server, with WhatsApp kept as a simulated transport.

**Architecture:** One Node ESM service (`server/`) with a hand-written router, transactional commands (`server/commands/`), pure domain modules (`server/domain/`, `server/bot/`), role projections (`server/projections/`) and SQL migrations. PostgreSQL via `pg` (Neon) in production and PGlite (Postgres in WASM) locally and in tests. The existing UI (`views.js`, `styles.css`) is adapted to read a per-role projection from `GET /api/me/view` and to send `POST /api/commands/<name>`; each command response already carries the fresh projection, so the client never needs client-side domain logic.

**Tech Stack:** Node ≥ 20 (ESM, `node:test`, `node:http`), `pg` ^8.23, `@electric-sql/pglite` ^0.3.16, vanilla JS client, Vercel serverless + Neon, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-18-iae-salidas-relational-backend-design.md`

## Global Constraints

- Node `>=20`; `"type": "module"` everywhere under `server/`, `api/` and tests.
- Production dependencies are exactly `pg` and `@electric-sql/pglite`. No framework, no ORM, no test library beyond `node:test` + `node:assert/strict`.
- Roles are the prototype's names, used verbatim in `users.role`, `staff.role` and `role_permissions.role`: `parent`, `admin`, `recepcion`, `profesor`, `garita`, `monitora`.
- All "today"/"now" logic uses the school time zone from `settings.data.timezone` (`America/Panama`); never the browser clock. Every domain function receives `ctx.now` (a `Date`) so tests can pin time.
- Dates are stored as text `YYYY-MM-DD`, wall-clock times as text `HH:MM`, instants as `timestamptz`. Lists inside a row are `jsonb`.
- Every error thrown by domain/commands is an `HttpError` with `status` ∈ {400, 401, 403, 404, 409, 413} and a snake_case `code` in the message. The router maps them to `{ error: code }`.
- All user-facing text stays in Spanish and keeps the exact wording of the prototype (`app.js`) wherever the same message exists.
- Secrets: `SESSION_SECRET` (≥ 32 chars) and `PILOT_PIN` are mandatory; `DATABASE_URL` is mandatory on Vercel and optional locally (PGlite fallback).
- Static files served by the local server are only `/` (→ `public/index.html`) and `/client/<file>` → `public/client/<file>`, where `<file>` has no path separators.
- Tests are run with `npm test` = `node --test "server/**/*.test.js"`. Every task ends with `npm test` green and a commit. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work happens on branch `connected-pilot` in `C:\Users\isaac\OneDrive - Rejovot\Documents\IAESalidas`. Existing files `app.js`, `seed.js`, `views.js`, `styles.css` are the porting sources and are deleted only in the final task.

## Deviations from the spec (decided while planning)

- The client does **not** keep an optimistic patch layer: every command response returns `{ revision, view }`, the client renders it immediately. This removes the reconciliation code the spec described in §10 while keeping the same perceived behaviour (a "guardando…" badge shows during the round trip).
- The spec assigned two rules to database triggers. "A titular cannot also be an authorized person" is enforced in `addAuthorization` (the student is skipped, exactly as the prototype does) and tested. "Max titulares" needs no runtime enforcement because no command creates guardianships; they only come from the seed.
- Every `HttpError` may carry a `detail` (Spanish sentence). The router returns `{ error: code, message: detail }` so the UI can show the same texts the prototype showed in `alert()`.
- `reset_demo` truncates **all** tables except `schema_migrations` and reseeds, so permissions and settings also return to defaults. Simpler and what "Reiniciar" meant in the prototype.
- Migrations are embedded as JS strings (`server/db/schema.js`) instead of `.sql` files, so Vercel's file tracer always bundles them.

## File Structure

| Path | Responsibility |
|---|---|
| `package.json` | scripts `start`, `test`, `reset`; deps `pg`, `@electric-sql/pglite` |
| `server/config.js` | `loadConfig(env)` — validates secrets, picks pg vs PGlite |
| `server/domain/errors.js` | `HttpError`, `deny`, `notFound`, `conflict`, `badRequest` |
| `server/domain/ids.js` | `uid(prefix)` |
| `server/domain/time.js` | `partsIn`, `todayISO`, `nowHHMM`, `shiftISO`, `minutesOf`, `addMinutes`, `localToMs`, `pad` |
| `server/domain/text.js` | Spanish labels + `fmtTime`, `fmtDate`, `fmtClock`, `firstName` |
| `server/db/rows.js` | `camel(row)` snake→camel + Date→ms |
| `server/db/client.js` | `openDb({databaseUrl, dataDir})` → `{ kind, query, exec, tx, close }` |
| `server/db/schema.js` | `MIGRATIONS = [{ version, sql }]` |
| `server/db/migrate.js` | `migrate(db)` |
| `server/db/repo.js` | all SQL accessors used by domain, commands and projections |
| `server/db/seed.js` | `seedDemo(q, { now, tz })`, `resetAll(q)` |
| `server/session.js` | unchanged (`sessionToken`, `verifySession`, `cookieValue`) |
| `server/auth.js` | `checkLoginAllowed`, `recordLoginFailure`, `clearLoginFailures`, `constantEquals` |
| `server/transports/whatsapp.js` | `SimulatorTransport` (writes `chat_messages`) |
| `server/transports/gps.js` | `SimulatedGps.position(route, ctx)` |
| `server/domain/eligibility.js` | `isAuthActive`, `pickupEligibility`, `pickupCandidates`, `authorizedFor`, `studentsOf` |
| `server/domain/autoapprove.js` | `evaluateAutoApprove(ctx, req)` |
| `server/domain/notifications.js` | `notifyPerson`, `notifyRole`, `notifyTeachers`, `notifyStaff`, `logEvent` |
| `server/domain/requests.js` | `createRequest`, `approveRequest`, `rejectRequest`, `acceptExcusa`, `cancelRequest`, `requestConfirmation`, `confirmPickup`, `markExit`, `describePickup` |
| `server/domain/authorizations.js` | `addAuthorization`, `revokeAuthorization` |
| `server/domain/bus.js` | `currentLeg`, `busPosition`, `legStops`, `busStatusFor`, `whereIs`, `markBoarding`, `setTripStatus`, `markNoBus`, `nextLegInfo` |
| `server/bot/nlp.js` | `normalize`, `parseTime`, `parseDate`, `matchKid`, `extractPickupHint`, `detectIntent`, `REL_WORDS` |
| `server/bot/conversation.js` | `handleIncoming(ctx, chatKey, text)` |
| `server/commands/index.js` | `COMMANDS` registry: `{ name: { roles, handler } }` |
| `server/commands/run.js` | `runCommand(deps, { userId, name, input, channel })` |
| `server/commands/*.js` | one file per command group (requests, gate, authorizations, bus, whatsapp, admin) |
| `server/projections/index.js` | `buildView(q, user, env)` dispatching to `parent.js`, `staff.js`, `gate.js`, `monitor.js`, `admin.js` |
| `server/app.js` | `createApp(deps)` → `(req, res) => Promise` router |
| `server/index.js` | local bootstrap: config, db, migrate, seed-if-empty, http server, SSE |
| `server/test-helpers.js` | `makeTestApp({ now })` |
| `api/index.js` | Vercel handler (memoizes db + app, not state) |
| `index.html` | root page, loads `client/*.js` |
| `client/styles.css` | moved from root, unchanged |
| `client/format.js` | browser copies of labels and formatters |
| `client/api.js` | `login`, `logout`, `options`, `view`, `command`, `upload`, `subscribe` |
| `client/state.js` | `V`, `ME`, `UI`, `apply(name, input)`, `refresh()` |
| `client/model.js` | accessors over `V` (`person`, `student`, `studentsOf`, `staffCan`, …) |
| `client/qr.js` | `drawQRs()` |
| `client/views.js` | renderers + event handlers, ported from `views.js` |
| `.github/workflows/ci.yml` | `npm ci && npm test` |
| `vercel.json`, `.vercelignore`, `Dockerfile`, `README.md`, `ARCHITECTURE.md`, `VERCEL-DEPLOY.md` | deployment + docs |

---

### Task 1: Project scaffolding, config, time and error primitives

**Files:**
- Modify: `package.json`
- Create: `server/config.js`, `server/domain/errors.js`, `server/domain/ids.js`, `server/domain/time.js`, `server/domain/text.js`, `server/db/rows.js`
- Test: `server/config.test.js`, `server/domain/time.test.js`, `server/db/rows.test.js`

**Interfaces:**
- Produces: `loadConfig(env) → { secret, pin, databaseUrl, dataDir, port, serverless, secure }`; `HttpError(status, code)`; `uid(prefix)`; `partsIn(now, tz) → { y, m, d, h, mi, date, time }`; `todayISO(now, tz)`; `nowHHMM(now, tz)`; `shiftISO(now, tz, days)`; `minutesOf('HH:MM')`; `addMinutes('HH:MM', n)`; `localToMs(dateISO, hhmm, tz)`; `pad(n)`; `camel(row)`; text helpers.

- [ ] **Step 1: Replace `package.json`**

```json
{
  "name": "iae-salidas",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server/index.js",
    "test": "node --test \"server/**/*.test.js\"",
    "reset": "node -e \"import('node:fs').then(fs=>fs.rmSync('data/pglite',{recursive:true,force:true}))\""
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "@electric-sql/pglite": "^0.3.16",
    "pg": "^8.23.0"
  }
}
```

Then run:

```bash
npm install
```

Expected: `node_modules/@electric-sql/pglite` and `node_modules/pg` exist; `package-lock.json` is created (commit it).

- [ ] **Step 2: Write failing tests for config, time and rows**

`server/config.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

const good = { SESSION_SECRET: 'x'.repeat(32), PILOT_PIN: '4321' };

test('loadConfig requires a long SESSION_SECRET', () => {
  assert.throws(() => loadConfig({ ...good, SESSION_SECRET: 'short' }), /SESSION_SECRET/);
  assert.throws(() => loadConfig({ PILOT_PIN: '1' }), /SESSION_SECRET/);
});

test('loadConfig requires PILOT_PIN', () => {
  assert.throws(() => loadConfig({ SESSION_SECRET: good.SESSION_SECRET }), /PILOT_PIN/);
});

test('loadConfig falls back to PGlite locally but requires DATABASE_URL on Vercel', () => {
  const local = loadConfig(good);
  assert.equal(local.databaseUrl, null);
  assert.equal(local.dataDir, 'data/pglite');
  assert.equal(local.serverless, false);
  assert.throws(() => loadConfig({ ...good, VERCEL: '1' }), /DATABASE_URL/);
  const vercel = loadConfig({ ...good, VERCEL: '1', DATABASE_URL: 'postgres://u:p@h/db' });
  assert.equal(vercel.serverless, true);
  assert.equal(vercel.secure, true);
});
```

`server/domain/time.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { todayISO, nowHHMM, shiftISO, minutesOf, addMinutes, localToMs, partsIn } from './time.js';

const TZ = 'America/Panama'; // UTC-5, no DST
const now = new Date('2026-09-18T15:30:00Z'); // 10:30 in Panama

test('todayISO and nowHHMM use the school time zone', () => {
  assert.equal(todayISO(now, TZ), '2026-09-18');
  assert.equal(nowHHMM(now, TZ), '10:30');
  assert.equal(todayISO(new Date('2026-09-19T03:00:00Z'), TZ), '2026-09-18'); // still the 18th in Panama
});

test('partsIn never returns hour 24', () => {
  assert.equal(partsIn(new Date('2026-09-18T05:00:00Z'), TZ).time, '00:00');
});

test('shiftISO moves whole days', () => {
  assert.equal(shiftISO(now, TZ, 1), '2026-09-19');
  assert.equal(shiftISO(now, TZ, -1), '2026-09-17');
});

test('minutesOf and addMinutes wrap around midnight', () => {
  assert.equal(minutesOf('07:20'), 440);
  assert.equal(addMinutes('23:50', 20), '00:10');
  assert.equal(addMinutes('00:10', -20), '23:50');
});

test('localToMs converts a wall-clock time in the school zone to an instant', () => {
  assert.equal(localToMs('2026-09-18', '10:30', TZ), now.getTime());
});
```

`server/db/rows.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { camel } from './rows.js';

test('camel converts snake_case keys and Date values', () => {
  const at = new Date('2026-09-18T15:30:00Z');
  assert.deepEqual(camel({ student_id: 'e1', created_at: at, bus_legs: ['ida'] }), { studentId: 'e1', createdAt: at.getTime(), busLegs: ['ida'] });
  assert.equal(camel(null), null);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module` for `./config.js`, `./time.js`, `./rows.js`.

- [ ] **Step 4: Implement the primitives**

`server/config.js`:

```js
export function loadConfig(env = process.env) {
  const secret = env.SESSION_SECRET || '';
  if (secret.length < 32) throw new Error('SESSION_SECRET_required_min_32_chars');
  const pin = env.PILOT_PIN || '';
  if (!pin) throw new Error('PILOT_PIN_required');
  const serverless = env.VERCEL === '1';
  const databaseUrl = env.DATABASE_URL || null;
  if (serverless && !databaseUrl) throw new Error('DATABASE_URL_required_on_vercel');
  return {
    secret,
    pin,
    databaseUrl,
    dataDir: env.PGLITE_DIR || 'data/pglite',
    port: Number(env.PORT || 3000),
    serverless,
    secure: serverless || env.NODE_ENV === 'production',
  };
}
```

`server/domain/errors.js`:

```js
/* `code` is the machine-readable snake_case error; `detail` is an optional Spanish sentence for the UI. */
export class HttpError extends Error {
  constructor(status, code, detail = null) { super(code); this.status = status; this.code = code; this.detail = detail; }
}
export const badRequest = (code) => { throw new HttpError(400, code); };
export const unauthorized = (code = 'authentication_required') => { throw new HttpError(401, code); };
export const deny = (code) => { throw new HttpError(403, code); };
export const notFound = (code) => { throw new HttpError(404, code); };
export const conflict = (code) => { throw new HttpError(409, code); };
```

`server/domain/ids.js`:

```js
import { randomUUID } from 'node:crypto';
export const uid = (prefix = '') => prefix + randomUUID().replace(/-/g, '').slice(0, 10);
```

`server/domain/time.js`:

```js
export const pad = (n) => String(n).padStart(2, '0');
const formatters = new Map();
function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  }
  return formatters.get(tz);
}
export function partsIn(now, tz) {
  const p = {};
  for (const part of formatter(tz).formatToParts(now)) p[part.type] = part.value;
  const h = Number(p.hour) % 24;
  return { y: +p.year, m: +p.month, d: +p.day, h, mi: +p.minute, date: `${p.year}-${p.month}-${p.day}`, time: `${pad(h)}:${p.minute}` };
}
export const todayISO = (now, tz) => partsIn(now, tz).date;
export const nowHHMM = (now, tz) => partsIn(now, tz).time;
export function shiftISO(now, tz, days) {
  const p = partsIn(now, tz);
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export function minutesOf(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
export function addMinutes(hhmm, n) {
  const t = ((minutesOf(hhmm) + n) % 1440 + 1440) % 1440;
  return pad(Math.floor(t / 60)) + ':' + pad(t % 60);
}
function offsetMinutes(ms, tz) {
  const p = partsIn(new Date(ms), tz);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - ms) / 60000);
}
export function localToMs(dateISO, hhmm, tz) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  return guess - offsetMinutes(guess, tz) * 60000;
}
export function weekdayOf(dateISO) { return new Date(dateISO + 'T00:00:00Z').getUTCDay(); }
```

`server/domain/text.js` (labels copied verbatim from `app.js:76-84` and `app.js:78`):

```js
import { partsIn, pad, todayISO, shiftISO } from './time.js';

export const ROLE_NAMES = { admin: 'Administración', recepcion: 'Recepción', profesor: 'Profesor', garita: 'Garita de salida', monitora: 'Monitora de bus' };
export const AUTH_TYPES = { siempre: 'Siempre', temporal: 'Por tiempo', una_vez: 'Una vez (con confirmación)' };
export const STATUS = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada', retirado: 'Retirado', cancelada: 'Cancelada', aceptada: 'Aceptada' };
export const CHANNEL = { whatsapp: 'WhatsApp', web: 'App' };
export const LEG_NAMES = { ida: 'ida (mañana)', vuelta: 'vuelta (tarde)' };
export const roleName = (r) => ROLE_NAMES[r] || r;
export const kindLabel = (kind) => (kind === 'titular' ? 'Titular' : AUTH_TYPES[kind] || kind);
export const firstName = (name) => (name || '').split(' ')[0];

export function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return (h % 12 || 12) + ':' + pad(m) + (h >= 12 ? ' pm' : ' am');
}
export function fmtDate(ctx, iso) {
  if (!iso) return '';
  if (iso === todayISO(ctx.now, ctx.tz)) return 'hoy';
  if (iso === shiftISO(ctx.now, ctx.tz, 1)) return 'mañana';
  if (iso === shiftISO(ctx.now, ctx.tz, -1)) return 'ayer';
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('es-PA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
export function fmtClock(ctx, ms) { return fmtTime(partsIn(new Date(ms), ctx.tz).time); }
```

`server/db/rows.js`:

```js
const toCamel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
export function camel(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[toCamel(k)] = v instanceof Date ? v.getTime() : v;
  return out;
}
export const snake = (k) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: the three new files PASS. The old test files under `server/` (`domain.test.js`, `prototype-*.test.js`, `session.test.js`, `postgres-store.test.js`, `whatsapp-bridge.test.js`, `api/index.test.js`) still run and pass because their modules still exist; they are removed in Task 14.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/config.js server/config.test.js server/domain server/db/rows.js server/db/rows.test.js
git commit -m "Add config, time, text and row primitives for the relational backend" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Database client, schema and migrations

**Files:**
- Create: `server/db/client.js`, `server/db/schema.js`, `server/db/migrate.js`
- Test: `server/db/migrate.test.js`

**Interfaces:**
- Produces: `openDb({ databaseUrl, dataDir }) → Db` where `Db = { kind: 'pg'|'pglite', query(sql, params) → rows[], exec(sql), tx(async (q) => …) → result, close() }` and inside `tx` the `q` argument has the same `query`/`exec`. `migrate(db)` applies `MIGRATIONS` once, idempotently.

- [ ] **Step 1: Write the failing test**

`server/db/migrate.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './client.js';
import { migrate } from './migrate.js';

test('migrate creates the schema once and is idempotent', async () => {
  const db = await openDb({});
  await migrate(db);
  await migrate(db);
  const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1")).map((r) => r.table_name);
  for (const t of ['settings', 'app_meta', 'levels', 'staff', 'role_permissions', 'persons', 'students', 'guardianships', 'users', 'attachments', 'authorizations', 'requests', 'request_events', 'pickup_confirmations', 'notifications', 'chat_messages', 'conversation_state', 'routes', 'stops', 'trips', 'trip_boardings', 'bus_opt_outs', 'audit_log', 'login_attempts', 'schema_migrations']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  const applied = await db.query('SELECT version FROM schema_migrations');
  assert.equal(applied.length, 1);
  await db.close();
});

test('tx commits on success and rolls back on error', async () => {
  const db = await openDb({});
  await migrate(db);
  await db.tx(async (q) => { await q.query("INSERT INTO app_meta(id, value) VALUES ('t', 1)"); });
  await assert.rejects(db.tx(async (q) => { await q.query("INSERT INTO app_meta(id, value) VALUES ('u', 2)"); throw new Error('boom'); }), /boom/);
  const rows = await db.query("SELECT id FROM app_meta WHERE id IN ('t','u') ORDER BY id");
  assert.deepEqual(rows.map((r) => r.id), ['t']);
  await db.close();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/db/migrate.test.js`
Expected: FAIL, `Cannot find module './client.js'`.

- [ ] **Step 3: Implement the client**

`server/db/client.js`:

```js
/* One tiny adapter so domain code never knows whether it talks to Neon (pg) or PGlite. */
function wrap(conn, execFn) {
  return {
    query: async (sql, params = []) => (await conn.query(sql, params)).rows,
    exec: async (sql) => { await execFn(sql); },
  };
}

export async function openDb({ databaseUrl, dataDir } = {}) {
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const local = /localhost|127\.0\.0\.1/.test(databaseUrl);
    const pool = new pg.Pool({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: true }, max: 3 });
    return {
      kind: 'pg',
      ...wrap(pool, (sql) => pool.query(sql)),
      tx: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn(wrap(c, (sql) => c.query(sql)));
          await c.query('COMMIT');
          return r;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          throw e;
        } finally { c.release(); }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  await lite.waitReady;
  let chain = Promise.resolve();
  return {
    kind: 'pglite',
    ...wrap(lite, (sql) => lite.exec(sql)),
    tx: (fn) => {
      const run = chain.then(() => lite.transaction((t) => fn(wrap(t, (sql) => t.exec(sql)))));
      chain = run.catch(() => {});
      return run;
    },
    close: () => lite.close(),
  };
}
```

`server/db/schema.js`:

```js
export const MIGRATIONS = [
  {
    version: '001_schema',
    sql: `
CREATE TABLE IF NOT EXISTS settings (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS app_meta (id text PRIMARY KEY, value integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS levels (id text PRIMARY KEY, name text NOT NULL, grades jsonb NOT NULL, position integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS staff (
  id text PRIMARY KEY, name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','recepcion','profesor','garita','monitora')),
  title text, grades jsonb, route_id text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS role_permissions (role text NOT NULL, capability text NOT NULL, allowed boolean NOT NULL DEFAULT false, PRIMARY KEY (role, capability));
CREATE TABLE IF NOT EXISTS attachments (
  id text PRIMARY KEY, owner_person_id text, purpose text NOT NULL CHECK (purpose IN ('cedula','foto','certificado')),
  mime text NOT NULL, bytes bytea NOT NULL, size integer NOT NULL CHECK (size <= 524288), name text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS persons (
  id text PRIMARY KEY, name text NOT NULL, phone text, cedula text, relation text,
  has_account boolean NOT NULL DEFAULT false, doc_name text, doc_attachment_id text REFERENCES attachments(id),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS students (
  id text PRIMARY KEY, name text NOT NULL, grade text NOT NULL, level_id text NOT NULL REFERENCES levels(id), emoji text,
  family_id text, route_id text, stop_id text, bus_legs jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS guardianships (student_id text NOT NULL REFERENCES students(id), person_id text NOT NULL REFERENCES persons(id), PRIMARY KEY (student_id, person_id));
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('person','staff')), ref_id text NOT NULL, name text NOT NULL,
  role text NOT NULL CHECK (role IN ('parent','admin','recepcion','profesor','garita','monitora')),
  active boolean NOT NULL DEFAULT true, UNIQUE (kind, ref_id));
CREATE TABLE IF NOT EXISTS authorizations (
  id text PRIMARY KEY, student_id text NOT NULL REFERENCES students(id), person_id text NOT NULL REFERENCES persons(id),
  type text NOT NULL CHECK (type IN ('siempre','temporal','una_vez')), valid_from text, valid_to text,
  used_at timestamptz, revoked_at timestamptz, created_by text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS requests (
  id text PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('salida','excusa')), student_id text NOT NULL REFERENCES students(id),
  requested_by text NOT NULL, pickup_by text, pickup_kind text, date text NOT NULL, time text, reason text, excusa_type text,
  channel text NOT NULL CHECK (channel IN ('whatsapp','web')),
  status text NOT NULL CHECK (status IN ('pendiente','aprobada','rechazada','retirado','cancelada','aceptada')),
  pickup_point text, code text, decided_by text, decided_at timestamptz, auto_approved boolean NOT NULL DEFAULT false,
  reject_reason text, exit_at timestamptz, exit_by text, attachment_id text, attachment_name text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS request_events (id serial PRIMARY KEY, request_id text NOT NULL REFERENCES requests(id) ON DELETE CASCADE, at timestamptz NOT NULL, text text NOT NULL);
CREATE TABLE IF NOT EXISTS pickup_confirmations (
  request_id text PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pendiente','confirmada','negada')),
  requested_by_staff text, requested_at timestamptz, answered_by_person text, answered_at timestamptz);
CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY, person_id text, staff_id text, role text, text text NOT NULL, kind text NOT NULL DEFAULT 'info',
  buttons jsonb, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (((person_id IS NOT NULL)::int + (staff_id IS NOT NULL)::int + (role IS NOT NULL)::int) = 1));
CREATE TABLE IF NOT EXISTS chat_messages (
  id serial PRIMARY KEY, chat_key text NOT NULL, direction text NOT NULL CHECK (direction IN ('in','out')),
  text text NOT NULL, buttons jsonb, location jsonb, pending_until timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS chat_messages_key ON chat_messages (chat_key, id);
CREATE TABLE IF NOT EXISTS conversation_state (chat_key text PRIMARY KEY, step text NOT NULL, request_id text, draft jsonb, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS routes (id text PRIMARY KEY, name text NOT NULL, plate text, driver text, monitor_staff_id text, color text, schedule jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS stops (id text PRIMARY KEY, route_id text NOT NULL REFERENCES routes(id), position integer NOT NULL, name text NOT NULL, lat double precision NOT NULL, lng double precision NOT NULL);
CREATE TABLE IF NOT EXISTS trips (
  id text PRIMARY KEY, date text NOT NULL, route_id text NOT NULL REFERENCES routes(id), leg text NOT NULL CHECK (leg IN ('ida','vuelta')),
  status text NOT NULL DEFAULT 'programado' CHECK (status IN ('programado','en_ruta','finalizado')),
  started_at timestamptz, ended_at timestamptz, UNIQUE (date, route_id, leg));
CREATE TABLE IF NOT EXISTS trip_boardings (
  trip_id text NOT NULL REFERENCES trips(id) ON DELETE CASCADE, student_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('abordo','bajo','no_abordo')), stop_id text, by_staff_id text, at timestamptz NOT NULL,
  PRIMARY KEY (trip_id, student_id));
CREATE TABLE IF NOT EXISTS bus_opt_outs (trip_id text NOT NULL REFERENCES trips(id) ON DELETE CASCADE, student_id text NOT NULL, by_person_id text, at timestamptz NOT NULL, PRIMARY KEY (trip_id, student_id));
CREATE TABLE IF NOT EXISTS audit_log (
  id serial PRIMARY KEY, at timestamptz NOT NULL, actor_user_id text, actor_role text, actor_name text,
  command text, entity text, entity_id text, channel text, summary text, input jsonb);
CREATE TABLE IF NOT EXISTS login_attempts (key text PRIMARY KEY, count integer NOT NULL DEFAULT 0, window_start timestamptz NOT NULL);
`,
  },
];
```

`server/db/migrate.js`:

```js
import { MIGRATIONS } from './schema.js';

export async function migrate(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  await db.tx(async (q) => {
    if (db.kind === 'pg') await q.query('SELECT pg_advisory_xact_lock(727001)');
    const done = new Set((await q.query('SELECT version FROM schema_migrations')).map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await q.exec(m.sql);
      await q.query('INSERT INTO schema_migrations(version) VALUES ($1)', [m.version]);
    }
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/db/migrate.test.js`
Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db/client.js server/db/schema.js server/db/migrate.js server/db/migrate.test.js
git commit -m "Add pg/PGlite database client, schema and migration runner" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 3: Repository helpers and demo seed

**Files:**
- Create: `server/db/repo.js`, `server/db/seed.js`
- Test: `server/db/seed.test.js`

**Interfaces:**
- Produces (all take the transaction handle `q` first):
  - generic: `insertRow(q, table, obj)`, `patchRow(q, table, id, patch)` (camelCase keys → snake_case columns; `Date` → ISO; objects/arrays → JSON; `Buffer` untouched)
  - settings: `getSettings(q) → data`, `saveSettings(q, data)`, `getPermissions(q) → { role: { cap: bool } }`, `setPermission(q, role, cap, allowed)`, `getRevision(q)`, `bumpRevision(q) → number`
  - people: `listLevels`, `listStaff`, `getStaff(q, id)`, `listUsers`, `getUser(q, id)`, `getPerson(q, id)`, `listPersons`, `listStudents` (each with `titulares: string[]`), `getStudent(q, id)`, `studentsOfPerson(q, personId)`
  - requests: `insertRequest(q, r)`, `getRequest(q, id)` (with `history[]` and `confirmation|null`), `listRequests(q, { studentIds?, date?, kind?, status? })` newest first, `addRequestEvent(q, requestId, at, text)`, `upsertConfirmation(q, row)`
  - authorizations: `listAuthorizations(q, { studentIds?, personId?, includeRevoked? })`, `getAuthorization(q, id)`
  - notifications: `insertNotification(q, { personId?, staffId?, role?, text, kind?, buttons? }, at)`, `listNotifications(q, { personId?, staffId?, role? })` oldest first, `markNotificationsRead(q, target, at)`
  - chat: `insertChat(q, { chatKey, direction, text, buttons?, location?, pendingUntil? }, at)`, `listChat(q, chatKey)`, `listAllChats(q) → { key: messages[] }`, `countPendingOut(q, chatKey, at)`, `getConversation(q, key)`, `setConversation(q, key, { step, requestId?, draft? }, at)`, `clearConversation(q, key)`, `listConversations(q) → { key: state }`
  - audit: `insertAudit(q, row)`, `listAudit(q, limit)` newest first
  - bus: `listRoutes(q)` (each with `stops[]` sorted), `getRoute(q, id)`, `findTrip(q, date, routeId, leg)`, `ensureTrip(q, date, routeId, leg)`, `listTripsOn(q, date)` — every trip is returned as `{ id, date, routeId, leg, status, startedAt, endedAt, boarded: { studentId: { status, ts, by, stopId } }, noBus: [studentId] }`
  - attachments: `insertAttachment(q, { id, ownerPersonId, purpose, mime, bytes, size, name })`, `getAttachment(q, id)`
  - seed: `seedDemo(q, { now, tz })`, `resetAll(q)`, `isEmpty(q)`, `seedIfEmpty(q, { now, tz })`

- [ ] **Step 1: Write the failing test**

`server/db/seed.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './client.js';
import { migrate } from './migrate.js';
import { seedDemo, resetAll, isEmpty, seedIfEmpty } from './seed.js';
import { getStudent, listUsers, listRoutes, findTrip, getRequest, listRequests, getPerson, getPermissions, getSettings, insertRow, patchRow, getRevision } from './repo.js';

const TZ = 'America/Panama';
const now = new Date('2026-09-18T15:30:00Z');

async function fresh() { const db = await openDb({}); await migrate(db); await db.tx((q) => seedDemo(q, { now, tz: TZ })); return db; }

test('seed creates the prototype families, staff, users and routes', async () => {
  const db = await fresh();
  const e1 = await getStudent(db, 'e1');
  assert.deepEqual(e1.titulares, ['p1', 'p2']);
  assert.equal(e1.routeId, 'r1');
  const users = await listUsers(db);
  assert.ok(users.find((u) => u.id === 'u_p1' && u.role === 'parent' && u.refId === 'p1'));
  assert.ok(users.find((u) => u.id === 'u_s6' && u.role === 'garita'));
  assert.equal(users.filter((u) => u.role === 'parent').length, 5);
  const routes = await listRoutes(db);
  assert.equal(routes[0].stops.length, 4);
  assert.equal(routes[0].schedule.vuelta.start, '15:00');
  const trip = await findTrip(db, '2026-09-18', 'r1', 'vuelta');
  assert.equal(trip.status, 'en_ruta');
  assert.equal(trip.boarded.e1.status, 'abordo');
  assert.deepEqual(trip.noBus, []);
  const p3 = await getPerson(db, 'p3');
  assert.ok(p3.docAttachmentId, 'seeded persons carry a demo document');
  assert.equal((await getPermissions(db)).garita.marcar_salida, true);
  assert.equal((await getSettings(db)).timezone, TZ);
  assert.equal(await getRevision(db), 1);
  await db.close();
});

test('seeded requests carry history and dates relative to today', async () => {
  const db = await fresh();
  const r = await getRequest(db, 'r_h1');
  assert.equal(r.status, 'retirado');
  assert.equal(r.date, '2026-09-17');
  assert.equal(r.history.length, 3);
  assert.equal(r.confirmation, null);
  const pending = await listRequests(db, { status: 'pendiente' });
  assert.deepEqual(pending.map((x) => x.id), ['r_h3']);
  await db.close();
});

test('insertRow and patchRow map camelCase, dates and json', async () => {
  const db = await fresh();
  await insertRow(db, 'notifications', { id: 'n1', personId: 'p1', text: 'hola', buttons: ['Sí', 'No'] });
  await patchRow(db, 'notifications', 'n1', { readAt: now, kind: 'wa' });
  const [row] = await db.query('SELECT * FROM notifications WHERE id=$1', ['n1']);
  assert.deepEqual(row.buttons, ['Sí', 'No']);
  assert.equal(new Date(row.read_at).getTime(), now.getTime());
  assert.equal(row.kind, 'wa');
  await db.close();
});

test('resetAll empties everything and seedIfEmpty only seeds once', async () => {
  const db = await fresh();
  await insertRow(db, 'notifications', { id: 'n1', personId: 'p1', text: 'hola' });
  await db.tx(async (q) => { await resetAll(q); assert.equal(await isEmpty(q), true); await seedDemo(q, { now, tz: TZ }); });
  assert.equal((await db.query('SELECT count(*)::int AS c FROM notifications'))[0].c, 0);
  await db.tx((q) => seedIfEmpty(q, { now, tz: TZ }));
  assert.equal((await db.query('SELECT count(*)::int AS c FROM students'))[0].c, 4);
  await db.close();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/db/seed.test.js`
Expected: FAIL, `Cannot find module './seed.js'`.

- [ ] **Step 3: Implement `server/db/repo.js`**

```js
import { camel, snake } from './rows.js';

const one = (rows) => camel(rows[0] || null);
const all = (rows) => rows.map(camel);
const isBytes = (v) => Buffer.isBuffer(v) || v instanceof Uint8Array;
function param(v) {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object' && !isBytes(v)) return JSON.stringify(v);
  return v;
}

/* ---------- generic ---------- */
export async function insertRow(q, table, obj) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const cols = keys.map(snake).join(', ');
  const marks = keys.map((_, i) => '$' + (i + 1)).join(', ');
  await q.query(`INSERT INTO ${table} (${cols}) VALUES (${marks})`, keys.map((k) => param(obj[k])));
}
export async function patchRow(q, table, id, patch) {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${snake(k)}=$${i + 2}`).join(', ');
  await q.query(`UPDATE ${table} SET ${sets} WHERE id=$1`, [id, ...keys.map((k) => param(patch[k]))]);
}
const marks = (n, from = 1) => Array.from({ length: n }, (_, i) => '$' + (i + from)).join(', ');

/* ---------- settings, permissions, revision ---------- */
export async function getSettings(q) { const r = await q.query("SELECT data FROM settings WHERE id='school'"); return r[0] ? r[0].data : {}; }
export async function saveSettings(q, data) { await q.query("INSERT INTO settings(id, data) VALUES ('school', $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data", [JSON.stringify(data)]); }
export async function getPermissions(q) {
  const out = {};
  for (const r of await q.query('SELECT role, capability, allowed FROM role_permissions')) (out[r.role] ||= {})[r.capability] = r.allowed;
  return out;
}
export async function setPermission(q, role, capability, allowed) {
  await q.query('INSERT INTO role_permissions(role, capability, allowed) VALUES ($1, $2, $3) ON CONFLICT (role, capability) DO UPDATE SET allowed = EXCLUDED.allowed', [role, capability, allowed]);
}
export async function getRevision(q) { const r = await q.query("SELECT value FROM app_meta WHERE id='revision'"); return r[0] ? r[0].value : 0; }
export async function bumpRevision(q) {
  const r = await q.query("INSERT INTO app_meta(id, value) VALUES ('revision', 1) ON CONFLICT (id) DO UPDATE SET value = app_meta.value + 1 RETURNING value");
  return r[0].value;
}

/* ---------- levels, staff, users, persons, students ---------- */
export const listLevels = async (q) => all(await q.query('SELECT * FROM levels ORDER BY position'));
export const listStaff = async (q) => all(await q.query('SELECT * FROM staff ORDER BY id'));
export const getStaff = async (q, id) => one(await q.query('SELECT * FROM staff WHERE id=$1', [id]));
export const listUsers = async (q) => all(await q.query('SELECT * FROM users WHERE active ORDER BY kind DESC, id'));
export const getUser = async (q, id) => one(await q.query('SELECT * FROM users WHERE id=$1', [id]));
export const getPerson = async (q, id) => one(await q.query('SELECT * FROM persons WHERE id=$1', [id]));
export const listPersons = async (q) => all(await q.query('SELECT * FROM persons ORDER BY id'));

async function withTitulares(q, rows) {
  if (!rows.length) return [];
  const map = {};
  for (const g of await q.query('SELECT student_id, person_id FROM guardianships ORDER BY person_id')) (map[g.student_id] ||= []).push(g.person_id);
  return rows.map(camel).map((s) => ({ ...s, titulares: map[s.id] || [] }));
}
export const listStudents = async (q) => withTitulares(q, await q.query('SELECT * FROM students ORDER BY id'));
export async function getStudent(q, id) { return (await withTitulares(q, await q.query('SELECT * FROM students WHERE id=$1', [id])))[0] || null; }
export async function studentsOfPerson(q, personId) {
  return withTitulares(q, await q.query('SELECT s.* FROM students s JOIN guardianships g ON g.student_id = s.id WHERE g.person_id=$1 ORDER BY s.id', [personId]));
}

/* ---------- requests ---------- */
async function hydrateRequests(q, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const events = await q.query(`SELECT request_id, at, text FROM request_events WHERE request_id IN (${marks(ids.length)}) ORDER BY id`, ids);
  const confs = await q.query(`SELECT * FROM pickup_confirmations WHERE request_id IN (${marks(ids.length)})`, ids);
  const hist = {}, conf = {};
  for (const e of events) (hist[e.request_id] ||= []).push({ ts: new Date(e.at).getTime(), text: e.text });
  for (const c of confs) conf[c.request_id] = { status: c.status, by: c.requested_by_staff, requestedAt: c.requested_at ? new Date(c.requested_at).getTime() : null, byPerson: c.answered_by_person, at: c.answered_at ? new Date(c.answered_at).getTime() : null };
  return rows.map(camel).map((r) => ({ ...r, history: hist[r.id] || [], confirmation: conf[r.id] || null }));
}
export const insertRequest = (q, r) => insertRow(q, 'requests', r);
export async function getRequest(q, id) { return (await hydrateRequests(q, await q.query('SELECT * FROM requests WHERE id=$1', [id])))[0] || null; }
export async function listRequests(q, { studentIds, date, kind, status } = {}) {
  const where = [], params = [];
  if (studentIds) { if (!studentIds.length) return []; where.push(`student_id IN (${marks(studentIds.length, params.length + 1)})`); params.push(...studentIds); }
  if (date) { params.push(date); where.push(`date=$${params.length}`); }
  if (kind) { params.push(kind); where.push(`kind=$${params.length}`); }
  if (status) { params.push(status); where.push(`status=$${params.length}`); }
  const sql = 'SELECT * FROM requests' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC, id DESC';
  return hydrateRequests(q, await q.query(sql, params));
}
export const addRequestEvent = (q, requestId, at, text) => insertRow(q, 'request_events', { requestId, at, text });
export async function upsertConfirmation(q, row) {
  await q.query(`INSERT INTO pickup_confirmations(request_id, status, requested_by_staff, requested_at, answered_by_person, answered_at) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (request_id) DO UPDATE SET status=EXCLUDED.status, requested_by_staff=COALESCE(EXCLUDED.requested_by_staff, pickup_confirmations.requested_by_staff),
    requested_at=COALESCE(EXCLUDED.requested_at, pickup_confirmations.requested_at), answered_by_person=EXCLUDED.answered_by_person, answered_at=EXCLUDED.answered_at`,
  [row.requestId, row.status, row.requestedByStaff || null, param(row.requestedAt), row.answeredByPerson || null, param(row.answeredAt)]);
}

/* ---------- authorizations ---------- */
export async function listAuthorizations(q, { studentIds, personId, includeRevoked = true } = {}) {
  const where = [], params = [];
  if (studentIds) { if (!studentIds.length) return []; where.push(`student_id IN (${marks(studentIds.length, 1)})`); params.push(...studentIds); }
  if (personId) { params.push(personId); where.push(`person_id=$${params.length}`); }
  if (!includeRevoked) where.push('revoked_at IS NULL');
  return all(await q.query('SELECT * FROM authorizations' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at, id', params));
}
export const getAuthorization = async (q, id) => one(await q.query('SELECT * FROM authorizations WHERE id=$1', [id]));

/* ---------- notifications ---------- */
export const insertNotification = (q, n, at) => insertRow(q, 'notifications', { ...n, createdAt: at });
function targetWhere(target, params) {
  if (target.personId) { params.push(target.personId); return `person_id=$${params.length}`; }
  if (target.staffId) { params.push(target.staffId); return `staff_id=$${params.length}`; }
  params.push(target.role); return `role=$${params.length}`;
}
export async function listNotifications(q, target) {
  const params = []; const w = targetWhere(target, params);
  return all(await q.query(`SELECT * FROM notifications WHERE ${w} ORDER BY created_at, id`, params)).map((n) => ({ ...n, ts: n.createdAt, read: !!n.readAt }));
}
export async function markNotificationsRead(q, target, at) {
  const params = [at.toISOString()]; const w = targetWhere(target, params);
  await q.query(`UPDATE notifications SET read_at=$1 WHERE read_at IS NULL AND ${w}`, params);
}

/* ---------- chat & conversation ---------- */
const chatRow = (m) => ({ id: m.id, from: m.direction === 'in' ? 'user' : 'bot', text: m.text, buttons: m.buttons, location: m.location, ts: m.createdAt, pendingUntil: m.pendingUntil });
export const insertChat = (q, m, at) => insertRow(q, 'chat_messages', { ...m, createdAt: at });
export const listChat = async (q, chatKey) => all(await q.query('SELECT * FROM chat_messages WHERE chat_key=$1 ORDER BY id', [chatKey])).map(chatRow);
export async function listAllChats(q) {
  const out = {};
  for (const m of all(await q.query('SELECT * FROM chat_messages ORDER BY id'))) (out[m.chatKey] ||= []).push(chatRow(m));
  return out;
}
export async function countPendingOut(q, chatKey, at) {
  const r = await q.query("SELECT count(*)::int AS c FROM chat_messages WHERE chat_key=$1 AND direction='out' AND pending_until > $2", [chatKey, at.toISOString()]);
  return r[0].c;
}
export async function getConversation(q, key) { const r = one(await q.query('SELECT * FROM conversation_state WHERE chat_key=$1', [key])); return r ? { step: r.step, requestId: r.requestId, draft: r.draft } : null; }
export async function setConversation(q, key, state, at) {
  await q.query('INSERT INTO conversation_state(chat_key, step, request_id, draft, updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (chat_key) DO UPDATE SET step=EXCLUDED.step, request_id=EXCLUDED.request_id, draft=EXCLUDED.draft, updated_at=EXCLUDED.updated_at',
    [key, state.step, state.requestId || null, JSON.stringify(state.draft || null), at.toISOString()]);
}
export const clearConversation = (q, key) => q.query('DELETE FROM conversation_state WHERE chat_key=$1', [key]);
export async function listConversations(q) {
  const out = {};
  for (const r of all(await q.query('SELECT * FROM conversation_state'))) out[r.chatKey] = { step: r.step, requestId: r.requestId, draft: r.draft };
  return out;
}

/* ---------- audit ---------- */
export const insertAudit = (q, row) => insertRow(q, 'audit_log', row);
/* The visible bitácora: only rows written by logEvent (summary), not the per-command rows the runner adds. */
export const listAudit = async (q, limit = 500) => all(await q.query('SELECT * FROM audit_log WHERE summary IS NOT NULL ORDER BY id DESC LIMIT $1', [limit])).map((a) => ({ ...a, ts: a.at, actor: a.actorName, text: a.summary }));

/* ---------- bus ---------- */
export async function listRoutes(q) {
  const routes = all(await q.query('SELECT * FROM routes ORDER BY id'));
  const stops = all(await q.query('SELECT * FROM stops ORDER BY route_id, position'));
  return routes.map((r) => ({ ...r, monitorId: r.monitorStaffId, stops: stops.filter((s) => s.routeId === r.id) }));
}
export async function getRoute(q, id) { return (await listRoutes(q)).find((r) => r.id === id) || null; }
async function hydrateTrips(q, rows) {
  if (!rows.length) return [];
  const ids = rows.map((t) => t.id);
  const b = await q.query(`SELECT * FROM trip_boardings WHERE trip_id IN (${marks(ids.length)})`, ids);
  const o = await q.query(`SELECT * FROM bus_opt_outs WHERE trip_id IN (${marks(ids.length)}) ORDER BY at`, ids);
  return rows.map(camel).map((t) => ({
    ...t,
    boarded: Object.fromEntries(b.filter((x) => x.trip_id === t.id).map((x) => [x.student_id, { status: x.status, ts: new Date(x.at).getTime(), by: x.by_staff_id, stopId: x.stop_id }])),
    noBus: o.filter((x) => x.trip_id === t.id).map((x) => x.student_id),
  }));
}
export async function findTrip(q, date, routeId, leg) { return (await hydrateTrips(q, await q.query('SELECT * FROM trips WHERE date=$1 AND route_id=$2 AND leg=$3', [date, routeId, leg])))[0] || null; }
export async function ensureTrip(q, date, routeId, leg) {
  const found = await findTrip(q, date, routeId, leg);
  if (found) return found;
  await insertRow(q, 'trips', { id: `${date}_${routeId}_${leg}`, date, routeId, leg, status: 'programado' });
  return findTrip(q, date, routeId, leg);
}
export const listTripsOn = async (q, date) => hydrateTrips(q, await q.query('SELECT * FROM trips WHERE date=$1 ORDER BY id', [date]));
export async function upsertBoarding(q, tripId, studentId, rec) {
  await q.query('INSERT INTO trip_boardings(trip_id, student_id, status, stop_id, by_staff_id, at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (trip_id, student_id) DO UPDATE SET status=EXCLUDED.status, stop_id=EXCLUDED.stop_id, by_staff_id=EXCLUDED.by_staff_id, at=EXCLUDED.at',
    [tripId, studentId, rec.status, rec.stopId || null, rec.by, param(rec.at)]);
}
export async function insertOptOut(q, tripId, studentId, personId, at) {
  await q.query('INSERT INTO bus_opt_outs(trip_id, student_id, by_person_id, at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [tripId, studentId, personId, at.toISOString()]);
}

/* ---------- attachments ---------- */
export const insertAttachment = (q, a) => insertRow(q, 'attachments', a);
export const getAttachment = async (q, id) => one(await q.query('SELECT * FROM attachments WHERE id=$1', [id]));
```

- [ ] **Step 4: Implement `server/db/seed.js`** (data ported 1:1 from `seed.js` at the repo root)

```js
import { shiftISO } from '../domain/time.js';
import { insertRow, saveSettings, setPermission, getRevision } from './repo.js';

const MOVEMENT_TABLES = ['login_attempts', 'audit_log', 'bus_opt_outs', 'trip_boardings', 'trips', 'conversation_state', 'chat_messages', 'notifications', 'pickup_confirmations', 'request_events', 'requests', 'authorizations', 'guardianships', 'users', 'students', 'persons', 'attachments', 'stops', 'routes', 'role_permissions', 'staff', 'levels', 'app_meta', 'settings'];

export async function resetAll(q) { await q.exec(`TRUNCATE ${MOVEMENT_TABLES.join(', ')} RESTART IDENTITY CASCADE`); }
export async function isEmpty(q) { return (await q.query('SELECT count(*)::int AS c FROM users'))[0].c === 0; }
export async function seedIfEmpty(q, env) { if (await isEmpty(q)) await seedDemo(q, env); }

const svgDoc = (title, name) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" rx="12" fill="#eef3ee" stroke="#9aa89a"/>` +
  `<text x="16" y="36" font-size="13" font-family="sans-serif" fill="#374151">REPÚBLICA DE PANAMÁ · ${title} (demo)</text>` +
  `<circle cx="60" cy="110" r="32" fill="#cbd5cb"/><text x="110" y="104" font-size="20" font-family="sans-serif" font-weight="bold" fill="#111">${name}</text>` +
  `<text x="110" y="130" font-size="13" font-family="sans-serif" fill="#374151">Documento de ejemplo</text></svg>`, 'utf8');

export async function seedDemo(q, { now, tz }) {
  const shift = (d) => shiftISO(now, tz, d);
  const T = now.getTime();
  const H = 3600 * 1000;
  const at = (ms) => new Date(ms);

  await saveSettings(q, {
    autoApprove: true, minAnticipationMin: 60, defaultPickupPoint: 'Puerta Principal', maxTitulares: 2,
    schoolStart: '07:20', schoolEnd: '15:00', simulateBus: true, busProgress: 0.22, newAuthDays: 7,
    timezone: tz,
    school: { name: 'Instituto Académico Esperanza', short: 'IAE', phone: '+507 6800-0000', pickupPoints: ['Puerta Principal', 'Puerta Lateral (Parqueo)', 'Recepción'] },
  });

  const levels = [['preescolar', 'Preescolar', ['Kínder']], ['primaria', 'Primaria', ['1°', '2°', '3°', '4°', '5°', '6°']], ['premedia', 'Premedia', ['7°', '8°', '9°']], ['media', 'Media', ['10°', '11°', '12°']]];
  for (const [i, [id, name, grades]] of levels.entries()) await insertRow(q, 'levels', { id, name, grades, position: i });

  const staff = [
    { id: 's1', name: 'Lic. Rosa Martínez', role: 'admin', title: 'Dirección' },
    { id: 's2', name: 'Yadira Batista', role: 'recepcion', title: 'Recepción' },
    { id: 's3', name: 'Prof. Diana Ríos', role: 'profesor', title: 'Docente 3° Primaria', grades: ['3°'] },
    { id: 's4', name: 'Prof. Jorge Ávila', role: 'profesor', title: 'Docente 9° Premedia', grades: ['9°'] },
    { id: 's5', name: 'Prof. Mónica Salas', role: 'profesor', title: 'Docente Kínder', grades: ['Kínder'] },
    { id: 's6', name: 'Manuel Ortega', role: 'garita', title: 'Oficial de garita' },
    { id: 's7', name: 'Kenia Pérez', role: 'monitora', title: 'Monitora · Bus 12', routeId: 'r1' },
    { id: 's8', name: 'Lisbeth Moreno', role: 'monitora', title: 'Monitora · Bus 7', routeId: 'r2' },
  ];
  for (const s of staff) await insertRow(q, 'staff', s);

  const perms = {
    admin:     { ver_solicitudes: true,  aprobar: true,  ver_excusas: true,  decidir_excusas: true,  marcar_salida: true,  ver_estudiantes: true,  gestionar_autorizados: true,  ver_rutas: true,  marcar_bus: true,  personal: true,  config: true,  bitacora: true,  todos_niveles: true },
    recepcion: { ver_solicitudes: true,  aprobar: true,  ver_excusas: true,  decidir_excusas: true,  marcar_salida: false, ver_estudiantes: true,  gestionar_autorizados: true,  ver_rutas: true,  marcar_bus: false, personal: false, config: false, bitacora: true,  todos_niveles: true },
    profesor:  { ver_solicitudes: true,  aprobar: false, ver_excusas: true,  decidir_excusas: false, marcar_salida: false, ver_estudiantes: true,  gestionar_autorizados: false, ver_rutas: false, marcar_bus: false, personal: false, config: false, bitacora: false, todos_niveles: false },
    garita:    { ver_solicitudes: false, aprobar: false, ver_excusas: false, decidir_excusas: false, marcar_salida: true,  ver_estudiantes: false, gestionar_autorizados: false, ver_rutas: false, marcar_bus: false, personal: false, config: false, bitacora: false, todos_niveles: true },
    monitora:  { ver_solicitudes: false, aprobar: false, ver_excusas: false, decidir_excusas: false, marcar_salida: false, ver_estudiantes: true,  gestionar_autorizados: false, ver_rutas: true,  marcar_bus: true,  personal: false, config: false, bitacora: false, todos_niveles: false },
  };
  for (const [role, caps] of Object.entries(perms)) for (const [cap, allowed] of Object.entries(caps)) await setPermission(q, role, cap, allowed);

  const persons = [
    { id: 'p1', name: 'Carlos Rodríguez', phone: '+507 6111-1111', cedula: '8-701-123', relation: 'Papá', hasAccount: true, docName: 'cedula_carlos.jpg' },
    { id: 'p2', name: 'Ana Pérez', phone: '+507 6222-2222', cedula: '8-702-456', relation: 'Mamá', hasAccount: true, docName: 'cedula_ana.jpg' },
    { id: 'p3', name: 'María Pérez', phone: '+507 6999-0001', cedula: '8-200-111', relation: 'Abuela', hasAccount: false, docName: 'foto_maria.jpg' },
    { id: 'p4', name: 'Luis Rodríguez', phone: '+507 6999-0002', cedula: '8-650-222', relation: 'Tío', hasAccount: false, docName: 'cedula_luis.jpg' },
    { id: 'p5', name: 'Laura Gómez', phone: '+507 6333-3333', cedula: '8-703-789', relation: 'Mamá', hasAccount: true, docName: 'cedula_laura.jpg' },
    { id: 'p6', name: 'Pedro Castillo', phone: '+507 6444-4444', cedula: '8-704-321', relation: 'Papá', hasAccount: true, docName: 'cedula_pedro.jpg' },
    { id: 'p7', name: 'Wei Chen', phone: '+507 6555-5555', cedula: 'E-8-12345', relation: 'Papá', hasAccount: true, docName: 'pasaporte_wei.jpg' },
  ];
  for (const p of persons) {
    const bytes = svgDoc(p.docName.startsWith('foto') ? 'Foto' : 'Cédula', p.name);
    await insertRow(q, 'attachments', { id: 'att_' + p.id, ownerPersonId: p.id, purpose: p.docName.startsWith('foto') ? 'foto' : 'cedula', mime: 'image/svg+xml', bytes, size: bytes.length, name: p.docName });
    await insertRow(q, 'persons', { ...p, docAttachmentId: 'att_' + p.id });
  }

  const routes = [
    { id: 'r1', name: 'Bus 12', plate: 'T-4521', driver: 'José Pinto', monitorStaffId: 's7', color: '#1f5eff', schedule: { ida: { start: '06:00', end: '07:15' }, vuelta: { start: '15:00', end: '16:20' } },
      stops: [['st1', 'Colegio IAE', 9.0125, -79.5100], ['st2', 'Villa Lucre', 9.0300, -79.4900], ['st3', 'Brisas del Golf', 9.0450, -79.4700], ['st4', 'Cerro Viento', 9.0600, -79.4500]] },
    { id: 'r2', name: 'Bus 7', plate: 'T-3310', driver: 'Ana Castro', monitorStaffId: 's8', color: '#d97706', schedule: { ida: { start: '06:10', end: '07:15' }, vuelta: { start: '15:00', end: '16:00' } },
      stops: [['st5', 'Colegio IAE', 9.0125, -79.5100], ['st6', 'Parque Lefevre', 9.0020, -79.4850], ['st7', 'Costa del Este', 8.9900, -79.4650]] },
  ];
  for (const { stops, ...r } of routes) {
    await insertRow(q, 'routes', r);
    for (const [i, [id, name, lat, lng]] of stops.entries()) await insertRow(q, 'stops', { id, routeId: r.id, position: i, name, lat, lng });
  }

  const students = [
    { id: 'e1', name: 'Joseph Rodríguez', grade: '3°', levelId: 'primaria', emoji: '👦', familyId: 'f1', routeId: 'r1', stopId: 'st2', busLegs: ['ida', 'vuelta'], titulares: ['p1', 'p2'] },
    { id: 'e2', name: 'Sofía Rodríguez', grade: 'Kínder', levelId: 'preescolar', emoji: '👧', familyId: 'f1', routeId: 'r1', stopId: 'st2', busLegs: ['ida', 'vuelta'], titulares: ['p1', 'p2'] },
    { id: 'e3', name: 'Mateo Castillo', grade: '3°', levelId: 'primaria', emoji: '🧒', familyId: 'f2', routeId: 'r2', stopId: 'st7', busLegs: ['vuelta'], titulares: ['p5', 'p6'] },
    { id: 'e4', name: 'Emily Chen', grade: '9°', levelId: 'premedia', emoji: '👩‍🎓', familyId: 'f3', titulares: ['p7'] },
  ];
  for (const { titulares, ...s } of students) {
    await insertRow(q, 'students', s);
    for (const personId of titulares) await insertRow(q, 'guardianships', { studentId: s.id, personId });
  }

  for (const p of persons) if (p.hasAccount) await insertRow(q, 'users', { id: 'u_' + p.id, kind: 'person', refId: p.id, name: p.name, role: 'parent' });
  for (const s of staff) await insertRow(q, 'users', { id: 'u_' + s.id, kind: 'staff', refId: s.id, name: s.name, role: s.role });

  const auths = [
    { id: 'a1', studentId: 'e1', personId: 'p3', type: 'siempre', createdBy: 'p1', createdAt: at(T - 40 * 24 * H) },
    { id: 'a2', studentId: 'e2', personId: 'p3', type: 'siempre', createdBy: 'p1', createdAt: at(T - 40 * 24 * H) },
    { id: 'a3', studentId: 'e1', personId: 'p4', type: 'temporal', validFrom: shift(-2), validTo: shift(12), createdBy: 'p2', createdAt: at(T - 3 * 24 * H) },
    { id: 'a4', studentId: 'e1', personId: 'p5', type: 'una_vez', createdBy: 'p1', createdAt: at(T - 1 * 24 * H) },
  ];
  for (const a of auths) await insertRow(q, 'authorizations', a);

  await insertRow(q, 'requests', { id: 'r_h1', kind: 'salida', studentId: 'e3', requestedBy: 'p5', pickupBy: 'p5', pickupKind: 'titular', date: shift(-1), time: '14:30', reason: 'Cita con el dentista', channel: 'whatsapp', status: 'retirado', pickupPoint: 'Puerta Principal', code: '4821', createdAt: at(T - 26 * H), decidedAt: at(T - 25.5 * H), decidedBy: 's2', autoApproved: false, exitAt: at(T - 22 * H), exitBy: 's6' });
  await insertRow(q, 'request_events', { requestId: 'r_h1', at: at(T - 26 * H), text: 'Solicitud creada por Laura Gómez vía WhatsApp' });
  await insertRow(q, 'request_events', { requestId: 'r_h1', at: at(T - 25.5 * H), text: 'Aprobada por Yadira Batista · Puerta Principal' });
  await insertRow(q, 'request_events', { requestId: 'r_h1', at: at(T - 22 * H), text: 'Retirado por Laura Gómez · marcado en garita por Manuel Ortega' });
  await insertRow(q, 'requests', { id: 'r_h2', kind: 'excusa', studentId: 'e4', requestedBy: 'p7', date: shift(-3), excusaType: 'ausencia', reason: 'Fiebre, reposo indicado por el pediatra', attachmentName: 'certificado_medico.jpg', channel: 'web', status: 'aceptada', createdAt: at(T - 75 * H), decidedAt: at(T - 70 * H), decidedBy: 's2' });
  await insertRow(q, 'request_events', { requestId: 'r_h2', at: at(T - 75 * H), text: 'Excusa enviada por Wei Chen vía App' });
  await insertRow(q, 'request_events', { requestId: 'r_h2', at: at(T - 70 * H), text: 'Aceptada por Yadira Batista' });
  await insertRow(q, 'requests', { id: 'r_h3', kind: 'salida', studentId: 'e4', requestedBy: 'p7', pickupBy: 'p7', pickupKind: 'titular', date: shift(0), time: '12:15', reason: 'Trámite de pasaporte', channel: 'web', status: 'pendiente', code: '7730', createdAt: at(T - 0.5 * H) });
  await insertRow(q, 'request_events', { requestId: 'r_h3', at: at(T - 0.5 * H), text: 'Solicitud creada por Wei Chen vía App' });
  await insertRow(q, 'request_events', { requestId: 'r_h3', at: at(T - 0.5 * H), text: 'Pendiente de revisión: menos de 60 min de anticipación' });

  const tripId = `${shift(0)}_r1_vuelta`;
  await insertRow(q, 'trips', { id: tripId, date: shift(0), routeId: 'r1', leg: 'vuelta', status: 'en_ruta', startedAt: at(T - 22 * 60000) });
  for (const sid of ['e1', 'e2']) await insertRow(q, 'trip_boardings', { tripId, studentId: sid, status: 'abordo', stopId: 'st1', byStaffId: 's7', at: at(T - 21 * 60000) });

  const log = [
    [T - 26 * H, 'Sistema', 'Solicitud de salida de Mateo Castillo creada por Laura Gómez (WhatsApp)'],
    [T - 25.5 * H, 'Yadira Batista', 'Aprobó salida de Mateo Castillo · Puerta Principal'],
    [T - 22 * H, 'Manuel Ortega', 'Marcó retirado a Mateo Castillo (Laura Gómez)'],
    [T - 0.5 * H, 'Sistema', 'Solicitud de salida de Emily Chen creada por Wei Chen (App) · pendiente'],
  ];
  for (const [ts, actor, text] of log) await insertRow(q, 'audit_log', { at: at(ts), actorName: actor, actorRole: 'seed', command: 'seed', summary: text });

  await q.query("INSERT INTO app_meta(id, value) VALUES ('revision', 1) ON CONFLICT (id) DO UPDATE SET value = app_meta.value + 1");
  return getRevision(q);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test server/db/seed.test.js`
Expected: 4 PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db/repo.js server/db/seed.js server/db/seed.test.js
git commit -m "Add SQL repository helpers and demo seed" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Login, router, transports, command runner skeleton and local bootstrap

**Files:**
- Create: `server/auth.js`, `server/domain/context.js`, `server/transports/whatsapp.js`, `server/transports/gps.js`, `server/commands/index.js`, `server/commands/run.js`, `server/commands/guards.js`, `server/projections/index.js`, `server/app.js`, `server/index.js`, `server/test-helpers.js`
- Modify: `api/index.js` (full replacement)
- Test: `server/auth.test.js`, `server/app.test.js`

**Interfaces:**
- Consumes: `session.js` (unchanged), `repo.js`, `config.js`.
- Produces:
  - `makeCtx(q, deps, userId, extra) → ctx` with `ctx = { q, user, person|null, staff|null, now: Date, tz, settings, permissions, transport, gps, command?, channel? }`
  - `runCommand(deps, { userId, name, input, channel }) → { result, revision }` using registry `COMMANDS[name] = { roles: string[], handler(ctx, input) }`
  - guards: `requireCap(ctx, cap)`, `requireTitular(ctx, studentId) → student`, `requireRouteAccess(ctx, routeId)`, `STAFF_ROLES`
  - `buildView(q, userId, env) → view` where `env = { now, transport, gps }`; base fields `{ user, serverNow, today, settings, capabilities, levels }` plus role fields added in Task 11 through `VIEW_BUILDERS[role]`
  - transports: `SimulatorTransport.send(ctx, chatKey, { text, buttons?, location?, typing? })`; `SimulatedGps.position(route, ctx) → { leg, progress, simulated } | null`
  - `createApp(deps) → { handler(req, res), publish(revision) }`, deps `= { db, config, transport, gps, now }`
  - `makeTestApp({ now }) → { db, deps, app, clock, run(name, userId, input), view(userId), listen() → { base, close }, close() }`

- [ ] **Step 1: Write the failing tests**

`server/auth.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { constantEquals, loginBlocked, recordLoginFailure, clearLoginFailures } from './auth.js';

test('constantEquals compares strings without leaking length', () => {
  assert.equal(constantEquals('4321', '4321'), true);
  assert.equal(constantEquals('4321', '43210'), false);
  assert.equal(constantEquals('', '1'), false);
});

test('ten failures inside 15 minutes block the key, clearing unblocks', async () => {
  const db = await openDb({}); await migrate(db);
  const now = new Date('2026-09-18T15:30:00Z');
  for (let i = 0; i < 9; i++) await recordLoginFailure(db, ['ip:1'], now);
  assert.equal(await loginBlocked(db, ['ip:1'], now), false);
  await recordLoginFailure(db, ['ip:1'], now);
  assert.equal(await loginBlocked(db, ['ip:1'], now), true);
  assert.equal(await loginBlocked(db, ['ip:1'], new Date(now.getTime() + 16 * 60000)), false, 'window expired');
  await clearLoginFailures(db, ['ip:1']);
  assert.equal(await loginBlocked(db, ['ip:1'], now), false);
  await db.close();
});
```

`server/app.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, call, loginAs } from './test-helpers.js';

test('health, options and login lifecycle', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  assert.equal((await call(base, '/api/health')).json.ok, true);
  const options = (await call(base, '/api/auth/options')).json;
  assert.ok(options.find((u) => u.id === 'u_p1' && u.role === 'parent'));
  assert.equal((await call(base, '/api/auth/login', { method: 'POST', body: { userId: 'u_p1', pin: '0000' } })).status, 401);
  assert.equal((await call(base, '/api/me/view')).status, 401);
  const cookie = await loginAs(base, 'u_p1');
  assert.match(cookie, /^iae_session=/);
  const view = await call(base, '/api/me/view', { cookie });
  assert.equal(view.status, 200);
  assert.equal(view.json.view.user.id, 'u_p1');
  assert.equal(view.json.revision, 1);
  const etag = view.headers.get('etag');
  assert.equal((await call(base, '/api/me/view', { cookie, headers: { 'if-none-match': etag } })).status, 304);
  const out = await call(base, '/api/auth/logout', { method: 'POST', cookie });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  await close(); await t.close();
});

test('ten wrong PINs lock the user out', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  for (let i = 0; i < 10; i++) await call(base, '/api/auth/login', { method: 'POST', body: { userId: 'u_s2', pin: 'no' } });
  assert.equal((await call(base, '/api/auth/login', { method: 'POST', body: { userId: 'u_s2', pin: '4321' } })).status, 429);
  await close(); await t.close();
});

test('unknown commands are 404 and commands need a session', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  assert.equal((await call(base, '/api/commands/nope', { method: 'POST', body: {} })).status, 401);
  const cookie = await loginAs(base, 'u_p1');
  assert.equal((await call(base, '/api/commands/nope', { method: 'POST', body: {}, cookie })).status, 404);
  await close(); await t.close();
});

test('static serving is limited to index.html and client/', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  assert.equal((await call(base, '/')).status, 200);
  for (const p of ['/server/app.js', '/data/pglite', '/.env', '/package.json', '/client/../package.json', '/client/.hidden', '/docs/x.md']) {
    assert.equal((await call(base, p)).status, 404, p);
  }
  await close(); await t.close();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test server/auth.test.js server/app.test.js`
Expected: FAIL, `Cannot find module './auth.js'` / `'./test-helpers.js'`.

- [ ] **Step 3: Implement auth, context, transports, registry, runner, guards, base projection**

`server/auth.js`:

```js
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
```

`server/domain/context.js`:

```js
import { HttpError } from './errors.js';
import { getUser, getPerson, getStaff, getSettings, getPermissions } from '../db/repo.js';

export async function makeCtx(q, deps, userId, extra = {}) {
  const user = await getUser(q, userId);
  if (!user || !user.active) throw new HttpError(401, 'authentication_required');
  const settings = await getSettings(q);
  const permissions = await getPermissions(q);
  return {
    q, user, settings, permissions,
    now: deps.now(), tz: settings.timezone || 'America/Panama',
    transport: deps.transport, gps: deps.gps,
    person: user.kind === 'person' ? await getPerson(q, user.refId) : null,
    staff: user.kind === 'staff' ? await getStaff(q, user.refId) : null,
    ...extra,
  };
}
```

`server/transports/whatsapp.js`:

```js
import { insertChat, countPendingOut } from '../db/repo.js';

/* Interface every WhatsApp transport implements: send(ctx, chatKey, { text, buttons, location, typing }).
   The simulator writes into chat_messages; the web chat renders them. A real provider would call its API here. */
export class SimulatorTransport {
  async send(ctx, chatKey, message) {
    let pendingUntil = null;
    if (message.typing) {
      const pending = await countPendingOut(ctx.q, chatKey, ctx.now);
      pendingUntil = new Date(ctx.now.getTime() + 700 + 400 * pending);
    }
    await insertChat(ctx.q, { chatKey, direction: 'out', text: message.text, buttons: message.buttons || null, location: message.location || null, pendingUntil }, ctx.now);
  }
}
```

`server/transports/gps.js`:

```js
import { minutesOf, nowHHMM } from '../domain/time.js';

/* Interface: position(route, ctx) → { leg, progress (0..1), simulated } or null when the bus is not on the road. */
export class SimulatedGps {
  position(route, ctx) {
    if (ctx.settings.simulateBus) return { leg: 'vuelta', progress: Number(ctx.settings.busProgress) || 0, simulated: true };
    const now = minutesOf(nowHHMM(ctx.now, ctx.tz));
    for (const leg of ['ida', 'vuelta']) {
      const w = route.schedule[leg]; const a = minutesOf(w.start); const b = minutesOf(w.end);
      if (now >= a && now <= b) return { leg, progress: (now - a) / (b - a), simulated: false };
    }
    return null;
  }
}
```

`server/commands/index.js` (registry; later tasks `Object.assign` into it):

```js
export const COMMANDS = {};
export function register(defs) { Object.assign(COMMANDS, defs); }
```

`server/commands/guards.js`:

```js
import { deny, notFound } from '../domain/errors.js';
import { getStudent } from '../db/repo.js';

export const STAFF_ROLES = ['admin', 'recepcion', 'profesor', 'garita', 'monitora'];
export function requireCap(ctx, cap) {
  if (ctx.user.role === 'admin') return;
  if (!ctx.permissions[ctx.user.role] || !ctx.permissions[ctx.user.role][cap]) deny('forbidden_capability:' + cap);
}
export async function requireTitular(ctx, studentId) {
  const st = await getStudent(ctx.q, studentId);
  if (!st) notFound('student_not_found');
  if (!ctx.person || !st.titulares.includes(ctx.person.id)) deny('forbidden_not_titular');
  return st;
}
export function requireRouteAccess(ctx, routeId) {
  if (ctx.user.role === 'admin') return;
  if (!ctx.staff || ctx.staff.routeId !== routeId) deny('forbidden_route');
}
```

`server/commands/run.js`:

```js
import { HttpError } from '../domain/errors.js';
import { makeCtx } from '../domain/context.js';
import { insertAudit, bumpRevision } from '../db/repo.js';
import { COMMANDS } from './index.js';

const sanitize = (input) => {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) out[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
  return out;
};

export async function runCommand(deps, { userId, name, input = {}, channel = 'web' }) {
  const cmd = COMMANDS[name];
  if (!cmd) throw new HttpError(404, 'unknown_command');
  return deps.db.tx(async (q) => {
    const ctx = await makeCtx(q, deps, userId, { command: name, channel });
    if (!cmd.roles.includes(ctx.user.role)) throw new HttpError(403, 'forbidden_role');
    const result = await cmd.handler(ctx, input || {});
    await insertAudit(q, { at: ctx.now, actorUserId: ctx.user.id, actorRole: ctx.user.role, actorName: ctx.user.name, command: name, channel, input: sanitize(input) });
    const revision = await bumpRevision(q);
    return { result, revision };
  });
}
```

`server/projections/index.js` (base only; role builders arrive in Task 11):

```js
import { makeCtx } from '../domain/context.js';
import { todayISO } from '../domain/time.js';
import { listLevels } from '../db/repo.js';

export const VIEW_BUILDERS = {};
const ALL_CAPS = ['ver_solicitudes', 'aprobar', 'ver_excusas', 'decidir_excusas', 'marcar_salida', 'ver_estudiantes', 'gestionar_autorizados', 'ver_rutas', 'marcar_bus', 'personal', 'config', 'bitacora', 'todos_niveles'];

export async function buildView(q, userId, env) {
  const ctx = await makeCtx(q, env, userId);
  const { user } = ctx;
  const capabilities = user.role === 'admin' ? Object.fromEntries(ALL_CAPS.map((c) => [c, true])) : (ctx.permissions[user.role] || {});
  const base = {
    user: { id: user.id, name: user.name, role: user.role, kind: user.kind, refId: user.refId },
    serverNow: ctx.now.getTime(),
    today: todayISO(ctx.now, ctx.tz),
    settings: ctx.settings,
    capabilities,
    levels: await listLevels(q),
  };
  const builder = VIEW_BUILDERS[user.role];
  return builder ? { ...base, ...(await builder(ctx)) } : base;
}
```

- [ ] **Step 4: Implement the router `server/app.js`**

```js
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './domain/errors.js';
import { cookieValue, sessionToken, verifySession } from './session.js';
import { constantEquals, loginBlocked, recordLoginFailure, clearLoginFailures } from './auth.js';
import { listUsers, getUser, getRevision } from './db/repo.js';
import { runCommand } from './commands/run.js';
import { buildView } from './projections/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export function createApp(deps) {
  const { db, config } = deps;
  const clients = new Set();
  const publish = (revision) => {
    const line = `data: ${JSON.stringify({ type: 'changed', revision })}\n\n`;
    for (const res of clients) res.write(line);
  };
  const env = () => ({ now: deps.now(), transport: deps.transport, gps: deps.gps });
  const json = (res, status, value, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(value));
  };
  const cookie = (token, maxAge) => `iae_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${config.secure ? '; Secure' : ''}`;
  async function readBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 1.5e6) throw new HttpError(413, 'too_large'); }
    return raw ? JSON.parse(raw) : {};
  }
  const clientIp = (req) => String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
  async function sessionUser(req) {
    const session = verifySession(cookieValue(req.headers.cookie, 'iae_session'), config.secret);
    if (!session) return null;
    const user = await getUser(db, session.userId);
    return user && user.active ? user : null;
  }

  async function api(req, res, path) {
    if (path === 'health') return json(res, 200, { ok: true, db: db.kind, revision: await getRevision(db) });
    if (path === 'auth/options' && req.method === 'GET') return json(res, 200, (await listUsers(db)).map((u) => ({ id: u.id, name: u.name, role: u.role })));
    if (path === 'auth/login' && req.method === 'POST') {
      const input = await readBody(req);
      const now = deps.now();
      const keys = ['ip:' + clientIp(req), 'user:' + String(input.userId || '')];
      if (await loginBlocked(db, keys, now)) return json(res, 429, { error: 'too_many_attempts' });
      const user = input.userId ? await getUser(db, String(input.userId)) : null;
      if (!user || !user.active || !constantEquals(String(input.pin == null ? '' : input.pin), config.pin)) {
        await recordLoginFailure(db, keys, now);
        return json(res, 401, { error: 'invalid_credentials' });
      }
      await clearLoginFailures(db, keys);
      return json(res, 200, { user: { id: user.id, name: user.name, role: user.role } }, { 'set-cookie': cookie(sessionToken(user.id, config.secret), 28800) });
    }
    if (path === 'auth/logout' && req.method === 'POST') return json(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) });

    const user = await sessionUser(req);
    if (!user) return json(res, 401, { error: 'authentication_required' });

    if (path === 'me/view' && req.method === 'GET') {
      const revision = await getRevision(db);
      const etag = `"${revision}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'no-store' }); return res.end(); }
      const view = await db.tx((q) => buildView(q, user.id, env()));
      return json(res, 200, { revision, view }, { etag });
    }
    if (path.startsWith('commands/') && req.method === 'POST') {
      const name = path.slice('commands/'.length);
      const input = await readBody(req);
      const { result, revision } = await runCommand(deps, { userId: user.id, name, input, channel: 'web' });
      publish(revision);
      const view = await db.tx((q) => buildView(q, user.id, env()));
      return json(res, 200, { ok: true, result, revision, view }, { etag: `"${revision}"` });
    }
    if (path === 'events' && req.method === 'GET' && !config.serverless) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'connected', revision: await getRevision(db) })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    return json(res, 404, { error: 'not_found' });
  }

  async function serveStatic(res, pathname) {
    let file = null;
    if (pathname === '/' || pathname === '/index.html') file = join(ROOT, 'index.html');
    else {
      const m = /^\/client\/([A-Za-z0-9_][A-Za-z0-9_.-]*)$/.exec(pathname);
      if (m) file = join(ROOT, 'client', m[1]);
    }
    if (!file) return json(res, 404, { error: 'not_found' });
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    } catch { json(res, 404, { error: 'not_found' }); }
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const path = (url.searchParams.get('path') || url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '');
        return await api(req, res, path);
      }
      if (config.serverless) return json(res, 404, { error: 'not_found' });
      return await serveStatic(res, url.pathname);
    } catch (e) {
      const status = e.status || (e instanceof SyntaxError ? 400 : 500);
      if (status === 500) console.error(e);
      return json(res, status, { error: e.code || e.message, message: e.detail || null });
    }
  }
  return { handler, publish };
}
```

- [ ] **Step 5: Bootstrap files and test helper**

`server/index.js`:

```js
import http from 'node:http';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { seedIfEmpty } from './db/seed.js';
import { createApp } from './app.js';
import { SimulatorTransport } from './transports/whatsapp.js';
import { SimulatedGps } from './transports/gps.js';

const config = loadConfig();
const db = await openDb(config);
await migrate(db);
await db.tx((q) => seedIfEmpty(q, { now: new Date(), tz: 'America/Panama' }));
const app = createApp({ db, config, transport: new SimulatorTransport(), gps: new SimulatedGps(), now: () => new Date() });
http.createServer(app.handler).listen(config.port, () => console.log(`IAE Salidas en http://localhost:${config.port} · base de datos: ${db.kind}`));
```

`api/index.js` (replace the whole file):

```js
import { loadConfig } from '../server/config.js';
import { openDb } from '../server/db/client.js';
import { migrate } from '../server/db/migrate.js';
import { seedIfEmpty } from '../server/db/seed.js';
import { createApp } from '../server/app.js';
import { SimulatorTransport } from '../server/transports/whatsapp.js';
import { SimulatedGps } from '../server/transports/gps.js';

let appPromise;
function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const config = loadConfig();
      const db = await openDb(config);
      await migrate(db);
      await db.tx((q) => seedIfEmpty(q, { now: new Date(), tz: 'America/Panama' }));
      return createApp({ db, config, transport: new SimulatorTransport(), gps: new SimulatedGps(), now: () => new Date() });
    })().catch((e) => { appPromise = null; throw e; });
  }
  return appPromise;
}
export default async function handler(req, res) {
  try { const app = await getApp(); return await app.handler(req, res); }
  catch (e) { res.statusCode = 503; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: e.message })); }
}
```

`server/test-helpers.js`:

```js
import http from 'node:http';
import { openDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { seedDemo } from './db/seed.js';
import { createApp } from './app.js';
import { SimulatorTransport } from './transports/whatsapp.js';
import { SimulatedGps } from './transports/gps.js';
import { runCommand } from './commands/run.js';
import { buildView } from './projections/index.js';

export const TZ = 'America/Panama';
export const CONFIG = { secret: 's'.repeat(32), pin: '4321', databaseUrl: null, dataDir: null, port: 0, serverless: false, secure: false };
/* Friday 2026-09-18 10:30 in Panama: school hours, bus not on the road unless simulateBus. */
export const NOW = new Date('2026-09-18T15:30:00Z');

export async function makeTestApp({ now = NOW } = {}) {
  const db = await openDb({});
  await migrate(db);
  await db.tx((q) => seedDemo(q, { now, tz: TZ }));
  /* The clock advances one second per request so rows created by successive commands sort deterministically.
     Tests may set `clock.now` directly to jump in time. */
  const clock = { now };
  const tick = () => { clock.now = new Date(clock.now.getTime() + 1000); return clock.now; };
  const deps = { db, config: CONFIG, transport: new SimulatorTransport(), gps: new SimulatedGps(), now: tick };
  const app = createApp(deps);
  return {
    db, deps, app, clock,
    run: (name, userId, input = {}) => runCommand(deps, { userId, name, input }),
    view: (userId) => db.tx((q) => buildView(q, userId, { now: clock.now, transport: deps.transport, gps: deps.gps })),
    listen: async () => {
      const server = http.createServer(app.handler);
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
    },
    close: () => db.close(),
  };
}

/* HTTP helpers shared by the router tests. */
export async function call(base, path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
export async function loginAs(base, userId, pin = '4321') {
  const r = await call(base, '/api/auth/login', { method: 'POST', body: { userId, pin } });
  return r.headers.get('set-cookie').split(';')[0];
}
```

`server/commands/all.js` (side-effect imports; each later task appends one line here):

```js
/* Importing this file registers every command into COMMANDS. */
export {};
```

And add `import './all.js';` as the first line of `server/commands/run.js` so the registry is populated wherever `runCommand` is used.

The root `index.html` stays as it is for now (Task 13 replaces it), so the static test passes.

- [ ] **Step 5b: Remove the old JSON-bridge server modules and their tests**

They import modules that no longer make sense (`store.js`, `prototype-*.js`) and `api/index.test.js` targets the old handler. Delete:

```bash
git rm -q server/domain.js server/domain.test.js server/simulator.js server/delivery.js server/qr-worker.js server/whatsapp-bridge.js server/whatsapp-bridge.test.js server/prototype-policy.js server/prototype-policy.test.js server/prototype-commands.js server/prototype-commands.test.js server/store.js server/postgres-store.js server/postgres-store.test.js server/seed.js server/session.test.js api/index.test.js
```

Then recreate `server/session.test.js` with only the session case:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionToken, verifySession, cookieValue } from './session.js';

test('signed sessions reject tampering and expiry', () => {
  const token = sessionToken('u_s1', 'secret');
  assert.equal(verifySession(token, 'secret').userId, 'u_s1');
  assert.equal(verifySession(token + 'x', 'secret'), null);
  assert.equal(verifySession(token, 'other'), null);
  assert.equal(verifySession(sessionToken('u_s1', 'secret', -1), 'secret'), null);
});

test('cookieValue reads one cookie among many', () => {
  assert.equal(cookieValue('a=1; iae_session=abc.def; b=2', 'iae_session'), 'abc.def');
  assert.equal(cookieValue(undefined, 'iae_session'), null);
});
```

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: all PASS (old tests included). If `server/app.test.js` static test fails on `/client/.hidden`, check the regex requires the first char to be `[A-Za-z0-9_]`.

- [ ] **Step 7: Smoke-run the local server**

```bash
SESSION_SECRET="0123456789abcdef0123456789abcdef" PILOT_PIN="4321" node server/index.js
```

Expected log: `IAE Salidas en http://localhost:3000 · base de datos: pglite`. `curl http://localhost:3000/api/health` → `{"ok":true,"db":"pglite","revision":1}`. Stop the server (Ctrl-C). `data/pglite/` now exists and is gitignored.

- [ ] **Step 8: Commit**

```bash
git add -A server api
git commit -m "Add login with rate limit, router, command runner skeleton and local bootstrap; drop JSON-bridge modules" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 5: Eligibility, auto-approval rule, notifications and audit log

**Files:**
- Create: `server/domain/eligibility.js`, `server/domain/autoapprove.js`, `server/domain/notifications.js`
- Test: `server/domain/eligibility.test.js`, `server/domain/notifications.test.js`

**Interfaces:**
- Consumes: `repo.js`, `time.js`, `ctx` from `makeCtx`.
- Produces:
  - `isAuthActive(auth, todayISO) → bool`; `todayOf(ctx) → 'YYYY-MM-DD'`
  - `pickupEligibility(ctx, studentId, personId) → { ok, kind?: 'titular'|'siempre'|'temporal'|'una_vez', auth? }`
  - `pickupCandidates(ctx, studentId) → [{ person, kind, auth? }]`
  - `authorizedFor(ctx, personId) → [{ auth, student }]`
  - `evaluateAutoApprove(ctx, req, student) → { ok, reason? }`
  - `notifyPerson(ctx, personId, text, { buttons?, kind? })`, `notifyRole(ctx, role, text)`, `notifyStaff(ctx, staffId, text)`, `notifyTeachers(ctx, studentId, text)`, `logEvent(ctx, text, actorName = 'Sistema')`, `actorLabel(ctx)`

- [ ] **Step 1: Write the failing tests**

`server/domain/eligibility.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { makeCtx } from './context.js';
import { isAuthActive, pickupEligibility, pickupCandidates, authorizedFor } from './eligibility.js';
import { evaluateAutoApprove } from './autoapprove.js';

const ctxFor = (t, userId) => t.db.tx((q) => makeCtx(q, t.deps, userId));

test('isAuthActive follows type, window, use and revocation', () => {
  const today = '2026-09-18';
  assert.equal(isAuthActive({ type: 'siempre' }, today), true);
  assert.equal(isAuthActive({ type: 'siempre', revokedAt: 1 }, today), false);
  assert.equal(isAuthActive({ type: 'temporal', validFrom: '2026-09-16', validTo: '2026-09-30' }, today), true);
  assert.equal(isAuthActive({ type: 'temporal', validFrom: '2026-09-19', validTo: '2026-09-30' }, today), false);
  assert.equal(isAuthActive({ type: 'una_vez' }, today), true);
  assert.equal(isAuthActive({ type: 'una_vez', usedAt: 1 }, today), false);
});

test('eligibility distinguishes titular, authorized and strangers', async () => {
  const t = await makeTestApp();
  const ctx = await ctxFor(t, 'u_p1');
  assert.deepEqual(await pickupEligibility(ctx, 'e1', 'p1'), { ok: true, kind: 'titular' });
  assert.equal((await pickupEligibility(ctx, 'e1', 'p3')).kind, 'siempre');
  assert.equal((await pickupEligibility(ctx, 'e1', 'p4')).kind, 'temporal');
  assert.equal((await pickupEligibility(ctx, 'e1', 'p5')).kind, 'una_vez');
  assert.equal((await pickupEligibility(ctx, 'e1', 'p7')).ok, false);
  assert.equal((await pickupEligibility(ctx, 'e3', 'p3')).ok, false);
  const cands = await pickupCandidates(ctx, 'e1');
  assert.deepEqual(cands.map((c) => c.person.id + ':' + c.kind), ['p1:titular', 'p2:titular', 'p3:siempre', 'p4:temporal', 'p5:una_vez']);
  const forLaura = await authorizedFor(ctx, 'p5');
  assert.deepEqual(forLaura.map((x) => x.student.id), ['e1']);
  await t.close();
});

test('auto-approval rule returns the prototype reasons', async () => {
  const t = await makeTestApp(); // now = 10:30 Panama
  const ctx = await ctxFor(t, 'u_p1');
  const base = { studentId: 'e1', requestedBy: 'p1', pickupBy: 'p1', date: '2026-09-18', time: '13:00' };
  const st = { titulares: ['p1', 'p2'] };
  assert.deepEqual(await evaluateAutoApprove(ctx, base, st), { ok: true });
  assert.equal((await evaluateAutoApprove(ctx, { ...base, time: '11:00' }, st)).reason, 'menos de 60 min de anticipación');
  assert.equal((await evaluateAutoApprove(ctx, { ...base, requestedBy: 'p3' }, st)).reason, 'el solicitante no es titular');
  assert.equal((await evaluateAutoApprove(ctx, { ...base, pickupBy: 'p7' }, st)).reason, 'la persona que retira no está autorizada');
  assert.equal((await evaluateAutoApprove(ctx, { ...base, pickupBy: 'p5' }, st)).reason, 'autorización de una sola vez requiere revisión');
  assert.equal((await evaluateAutoApprove({ ...ctx, settings: { ...ctx.settings, autoApprove: false } }, base, st)).reason, 'auto-aprobación desactivada');
  await t.db.query("INSERT INTO requests(id, kind, student_id, requested_by, date, channel, status, created_at) VALUES ('rx','salida','e1','p1','2026-09-10','web','rechazada', $1)", [new Date('2026-09-10T15:00:00Z').toISOString()]);
  assert.equal((await evaluateAutoApprove(ctx, base, st)).reason, 'el estudiante tiene un rechazo reciente');
  await t.close();
});
```

`server/domain/notifications.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { makeCtx } from './context.js';
import { notifyPerson, notifyRole, notifyTeachers, logEvent } from './notifications.js';
import { listNotifications, listChat, listAudit } from '../db/repo.js';

test('notifyPerson stores a notification and mirrors it to the WhatsApp chat when the person has a phone', async () => {
  const t = await makeTestApp();
  await t.db.tx(async (q) => {
    const ctx = await makeCtx(q, t.deps, 'u_s2', { command: 'x' });
    await notifyPerson(ctx, 'p1', 'hola Carlos', { buttons: ['Sí', 'No'] });
    await notifyRole(ctx, 'garita', 'aviso garita');
    await notifyTeachers(ctx, 'e1', 'aviso 3°');
    await logEvent(ctx, 'hizo algo', 'Yadira Batista');
  });
  const n = await listNotifications(t.db, { personId: 'p1' });
  assert.equal(n.length, 1);
  assert.deepEqual(n[0].buttons, ['Sí', 'No']);
  assert.equal(n[0].read, false);
  const chat = await listChat(t.db, 'p1');
  assert.equal(chat.length, 1);
  assert.equal(chat[0].from, 'bot');
  assert.equal(chat[0].pendingUntil, null, 'notifications are not typed, they arrive instantly');
  assert.equal((await listNotifications(t.db, { role: 'garita' })).length, 1);
  assert.equal((await listNotifications(t.db, { staffId: 's3' })).length, 1, 'Diana teaches 3°');
  assert.equal((await listNotifications(t.db, { staffId: 's4' })).length, 0);
  const audit = await listAudit(t.db, 1);
  assert.equal(audit[0].summary, 'hizo algo');
  assert.equal(audit[0].actorName, 'Yadira Batista');
  await t.close();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test server/domain/eligibility.test.js server/domain/notifications.test.js`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement the three modules**

`server/domain/eligibility.js`:

```js
import { getStudent, getPerson, listAuthorizations, studentsOfPerson } from '../db/repo.js';
import { todayISO } from './time.js';

export const todayOf = (ctx) => todayISO(ctx.now, ctx.tz);

export function isAuthActive(a, today) {
  if (a.revokedAt) return false;
  if (a.type === 'siempre') return true;
  if (a.type === 'temporal') return a.validFrom <= today && today <= a.validTo;
  if (a.type === 'una_vez') return !a.usedAt;
  return false;
}
export async function pickupEligibility(ctx, studentId, personId) {
  const st = await getStudent(ctx.q, studentId);
  if (!st || !personId) return { ok: false };
  if (st.titulares.includes(personId)) return { ok: true, kind: 'titular' };
  const today = todayOf(ctx);
  const a = (await listAuthorizations(ctx.q, { studentIds: [studentId], personId })).find((x) => isAuthActive(x, today));
  return a ? { ok: true, kind: a.type, auth: a } : { ok: false };
}
export async function pickupCandidates(ctx, studentId) {
  const st = await getStudent(ctx.q, studentId);
  if (!st) return [];
  const today = todayOf(ctx);
  const list = [];
  for (const id of st.titulares) list.push({ person: await getPerson(ctx.q, id), kind: 'titular' });
  for (const a of await listAuthorizations(ctx.q, { studentIds: [studentId], includeRevoked: false })) {
    if (isAuthActive(a, today)) list.push({ person: await getPerson(ctx.q, a.personId), kind: a.type, auth: a });
  }
  return list;
}
export async function authorizedFor(ctx, personId) {
  const today = todayOf(ctx);
  const out = [];
  for (const a of await listAuthorizations(ctx.q, { personId, includeRevoked: false })) {
    if (!isAuthActive(a, today)) continue;
    const st = await getStudent(ctx.q, a.studentId);
    if (st && !st.titulares.includes(personId)) out.push({ auth: a, student: st });
  }
  return out;
}
export const studentsOf = (ctx, personId) => studentsOfPerson(ctx.q, personId);
```

`server/domain/autoapprove.js`:

```js
import { listRequests } from '../db/repo.js';
import { localToMs } from './time.js';
import { pickupEligibility } from './eligibility.js';

export async function evaluateAutoApprove(ctx, req, st) {
  const cfg = ctx.settings;
  if (!cfg.autoApprove) return { ok: false, reason: 'auto-aprobación desactivada' };
  if (!st.titulares.includes(req.requestedBy)) return { ok: false, reason: 'el solicitante no es titular' };
  const mins = Math.round((localToMs(req.date, req.time, ctx.tz) - ctx.now.getTime()) / 60000);
  if (mins < cfg.minAnticipationMin) return { ok: false, reason: 'menos de ' + cfg.minAnticipationMin + ' min de anticipación' };
  const el = await pickupEligibility(ctx, req.studentId, req.pickupBy);
  if (!el.ok) return { ok: false, reason: 'la persona que retira no está autorizada' };
  if (el.kind === 'una_vez') return { ok: false, reason: 'autorización de una sola vez requiere revisión' };
  const cutoff = ctx.now.getTime() - 30 * 24 * 3600 * 1000;
  const rejected = (await listRequests(ctx.q, { studentIds: [req.studentId], status: 'rechazada' })).some((r) => r.createdAt > cutoff);
  if (rejected) return { ok: false, reason: 'el estudiante tiene un rechazo reciente' };
  return { ok: true };
}
```

`server/domain/notifications.js`:

```js
import { uid } from './ids.js';
import { insertNotification, getPerson, getStudent, listStaff, insertAudit } from '../db/repo.js';

export const actorLabel = (ctx) => (ctx.staff && ctx.staff.name) || (ctx.person && ctx.person.name) || 'Sistema';

export async function notifyPerson(ctx, personId, text, opts = {}) {
  const p = await getPerson(ctx.q, personId);
  if (!p) return;
  await insertNotification(ctx.q, { id: uid('n'), personId, text, kind: opts.kind || 'info', buttons: opts.buttons || null }, ctx.now);
  if (p.phone) await ctx.transport.send(ctx, personId, { text, buttons: opts.buttons || null });
}
export async function notifyRole(ctx, role, text) {
  await insertNotification(ctx.q, { id: uid('n'), role, text, kind: 'school' }, ctx.now);
}
export async function notifyStaff(ctx, staffId, text) {
  await insertNotification(ctx.q, { id: uid('n'), staffId, text, kind: 'school' }, ctx.now);
}
export async function notifyTeachers(ctx, studentId, text) {
  const st = await getStudent(ctx.q, studentId);
  if (!st) return;
  for (const s of await listStaff(ctx.q)) if (s.role === 'profesor' && (s.grades || []).includes(st.grade)) await notifyStaff(ctx, s.id, text);
}
export async function logEvent(ctx, text, actorName = 'Sistema') {
  await insertAudit(ctx.q, {
    at: ctx.now, actorUserId: ctx.user ? ctx.user.id : null, actorRole: ctx.user ? ctx.user.role : 'system', actorName,
    command: ctx.command || null, channel: ctx.channel || null, summary: text,
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/domain/eligibility.test.js server/domain/notifications.test.js`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/domain/eligibility.js server/domain/autoapprove.js server/domain/notifications.js server/domain/eligibility.test.js server/domain/notifications.test.js
git commit -m "Add pickup eligibility, auto-approval rule and notification helpers" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Request lifecycle (salida / excusa) as domain functions and commands

**Files:**
- Create: `server/domain/requests.js`, `server/commands/requests.js`
- Modify: `server/commands/all.js` (add `import './requests.js';`)
- Test: `server/commands/requests.test.js`

**Interfaces:**
- Produces (domain): `createRequest(ctx, data) → request`, `approveRequest(ctx, id, { auto?, by?, pickupPoint? })`, `rejectRequest(ctx, id, reason, byStaffId)`, `acceptExcusa(ctx, id, byStaffId)`, `cancelRequest(ctx, id, personId)`, `describePickup(req, pickupPerson)`; the confirmation/exit functions come in Task 7 in the same file.
- Produces (commands): `create_salida {studentId, date, time, pickupBy, reason}`, `create_excusa {studentId, date, excusaType, reason, attachmentId?, attachmentName?}`, `cancel_request {requestId}`, `approve_request {requestId, pickupPoint}`, `reject_request {requestId, reason}`, `accept_excusa {requestId}`. All return the hydrated request.

- [ ] **Step 1: Write the failing test**

`server/commands/requests.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { listNotifications, getConversation, listAudit, getRequest } from '../db/repo.js';

const texts = async (db, target) => (await listNotifications(db, target)).map((n) => n.text);

test('a titular request with enough anticipation is auto-approved and everyone is told', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'Cita médica' });
  assert.equal(r.status, 'aprobada');
  assert.equal(r.autoApproved, true);
  assert.equal(r.pickupPoint, 'Puerta Principal');
  assert.match(r.code, /^\d{4}$/);
  assert.equal(r.pickupKind, 'titular');
  assert.equal(r.history[0].text, 'Solicitud creada por Carlos Rodríguez vía App');
  assert.match(r.history[1].text, /^Aprobada automáticamente/);
  const ana = await texts(t.db, { personId: 'p2' });
  assert.match(ana[0], /^ℹ️ Carlos Rodríguez solicitó salida de Joseph Rodríguez hoy a las 1:00 pm/);
  assert.match(ana[1], /^✅ Salida aprobada: Joseph Rodríguez hoy a las 1:00 pm\. Retira: Carlos Rodríguez \(solicitante\)\. Punto de retiro: Puerta Principal\. Código: \d{4}\.$/);
  assert.match((await texts(t.db, { role: 'garita' }))[0], /^Salida aprobada: Joseph Rodríguez 1:00 pm · retira Carlos Rodríguez · Puerta Principal$/);
  assert.equal((await texts(t.db, { staffId: 's3' })).length, 1);
  assert.equal((await listAudit(t.db, 1))[0].summary, 'Auto-aprobó salida de Joseph Rodríguez · Puerta Principal');
  await t.close();
});

test('short notice goes to reception, who approves with a pickup point', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '11:00', pickupBy: 'p1', reason: 'x' });
  assert.equal(r.status, 'pendiente');
  assert.equal(r.history[1].text, 'Pendiente de revisión: menos de 60 min de anticipación');
  assert.match((await texts(t.db, { role: 'recepcion' }))[0], /menos de 60 min de anticipación$/);
  const { result: a } = await t.run('approve_request', 'u_s2', { requestId: r.id, pickupPoint: 'Recepción' });
  assert.equal(a.status, 'aprobada');
  assert.equal(a.decidedBy, 's2');
  assert.equal(a.pickupPoint, 'Recepción');
  assert.equal(a.history[2].text, 'Aprobada por Yadira Batista · Recepción');
  await assert.rejects(t.run('approve_request', 'u_s2', { requestId: r.id, pickupPoint: 'Recepción' }), /request_not_pending/);
  await t.close();
});

test('roles and family scope are enforced', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('create_salida', 'u_p5', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p5', reason: 'x' }), /forbidden_not_titular/);
  await assert.rejects(t.run('create_salida', 'u_s2', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' }), /forbidden_role/);
  const { result: r } = await t.run('create_salida', 'u_p7', { studentId: 'e4', date: '2026-09-18', time: '11:00', pickupBy: 'p7', reason: 'x' });
  await assert.rejects(t.run('cancel_request', 'u_p1', { requestId: r.id }), /forbidden_not_titular/);
  await assert.rejects(t.run('approve_request', 'u_s3', { requestId: r.id }), /forbidden_capability:aprobar/);
  await assert.rejects(t.run('approve_request', 'u_s6', { requestId: r.id }), /forbidden_capability:aprobar/);
  const { result: c } = await t.run('cancel_request', 'u_p7', { requestId: r.id });
  assert.equal(c.status, 'cancelada');
  assert.match((await texts(t.db, { role: 'recepcion' })).at(-1), /^Solicitud cancelada por el padre: Emily Chen 11:00 am$/);
  assert.match((await texts(t.db, { role: 'garita' })).at(-1), /^Salida cancelada: Emily Chen 11:00 am$/);
  await assert.rejects(t.run('cancel_request', 'u_p7', { requestId: r.id }), /request_not_cancellable/);
  await t.close();
});

test('rejection needs a reason and notifies both titulares', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('reject_request', 'u_s2', { requestId: 'r_h3', reason: '  ' }), /reason_required/);
  const { result: r } = await t.run('reject_request', 'u_s2', { requestId: 'r_h3', reason: 'Examen en curso' });
  assert.equal(r.status, 'rechazada');
  assert.equal(r.rejectReason, 'Examen en curso');
  assert.match((await texts(t.db, { personId: 'p7' }))[0], /^❌ Salida de Emily Chen hoy 12:15 pm no fue aprobada\. Motivo: Examen en curso\. Contacta a recepción al \+507 6800-0000\.$/);
  await t.close();
});

test('excuses are created pending and accepted by reception', async () => {
  const t = await makeTestApp();
  const { result: e } = await t.run('create_excusa', 'u_p7', { studentId: 'e4', date: '2026-09-19', excusaType: 'ausencia', reason: 'Cita médica', attachmentName: 'certificado.jpg' });
  assert.equal(e.status, 'pendiente');
  assert.equal(e.kind, 'excusa');
  assert.equal(e.attachmentName, 'certificado.jpg');
  assert.match((await texts(t.db, { personId: 'p7' }))[0], /^📝 Excusa recibida para Emily Chen \(ausencia · mañana\)/);
  assert.match((await texts(t.db, { role: 'recepcion' }))[0], /^Nueva excusa: Emily Chen \(9°\) · ausencia mañana$/);
  assert.equal((await texts(t.db, { staffId: 's4' })).length, 1, 'Jorge teaches 9°');
  await assert.rejects(t.run('accept_excusa', 'u_s3', { requestId: e.id }), /forbidden_capability:decidir_excusas/);
  const { result: a } = await t.run('accept_excusa', 'u_s2', { requestId: e.id });
  assert.equal(a.status, 'aceptada');
  assert.match((await texts(t.db, { personId: 'p7' })).at(-1), /^✅ Excusa aceptada: Emily Chen · ausencia mañana/);
  await t.close();
});

test('unusual pickups trigger the proactive alert with buttons and a chat step', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p4', reason: 'x' });
  assert.equal(r.status, 'aprobada', 'temporal authorizations still auto-approve');
  assert.equal(r.pickupKind, 'temporal');
  const alerts = (await listNotifications(t.db, { personId: 'p2' })).filter((n) => n.text.startsWith('⚠️ AVISO'));
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].buttons, ['Es correcto', 'NO']);
  assert.match(alerts[0].text, /autorización por tiempo \(2026-09-16 → 2026-09-30\)/);
  assert.deepEqual(await getConversation(t.db, 'p1'), { step: 'alert_pickup', requestId: r.id, draft: null });
  assert.deepEqual(await getConversation(t.db, 'p2'), { step: 'alert_pickup', requestId: r.id, draft: null });
  await t.close();
});

test('one-time authorizations need manual approval and announce the gate confirmation', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p5', reason: 'x' });
  assert.equal(r.status, 'pendiente');
  assert.equal(r.history[1].text, 'Pendiente de revisión: autorización de una sola vez requiere revisión');
  const { result: a } = await t.run('approve_request', 'u_s2', { requestId: r.id, pickupPoint: 'Puerta Principal' });
  assert.ok(a.history.some((h) => h.text === 'Requiere confirmación del titular cuando la persona llegue a la garita'));
  assert.match((await texts(t.db, { personId: 'p1' })).find((x) => x.startsWith('✅')), /Te pediremos confirmar cuando la persona llegue a la garita/);
  assert.match((await texts(t.db, { personId: 'p5' })).at(-1), /^👋 Estás autorizado\(a\) para retirar a Joseph Rodríguez hoy a las 1:00 pm por Puerta Principal/);
  assert.equal((await getRequest(t.db, r.id)).status, 'aprobada');
  await t.close();
});

test('input validation', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'e1', date: '18/09/2026', time: '13:00', pickupBy: 'p1', reason: 'x' }), /invalid_date/);
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '1pm', pickupBy: 'p1', reason: 'x' }), /invalid_time/);
  await assert.rejects(t.run('create_salida', 'u_p1', { studentId: 'nope', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' }), /student_not_found/);
  await t.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/commands/requests.test.js`
Expected: FAIL, `unknown_command` (registry empty).

- [ ] **Step 3: Implement `server/domain/requests.js`**

```js
import { uid } from './ids.js';
import { HttpError, notFound, conflict, badRequest } from './errors.js';
import { insertRequest, getRequest, patchRow, addRequestEvent, getStudent, getPerson, getStaff, listRequests, upsertConfirmation, setConversation, getConversation, clearConversation } from '../db/repo.js';
import { notifyPerson, notifyRole, notifyTeachers, logEvent } from './notifications.js';
import { pickupEligibility } from './eligibility.js';
import { evaluateAutoApprove } from './autoapprove.js';
import { fmtDate, fmtTime, firstName, CHANNEL, roleName } from './text.js';
import { nowHHMM } from './time.js';

export function describePickup(req, pk) {
  if (!pk) return '';
  return pk.name + (req.pickupBy === req.requestedBy ? ' (solicitante)' : ' (' + pk.relation + ')');
}
const hist = (ctx, req, text) => addRequestEvent(ctx.q, req.id, ctx.now, text);
async function uniqueCode(ctx, date) {
  const used = new Set((await listRequests(ctx.q, { date, kind: 'salida' })).map((r) => r.code));
  for (;;) { const c = String(1000 + Math.floor(Math.random() * 9000)); if (!used.has(c)) return c; }
}
async function loadSalida(ctx, id) {
  const req = await getRequest(ctx.q, id);
  if (!req) notFound('request_not_found');
  return req;
}

export async function createRequest(ctx, data) {
  const st = await getStudent(ctx.q, data.studentId);
  if (!st) notFound('student_not_found');
  const by = await getPerson(ctx.q, data.requestedBy);
  if (!by) notFound('person_not_found');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date || '')) badRequest('invalid_date');
  const req = { id: uid('r'), kind: data.kind, studentId: st.id, requestedBy: by.id, date: data.date, reason: String(data.reason || ''), channel: data.channel === 'whatsapp' ? 'whatsapp' : 'web', status: 'pendiente', createdAt: ctx.now, autoApproved: false };
  if (req.kind === 'salida') {
    if (!/^\d{2}:\d{2}$/.test(data.time || '')) badRequest('invalid_time');
    req.time = data.time;
    req.pickupBy = data.pickupBy || by.id;
    req.code = await uniqueCode(ctx, req.date);
    const el = await pickupEligibility(ctx, st.id, req.pickupBy);
    req.pickupKind = el.kind || 'no_autorizado';
  } else if (req.kind === 'excusa') {
    req.excusaType = data.excusaType === 'tardanza' ? 'tardanza' : 'ausencia';
    req.attachmentId = data.attachmentId || null;
    req.attachmentName = data.attachmentName || null;
  } else badRequest('invalid_kind');
  await insertRequest(ctx.q, req);
  const ch = CHANNEL[req.channel];
  const others = st.titulares.filter((t) => t !== by.id);
  if (req.kind === 'salida') {
    const pk = await getPerson(ctx.q, req.pickupBy);
    await hist(ctx, req, 'Solicitud creada por ' + by.name + ' vía ' + ch);
    await logEvent(ctx, 'Solicitud de salida de ' + st.name + ' creada por ' + by.name + ' (' + ch + ')');
    for (const t of others) await notifyPerson(ctx, t, 'ℹ️ ' + by.name + ' solicitó salida de ' + st.name + ' ' + fmtDate(ctx, req.date) + ' a las ' + fmtTime(req.time) + '. Retira: ' + describePickup(req, pk) + '.');
    const ev = await evaluateAutoApprove(ctx, req, st);
    if (ev.ok) {
      await approveRequest(ctx, req.id, { auto: true, pickupPoint: ctx.settings.defaultPickupPoint });
    } else {
      await hist(ctx, req, 'Pendiente de revisión: ' + ev.reason);
      await notifyPerson(ctx, by.id, '📝 Recibimos tu solicitud de salida de ' + st.name + ' ' + fmtDate(ctx, req.date) + ' a las ' + fmtTime(req.time) + '. Te avisamos en cuanto la escuela la apruebe.');
      await notifyRole(ctx, 'recepcion', 'Nueva solicitud de salida: ' + st.name + ' (' + st.grade + ') ' + fmtDate(ctx, req.date) + ' ' + fmtTime(req.time) + ' · ' + ev.reason);
      await notifyTeachers(ctx, st.id, 'Solicitud de salida pendiente: ' + st.name + ' ' + fmtTime(req.time));
    }
  } else {
    await hist(ctx, req, 'Excusa enviada por ' + by.name + ' vía ' + ch);
    await logEvent(ctx, 'Excusa (' + req.excusaType + ') de ' + st.name + ' enviada por ' + by.name + ' (' + ch + ')');
    await notifyPerson(ctx, by.id, '📝 Excusa recibida para ' + st.name + ' (' + req.excusaType + ' · ' + fmtDate(ctx, req.date) + '). Te avisamos cuando sea revisada.');
    for (const t of others) await notifyPerson(ctx, t, 'ℹ️ ' + by.name + ' envió una excusa de ' + req.excusaType + ' para ' + st.name + ' (' + fmtDate(ctx, req.date) + ').');
    await notifyRole(ctx, 'recepcion', 'Nueva excusa: ' + st.name + ' (' + st.grade + ') · ' + req.excusaType + ' ' + fmtDate(ctx, req.date));
    await notifyTeachers(ctx, st.id, 'Excusa de ' + req.excusaType + ' para ' + st.name + ' (' + fmtDate(ctx, req.date) + ')');
  }
  return getRequest(ctx.q, req.id);
}

export async function approveRequest(ctx, id, opts = {}) {
  const req = await loadSalida(ctx, id);
  if (req.kind !== 'salida' || req.status !== 'pendiente') conflict('request_not_pending');
  const st = await getStudent(ctx.q, req.studentId);
  const pk = await getPerson(ctx.q, req.pickupBy);
  const staff = opts.auto ? null : await getStaff(ctx.q, opts.by);
  const pickupPoint = opts.pickupPoint || ctx.settings.defaultPickupPoint;
  await patchRow(ctx.q, 'requests', id, { status: 'aprobada', pickupPoint, decidedAt: ctx.now, autoApproved: !!opts.auto, decidedBy: opts.auto ? 'auto' : opts.by });
  const who = opts.auto ? 'Aprobada automáticamente (regla: titular, anticipación, autorizado vigente)' : 'Aprobada por ' + staff.name;
  await hist(ctx, req, who + ' · ' + pickupPoint);
  await logEvent(ctx, (opts.auto ? 'Auto-aprobó' : 'Aprobó') + ' salida de ' + st.name + ' · ' + pickupPoint, opts.auto ? 'Sistema' : staff.name);
  const needsConfirm = req.pickupKind === 'una_vez';
  const msg = '✅ Salida aprobada: ' + st.name + ' ' + fmtDate(ctx, req.date) + ' a las ' + fmtTime(req.time) + '. Retira: ' + describePickup(req, pk) +
    '. Punto de retiro: ' + pickupPoint + '. Código: ' + req.code + '.' + (needsConfirm ? ' ⚠️ Te pediremos confirmar cuando la persona llegue a la garita.' : '');
  for (const t of st.titulares) await notifyPerson(ctx, t, msg);
  if (pk.hasAccount && !st.titulares.includes(pk.id)) {
    await notifyPerson(ctx, pk.id, '👋 Estás autorizado(a) para retirar a ' + st.name + ' ' + fmtDate(ctx, req.date) + ' a las ' + fmtTime(req.time) + ' por ' + pickupPoint + '. Presenta tu cédula. Código: ' + req.code + '.');
  }
  if (needsConfirm) await hist(ctx, req, 'Requiere confirmación del titular cuando la persona llegue a la garita');
  // Aviso proactivo: solo cuando retira una persona nueva o con autorización temporal / de una vez
  const el = await pickupEligibility(ctx, req.studentId, req.pickupBy);
  const ageDays = el.auth ? Math.floor((ctx.now.getTime() - el.auth.createdAt) / 86400000) : null;
  const unusual = el.kind === 'temporal' || el.kind === 'una_vez' || (el.auth && ageDays < ctx.settings.newAuthDays);
  if (unusual) {
    const why = el.kind === 'temporal' ? 'autorización por tiempo (' + el.auth.validFrom + ' → ' + el.auth.validTo + ')' : el.kind === 'una_vez' ? 'autorización de una sola vez' : 'autorización registrada hace ' + ageDays + ' día(s)';
    await hist(ctx, req, 'Aviso proactivo a los titulares: persona ' + (el.kind === 'siempre' ? 'nueva' : el.kind));
    for (const t of st.titulares) {
      await notifyPerson(ctx, t, '⚠️ AVISO: hoy retira a ' + firstName(st.name) + ' ' + pk.name + ' (' + pk.relation + ') con ' + why + '. Si no lo reconoces responde NO y se cancela la salida.', { buttons: ['Es correcto', 'NO'] });
      await setConversation(ctx.q, t, { step: 'alert_pickup', requestId: req.id }, ctx.now);
    }
  }
  await notifyRole(ctx, 'garita', 'Salida aprobada: ' + st.name + ' ' + fmtTime(req.time) + ' · retira ' + pk.name + ' · ' + pickupPoint);
  await notifyTeachers(ctx, st.id, 'Salida aprobada: ' + st.name + ' ' + fmtTime(req.time));
  return getRequest(ctx.q, id);
}

export async function rejectRequest(ctx, id, reason, byStaffId) {
  const req = await loadSalida(ctx, id);
  if (req.status !== 'pendiente') conflict('request_not_pending');
  const st = await getStudent(ctx.q, req.studentId);
  const staff = await getStaff(ctx.q, byStaffId);
  await patchRow(ctx.q, 'requests', id, { status: 'rechazada', decidedAt: ctx.now, decidedBy: byStaffId, rejectReason: reason });
  await hist(ctx, req, 'Rechazada por ' + staff.name + ': ' + reason);
  await logEvent(ctx, 'Rechazó ' + (req.kind === 'salida' ? 'salida' : 'excusa') + ' de ' + st.name + ': ' + reason, staff.name);
  const what = req.kind === 'salida' ? 'Salida de ' + st.name + ' ' + fmtDate(ctx, req.date) + ' ' + fmtTime(req.time) : 'Excusa de ' + st.name + ' (' + fmtDate(ctx, req.date) + ')';
  for (const t of st.titulares) await notifyPerson(ctx, t, '❌ ' + what + ' no fue aprobada. Motivo: ' + reason + '. Contacta a recepción al ' + ctx.settings.school.phone + '.');
  return getRequest(ctx.q, id);
}

export async function acceptExcusa(ctx, id, byStaffId) {
  const req = await loadSalida(ctx, id);
  if (req.kind !== 'excusa' || req.status !== 'pendiente') conflict('request_not_pending');
  const st = await getStudent(ctx.q, req.studentId);
  const staff = await getStaff(ctx.q, byStaffId);
  await patchRow(ctx.q, 'requests', id, { status: 'aceptada', decidedAt: ctx.now, decidedBy: byStaffId });
  await hist(ctx, req, 'Aceptada por ' + staff.name);
  await logEvent(ctx, 'Aceptó excusa de ' + st.name + ' (' + req.excusaType + ' ' + fmtDate(ctx, req.date) + ')', staff.name);
  for (const t of st.titulares) await notifyPerson(ctx, t, '✅ Excusa aceptada: ' + st.name + ' · ' + req.excusaType + ' ' + fmtDate(ctx, req.date) + '. Quedó registrada para su docente.');
  await notifyTeachers(ctx, st.id, 'Excusa aceptada: ' + st.name + ' · ' + req.excusaType + ' ' + fmtDate(ctx, req.date));
  return getRequest(ctx.q, id);
}

export async function cancelRequest(ctx, id, personId) {
  const req = await loadSalida(ctx, id);
  if (!['pendiente', 'aprobada'].includes(req.status)) conflict('request_not_cancellable');
  const st = await getStudent(ctx.q, req.studentId);
  const p = await getPerson(ctx.q, personId);
  await patchRow(ctx.q, 'requests', id, { status: 'cancelada' });
  await hist(ctx, req, 'Cancelada por ' + p.name);
  await logEvent(ctx, 'Canceló solicitud de ' + st.name, p.name);
  await notifyRole(ctx, 'recepcion', 'Solicitud cancelada por el padre: ' + st.name + ' ' + (req.time ? fmtTime(req.time) : fmtDate(ctx, req.date)));
  if (req.kind === 'salida') await notifyRole(ctx, 'garita', 'Salida cancelada: ' + st.name + ' ' + fmtTime(req.time));
  return getRequest(ctx.q, id);
}

/* ---------- garita: confirmación una_vez y retiro (used by Task 7) ---------- */
export async function requestConfirmation(ctx, id, byStaffId) {
  const req = await loadSalida(ctx, id);
  if (req.kind !== 'salida' || req.status !== 'aprobada') conflict('request_not_approved');
  if (req.pickupKind !== 'una_vez') conflict('confirmation_not_needed');
  const st = await getStudent(ctx.q, req.studentId);
  const pk = await getPerson(ctx.q, req.pickupBy);
  const staff = await getStaff(ctx.q, byStaffId);
  await upsertConfirmation(ctx.q, { requestId: id, status: 'pendiente', requestedByStaff: byStaffId, requestedAt: ctx.now, answeredByPerson: null, answeredAt: null });
  await hist(ctx, req, 'Garita solicitó confirmación a los titulares (' + pk.name + ' presente)');
  await logEvent(ctx, 'Solicitó confirmación de entrega de ' + st.name + ' a ' + pk.name, staff.name);
  for (const t of st.titulares) {
    await notifyPerson(ctx, t, '⚠️ ' + pk.name + ' (' + pk.relation + ') está en la garita para retirar a ' + st.name + '. Es una autorización de UNA SOLA VEZ. ¿Confirmas la entrega? Responde SÍ o NO.', { buttons: ['Sí, confirmo', 'No'] });
    await setConversation(ctx.q, t, { step: 'confirm_pickup', requestId: id }, ctx.now);
  }
  return getRequest(ctx.q, id);
}

export async function confirmPickup(ctx, id, personId, yes) {
  const req = await loadSalida(ctx, id);
  if (req.status !== 'aprobada') conflict('request_not_approved');
  const st = await getStudent(ctx.q, req.studentId);
  const pk = await getPerson(ctx.q, req.pickupBy);
  const p = await getPerson(ctx.q, personId);
  await upsertConfirmation(ctx.q, { requestId: id, status: yes ? 'confirmada' : 'negada', requestedByStaff: null, requestedAt: null, answeredByPerson: personId, answeredAt: ctx.now });
  await hist(ctx, req, (yes ? 'Entrega confirmada' : 'Entrega NEGADA') + ' por ' + p.name);
  await logEvent(ctx, (yes ? 'Confirmó' : 'Negó') + ' la entrega de ' + st.name + ' a ' + pk.name, p.name);
  await notifyRole(ctx, 'garita', (yes ? '✅ Confirmado' : '⛔ NEGADO') + ' por ' + p.name + ': entrega de ' + st.name + ' a ' + pk.name);
  for (const t of st.titulares.filter((x) => x !== personId)) {
    await notifyPerson(ctx, t, (yes ? '✅ ' : '⛔ ') + p.name + (yes ? ' confirmó' : ' negó') + ' la entrega de ' + st.name + ' a ' + pk.name + '.');
    const cs = await getConversation(ctx.q, t);
    if (cs && cs.step === 'confirm_pickup') await clearConversation(ctx.q, t);
  }
  await clearConversation(ctx.q, personId);
  return getRequest(ctx.q, id);
}

export async function markExit(ctx, id, byStaffId) {
  const req = await loadSalida(ctx, id);
  if (req.kind !== 'salida' || req.status !== 'aprobada') conflict('request_not_approved');
  const st = await getStudent(ctx.q, req.studentId);
  const pk = await getPerson(ctx.q, req.pickupBy);
  const officer = await getStaff(ctx.q, byStaffId);
  const el = await pickupEligibility(ctx, req.studentId, req.pickupBy);
  if (!el.ok) throw new HttpError(409, 'pickup_not_authorized', pk.name + ' ya no tiene autorización vigente para ' + st.name + '.');
  if (el.kind === 'una_vez' && !(req.confirmation && req.confirmation.status === 'confirmada')) {
    throw new HttpError(409, 'confirmation_required', 'Autorización de una sola vez: primero solicita la confirmación del titular.');
  }
  await patchRow(ctx.q, 'requests', id, { status: 'retirado', exitAt: ctx.now, exitBy: byStaffId });
  if (el.auth && el.auth.type === 'una_vez') await patchRow(ctx.q, 'authorizations', el.auth.id, { usedAt: ctx.now });
  await hist(ctx, req, 'Retirado por ' + pk.name + ' · marcado en garita por ' + officer.name);
  await logEvent(ctx, 'Marcó retirado a ' + st.name + ' (' + pk.name + ')', officer.name);
  const hora = fmtTime(nowHHMM(ctx.now, ctx.tz));
  for (const t of st.titulares) {
    await notifyPerson(ctx, t, '🚪 ' + st.name + ' salió por ' + req.pickupPoint + ' a las ' + hora + ', retirado(a) por ' + describePickup(req, pk) + '. Confirmó ' + officer.name + ' (' + (officer.title || roleName(officer.role)) + ').');
    const cs = await getConversation(ctx.q, t);
    if (cs && cs.step === 'alert_pickup') await clearConversation(ctx.q, t);
  }
  if (pk.hasAccount && !st.titulares.includes(pk.id)) await notifyPerson(ctx, pk.id, '🚪 Registramos que retiraste a ' + st.name + ' a las ' + hora + '. ¡Gracias!');
  await notifyTeachers(ctx, st.id, st.name + ' salió a las ' + hora);
  return getRequest(ctx.q, id);
}
```

- [ ] **Step 4: Implement `server/commands/requests.js` and register it**

```js
import { register } from './index.js';
import { requireCap, requireTitular, STAFF_ROLES } from './guards.js';
import { createRequest, approveRequest, rejectRequest, acceptExcusa, cancelRequest } from '../domain/requests.js';
import { getRequest, getAttachment } from '../db/repo.js';
import { deny, notFound, badRequest, conflict } from '../domain/errors.js';

async function ownRequest(ctx, requestId) {
  const r = await getRequest(ctx.q, requestId);
  if (!r) notFound('request_not_found');
  await requireTitular(ctx, r.studentId);
  return r;
}

register({
  create_salida: {
    roles: ['parent'],
    handler: async (ctx, input) => {
      await requireTitular(ctx, input.studentId);
      return createRequest(ctx, { kind: 'salida', channel: 'web', requestedBy: ctx.person.id, studentId: input.studentId, date: input.date, time: input.time, pickupBy: input.pickupBy || ctx.person.id, reason: input.reason });
    },
  },
  create_excusa: {
    roles: ['parent'],
    handler: async (ctx, input) => {
      await requireTitular(ctx, input.studentId);
      if (input.attachmentId) {
        const a = await getAttachment(ctx.q, input.attachmentId);
        if (!a || a.ownerPersonId !== ctx.person.id) deny('forbidden_attachment');
      }
      return createRequest(ctx, { kind: 'excusa', channel: 'web', requestedBy: ctx.person.id, studentId: input.studentId, date: input.date, excusaType: input.excusaType, reason: input.reason, attachmentId: input.attachmentId || null, attachmentName: input.attachmentName || null });
    },
  },
  cancel_request: {
    roles: ['parent'],
    handler: async (ctx, input) => {
      const r = await ownRequest(ctx, input.requestId);
      if (!['pendiente', 'aprobada'].includes(r.status)) conflict('request_not_cancellable');
      return cancelRequest(ctx, r.id, ctx.person.id);
    },
  },
  approve_request: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => {
      requireCap(ctx, 'aprobar');
      const points = ctx.settings.school.pickupPoints || [];
      const pickupPoint = points.includes(input.pickupPoint) ? input.pickupPoint : ctx.settings.defaultPickupPoint;
      return approveRequest(ctx, input.requestId, { by: ctx.staff.id, pickupPoint });
    },
  },
  reject_request: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => {
      const r = await getRequest(ctx.q, input.requestId);
      if (!r) notFound('request_not_found');
      requireCap(ctx, r.kind === 'salida' ? 'aprobar' : 'decidir_excusas');
      const reason = String(input.reason || '').trim();
      if (!reason) badRequest('reason_required');
      return rejectRequest(ctx, r.id, reason, ctx.staff.id);
    },
  },
  accept_excusa: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => {
      requireCap(ctx, 'decidir_excusas');
      return acceptExcusa(ctx, input.requestId, ctx.staff.id);
    },
  },
});
```

Append to `server/commands/all.js`:

```js
import './requests.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test server/commands/requests.test.js`
Expected: 8 PASS. Then `npm test` → all green.

- [ ] **Step 6: Commit**

```bash
git add server/domain/requests.js server/commands/requests.js server/commands/all.js server/commands/requests.test.js
git commit -m "Add request lifecycle domain and parent/staff commands" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 7: Gate flow (one-time confirmation, exit) and attachments

**Files:**
- Create: `server/commands/gate.js`, `server/commands/attachments.js`, `server/projections/access.js`
- Modify: `server/app.js` (add `attachments/<id>` route), `server/commands/all.js`
- Test: `server/commands/gate.test.js`, `server/commands/attachments.test.js`

**Interfaces:**
- Commands: `request_confirmation {requestId}`, `confirm_pickup {requestId, confirmed: bool}`, `mark_exit {requestId}`, `scan_code {code}` → `{ requestId }` (logs the scan like the prototype), `upload_attachment {purpose, mime, name, dataBase64}` → `{ attachmentId }`.
- `canSeeAttachment(q, user, attachment, env) → bool`; route `GET /api/attachments/:id` streams bytes with the stored mime.

- [ ] **Step 1: Write the failing tests**

`server/commands/gate.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { listNotifications, getConversation, getAuthorization } from '../db/repo.js';

const texts = async (db, target) => (await listNotifications(db, target)).map((n) => n.text);

test('one-time pickup: gate asks, a titular confirms, gate marks the exit and the authorization is consumed', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p5', reason: 'x' });
  await t.run('approve_request', 'u_s2', { requestId: r.id, pickupPoint: 'Puerta Principal' });
  await assert.rejects(t.run('mark_exit', 'u_s6', { requestId: r.id }), (e) => e.code === 'confirmation_required' && /primero solicita la confirmación/.test(e.detail));
  const { result: c } = await t.run('request_confirmation', 'u_s6', { requestId: r.id });
  assert.equal(c.confirmation.status, 'pendiente');
  assert.equal((await getConversation(t.db, 'p2')).step, 'confirm_pickup');
  const asks = (await listNotifications(t.db, { personId: 'p2' })).filter((n) => n.text.startsWith('⚠️ Laura Gómez (Mamá) está en la garita'));
  assert.deepEqual(asks[0].buttons, ['Sí, confirmo', 'No']);
  await assert.rejects(t.run('confirm_pickup', 'u_p7', { requestId: r.id, confirmed: true }), /forbidden_not_titular/);
  const { result: ok } = await t.run('confirm_pickup', 'u_p2', { requestId: r.id, confirmed: true });
  assert.equal(ok.confirmation.status, 'confirmada');
  assert.equal(ok.confirmation.byPerson, 'p2');
  assert.equal(await getConversation(t.db, 'p2'), null);
  assert.equal(await getConversation(t.db, 'p1'), null, 'the other titular is released too');
  assert.match((await texts(t.db, { role: 'garita' })).at(-1), /^✅ Confirmado por Ana Pérez: entrega de Joseph Rodríguez a Laura Gómez$/);
  assert.match((await texts(t.db, { personId: 'p1' })).at(-1), /^✅ Ana Pérez confirmó la entrega de Joseph Rodríguez a Laura Gómez\.$/);
  await assert.rejects(t.run('mark_exit', 'u_s2', { requestId: r.id }), /forbidden_capability:marcar_salida/);
  const { result: done } = await t.run('mark_exit', 'u_s6', { requestId: r.id });
  assert.equal(done.status, 'retirado');
  assert.equal(done.exitBy, 's6');
  assert.ok((await getAuthorization(t.db, 'a4')).usedAt, 'one-time authorization consumed');
  assert.match((await texts(t.db, { personId: 'p1' })).at(-1), /^🚪 Joseph Rodríguez salió por Puerta Principal a las 10:30 am, retirado\(a\) por Laura Gómez \(Mamá\)\. Confirmó Manuel Ortega \(Oficial de garita\)\.$/);
  assert.match((await texts(t.db, { personId: 'p5' })).at(-1), /^🚪 Registramos que retiraste a Joseph Rodríguez a las 10:30 am\. ¡Gracias!$/);
  assert.match((await texts(t.db, { staffId: 's3' })).at(-1), /^Joseph Rodríguez salió a las 10:30 am$/);
  await assert.rejects(t.run('mark_exit', 'u_s6', { requestId: r.id }), /request_not_approved/);
  await t.close();
});

test('a denied confirmation blocks the exit; confirmation is not offered for ordinary pickups', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p5', reason: 'x' });
  await t.run('approve_request', 'u_s2', { requestId: r.id });
  await t.run('request_confirmation', 'u_s6', { requestId: r.id });
  await t.run('confirm_pickup', 'u_p1', { requestId: r.id, confirmed: false });
  await assert.rejects(t.run('mark_exit', 'u_s6', { requestId: r.id }), /confirmation_required/);
  assert.match((await texts(t.db, { role: 'garita' })).at(-1), /^⛔ NEGADO por Carlos Rodríguez/);
  const { result: plain } = await t.run('create_salida', 'u_p1', { studentId: 'e2', date: '2026-09-18', time: '13:00', pickupBy: 'p3', reason: 'x' });
  await assert.rejects(t.run('request_confirmation', 'u_s6', { requestId: plain.id }), /confirmation_not_needed/);
  await t.close();
});

test('scan_code finds today approved salidas only and logs the scan', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' });
  const { result: found } = await t.run('scan_code', 'u_s6', { code: ' ' + r.code + ' ' });
  assert.equal(found.requestId, r.id);
  await assert.rejects(t.run('scan_code', 'u_s6', { code: '0000' }), (e) => e.code === 'code_not_found' && e.detail === 'Código no válido o sin salida aprobada para hoy.');
  await assert.rejects(t.run('scan_code', 'u_s6', { code: '4821' }), /code_not_found/, 'yesterday retired request');
  await t.close();
});
```

`server/commands/attachments.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, loginAs } from '../test-helpers.js';

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');

test('upload validates purpose, mime and size and stores the owner', async () => {
  const t = await makeTestApp();
  const { result } = await t.run('upload_attachment', 'u_p1', { purpose: 'cedula', mime: 'image/svg+xml', name: 'ced.svg', dataBase64: svg });
  assert.match(result.attachmentId, /^att/);
  await assert.rejects(t.run('upload_attachment', 'u_p1', { purpose: 'meme', mime: 'image/png', name: 'x', dataBase64: svg }), /invalid_purpose/);
  await assert.rejects(t.run('upload_attachment', 'u_p1', { purpose: 'foto', mime: 'text/html', name: 'x', dataBase64: svg }), /invalid_mime/);
  const big = Buffer.alloc(524289).toString('base64');
  await assert.rejects(t.run('upload_attachment', 'u_p1', { purpose: 'foto', mime: 'image/png', name: 'x', dataBase64: big }), /attachment_too_large/);
  await assert.rejects(t.run('upload_attachment', 'u_s6', { purpose: 'foto', mime: 'image/png', name: 'x', dataBase64: svg }), /forbidden_role/);
  await t.close();
});

test('attachment route enforces who may look at a document', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const p1 = await loginAs(base, 'u_p1'), p7 = await loginAs(base, 'u_p7'), gate = await loginAs(base, 'u_s6'), rec = await loginAs(base, 'u_s2');
  const get = (cookie, id) => fetch(`${base}/api/attachments/${id}`, { headers: { cookie } });
  assert.equal((await get(p1, 'att_p3')).status, 200, 'titular sees the grandmother authorized for his kids');
  assert.equal((await get(p1, 'att_p1')).status, 200, 'own document');
  assert.equal((await get(p7, 'att_p3')).status, 403, 'other family');
  assert.equal((await get(rec, 'att_p3')).status, 200);
  assert.equal((await get(gate, 'att_p3')).status, 403, 'no approved salida today for María');
  await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p3', reason: 'x' });
  const res = await get(gate, 'att_p3');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.match(await res.text(), /María Pérez/);
  assert.equal((await get(gate, 'missing')).status, 404);
  assert.equal((await fetch(`${base}/api/attachments/att_p3`)).status, 401);
  await close(); await t.close();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test server/commands/gate.test.js server/commands/attachments.test.js`
Expected: FAIL (`unknown_command`, missing `access.js`).

- [ ] **Step 3: Implement gate commands**

`server/commands/gate.js`:

```js
import { register } from './index.js';
import { requireCap, requireTitular, STAFF_ROLES } from './guards.js';
import { requestConfirmation, confirmPickup, markExit } from '../domain/requests.js';
import { logEvent } from '../domain/notifications.js';
import { todayOf } from '../domain/eligibility.js';
import { getRequest, listRequests, getStudent } from '../db/repo.js';
import { HttpError, notFound } from '../domain/errors.js';

register({
  request_confirmation: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => { requireCap(ctx, 'marcar_salida'); return requestConfirmation(ctx, input.requestId, ctx.staff.id); },
  },
  confirm_pickup: {
    roles: ['parent'],
    handler: async (ctx, input) => {
      const r = await getRequest(ctx.q, input.requestId);
      if (!r) notFound('request_not_found');
      await requireTitular(ctx, r.studentId);
      return confirmPickup(ctx, r.id, ctx.person.id, !!input.confirmed);
    },
  },
  mark_exit: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => { requireCap(ctx, 'marcar_salida'); return markExit(ctx, input.requestId, ctx.staff.id); },
  },
  scan_code: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => {
      requireCap(ctx, 'marcar_salida');
      const code = String(input.code || '').replace(/\D/g, '');
      const req = (await listRequests(ctx.q, { date: todayOf(ctx), kind: 'salida', status: 'aprobada' })).find((r) => r.code === code);
      if (!req) throw new HttpError(404, 'code_not_found', 'Código no válido o sin salida aprobada para hoy.');
      const st = await getStudent(ctx.q, req.studentId);
      await logEvent(ctx, 'Escaneó el código ' + code + ' (' + st.name + ')', ctx.staff.name);
      return { requestId: req.id };
    },
  },
});
```

`server/commands/attachments.js`:

```js
import { register } from './index.js';
import { insertAttachment } from '../db/repo.js';
import { uid } from '../domain/ids.js';
import { HttpError, badRequest } from '../domain/errors.js';

const PURPOSES = ['cedula', 'foto', 'certificado'];
const MAX = 524288;

register({
  upload_attachment: {
    roles: ['parent', 'recepcion', 'admin'],
    handler: async (ctx, input) => {
      if (!PURPOSES.includes(input.purpose)) badRequest('invalid_purpose');
      const mime = String(input.mime || '');
      if (!/^image\//.test(mime) && mime !== 'application/pdf') badRequest('invalid_mime');
      const bytes = Buffer.from(String(input.dataBase64 || ''), 'base64');
      if (!bytes.length) badRequest('empty_attachment');
      if (bytes.length > MAX) throw new HttpError(413, 'attachment_too_large', 'La imagen supera 512 KB. Reduce su tamaño e inténtalo de nuevo.');
      const id = uid('att');
      await insertAttachment(ctx.q, { id, ownerPersonId: ctx.person ? ctx.person.id : null, purpose: input.purpose, mime, bytes, size: bytes.length, name: String(input.name || 'adjunto').slice(0, 120) });
      return { attachmentId: id };
    },
  },
});
```

`server/projections/access.js`:

```js
import { studentsOfPerson, listAuthorizations, listRequests, getSettings, getStaff, getStudent } from '../db/repo.js';
import { todayISO } from '../domain/time.js';

/* Who may open a stored document (cédula/foto of a pickup person or an excuse certificate). */
export async function canSeeAttachment(q, user, att, env) {
  if (user.role === 'admin' || user.role === 'recepcion') return true;
  if (user.kind === 'person') {
    if (att.ownerPersonId === user.refId) return true;
    const own = await studentsOfPerson(q, user.refId);
    if (own.some((s) => s.titulares.includes(att.ownerPersonId))) return true;
    const auths = await listAuthorizations(q, { studentIds: own.map((s) => s.id), personId: att.ownerPersonId });
    return auths.length > 0;
  }
  const settings = await getSettings(q);
  const today = todayISO(env.now, settings.timezone || 'America/Panama');
  if (user.role === 'garita') {
    const reqs = await listRequests(q, { date: today, kind: 'salida' });
    return reqs.some((r) => ['aprobada', 'retirado'].includes(r.status) && r.pickupBy === att.ownerPersonId);
  }
  if (user.role === 'profesor') {
    const staff = await getStaff(q, user.refId);
    const excuses = (await listRequests(q, { kind: 'excusa' })).filter((r) => r.attachmentId === att.id);
    for (const r of excuses) { const st = await getStudent(q, r.studentId); if (st && (staff.grades || []).includes(st.grade)) return true; }
  }
  return false;
}
```

- [ ] **Step 4: Add the attachment route to `server/app.js`**

Add these imports at the top:

```js
import { getAttachment } from './db/repo.js';
import { canSeeAttachment } from './projections/access.js';
```

Inside `api()`, right after the `me/view` block and before the `commands/` block, insert:

```js
    if (path.startsWith('attachments/') && req.method === 'GET') {
      const att = await getAttachment(db, path.slice('attachments/'.length));
      if (!att) return json(res, 404, { error: 'not_found' });
      if (!(await db.tx((q) => canSeeAttachment(q, user, att, env())))) return json(res, 403, { error: 'forbidden_attachment' });
      res.writeHead(200, { 'content-type': att.mime, 'cache-control': 'private, max-age=300', 'content-length': att.size });
      return res.end(Buffer.from(att.bytes));
    }
```

Append to `server/commands/all.js`:

```js
import './gate.js';
import './attachments.js';
```

- [ ] **Step 5: Run the tests**

Run: `node --test server/commands/gate.test.js server/commands/attachments.test.js`
Expected: 5 PASS. `npm test` green.

- [ ] **Step 6: Commit**

```bash
git add server/commands/gate.js server/commands/attachments.js server/projections/access.js server/app.js server/commands/all.js server/commands/gate.test.js server/commands/attachments.test.js
git commit -m "Add gate confirmation/exit flow, code scanning and protected attachments" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Authorized persons (create, revoke)

**Files:**
- Create: `server/domain/authorizations.js`, `server/commands/authorizations.js`
- Modify: `server/commands/all.js`
- Test: `server/commands/authorizations.test.js`

**Interfaces:**
- Domain: `addAuthorization(ctx, { studentIds, personId?, newPerson?, attachmentId?, type, from?, to?, creator: { personId|null, name } }) → { personId, authorizations: [] }`, `revokeAuthorization(ctx, id, { personId|null, name })`.
- Commands: `add_authorization {studentIds[], mode: 'nueva'|'cuenta', personId?, name?, relation?, cedula?, phone?, attachmentId?, type, from?, to?}`, `revoke_authorization {authorizationId}`.

- [ ] **Step 1: Write the failing test**

`server/commands/authorizations.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { listNotifications, listAuthorizations, getPerson, getAuthorization } from '../db/repo.js';

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
const texts = async (db, target) => (await listNotifications(db, target)).map((n) => n.text);

test('a titular registers a new person with a document for two kids', async () => {
  const t = await makeTestApp();
  const { result: up } = await t.run('upload_attachment', 'u_p1', { purpose: 'foto', mime: 'image/svg+xml', name: 'nana.svg', dataBase64: svg });
  const { result } = await t.run('add_authorization', 'u_p1', { studentIds: ['e1', 'e2'], mode: 'nueva', name: 'Rosa Nana', relation: 'Niñera', cedula: '8-1-1', phone: '+507 6000-1000', attachmentId: up.attachmentId, type: 'temporal', from: '2026-09-18', to: '2026-09-30' });
  assert.equal(result.authorizations.length, 2);
  const p = await getPerson(t.db, result.personId);
  assert.equal(p.name, 'Rosa Nana');
  assert.equal(p.hasAccount, false);
  assert.equal(p.docAttachmentId, up.attachmentId);
  assert.equal(result.authorizations[0].validTo, '2026-09-30');
  assert.match((await texts(t.db, { personId: 'p2' })).at(-1), /^ℹ️ Carlos Rodríguez autorizó a Rosa Nana \(Niñera\) para retirar a Sofía Rodríguez · Por tiempo\.$/);
  assert.match((await texts(t.db, { role: 'recepcion' })).at(-1), /^Nueva persona autorizada: Rosa Nana para Joseph, Sofía · Por tiempo$/);
  await t.close();
});

test('validation: document required for new persons, dates, ownership, titular skipped', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('add_authorization', 'u_p1', { studentIds: ['e1'], mode: 'nueva', name: 'X', relation: 'Tío', cedula: '1', type: 'siempre' }), /document_required/);
  await assert.rejects(t.run('add_authorization', 'u_p1', { studentIds: ['e1'], mode: 'cuenta', personId: 'p5', type: 'temporal', from: '2026-09-20', to: '2026-09-10' }), /invalid_date_range/);
  await assert.rejects(t.run('add_authorization', 'u_p1', { studentIds: ['e3'], mode: 'cuenta', personId: 'p5', type: 'siempre' }), /forbidden_not_titular/);
  await assert.rejects(t.run('add_authorization', 'u_p1', { studentIds: [], mode: 'cuenta', personId: 'p5', type: 'siempre' }), /students_required/);
  await assert.rejects(t.run('add_authorization', 'u_p1', { studentIds: ['e1'], mode: 'cuenta', personId: 'p5', type: 'mensual' }), /invalid_type/);
  const { result } = await t.run('add_authorization', 'u_p1', { studentIds: ['e1'], mode: 'cuenta', personId: 'p2', type: 'siempre' });
  assert.equal(result.authorizations.length, 0, 'Ana is already a titular of Joseph');
  const { result: acct } = await t.run('add_authorization', 'u_p1', { studentIds: ['e2'], mode: 'cuenta', personId: 'p5', type: 'una_vez' });
  assert.equal(acct.authorizations[0].type, 'una_vez');
  assert.match((await texts(t.db, { personId: 'p5' })).at(-1), /^🔑 Carlos Rodríguez te autorizó para retirar a Sofía Rodríguez \(Kínder\) · Una vez \(con confirmación\)\. Lo verás en tu app\.$/);
  await t.close();
});

test('reception may register and revoke; parents revoke only their family', async () => {
  const t = await makeTestApp();
  const { result: up } = await t.run('upload_attachment', 'u_s2', { purpose: 'cedula', mime: 'image/png', name: 'c.png', dataBase64: svg });
  const { result } = await t.run('add_authorization', 'u_s2', { studentIds: ['e3'], mode: 'nueva', name: 'Tío Beto', relation: 'Tío', cedula: '2-2-2', attachmentId: up.attachmentId, type: 'siempre' });
  assert.equal(result.authorizations.length, 1);
  assert.match((await texts(t.db, { personId: 'p5' })).at(-1), /^ℹ️ Yadira Batista autorizó a Tío Beto/);
  await assert.rejects(t.run('revoke_authorization', 'u_p1', { authorizationId: result.authorizations[0].id }), /forbidden_not_titular/);
  await assert.rejects(t.run('revoke_authorization', 'u_s3', { authorizationId: 'a1' }), /forbidden_capability:gestionar_autorizados/);
  await t.run('revoke_authorization', 'u_s2', { authorizationId: result.authorizations[0].id });
  assert.ok((await getAuthorization(t.db, result.authorizations[0].id)).revokedAt);
  await t.run('revoke_authorization', 'u_p2', { authorizationId: 'a1' });
  assert.ok((await getAuthorization(t.db, 'a1')).revokedAt);
  assert.match((await texts(t.db, { personId: 'p1' })).at(-1), /^ℹ️ Se revocó la autorización de María Pérez para retirar a Joseph Rodríguez\.$/);
  assert.equal((await listAuthorizations(t.db, { studentIds: ['e1'], includeRevoked: false })).some((a) => a.id === 'a1'), false);
  await t.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/commands/authorizations.test.js`
Expected: FAIL, `unknown_command`.

- [ ] **Step 3: Implement the domain**

`server/domain/authorizations.js`:

```js
import { uid } from './ids.js';
import { badRequest, notFound } from './errors.js';
import { getStudent, getPerson, insertRow, patchRow, getAuthorization, getAttachment } from '../db/repo.js';
import { notifyPerson, notifyRole, logEvent } from './notifications.js';
import { AUTH_TYPES, firstName } from './text.js';

export async function addAuthorization(ctx, { studentIds, personId, newPerson, attachmentId, type, from, to, creator }) {
  if (!Array.isArray(studentIds) || !studentIds.length) badRequest('students_required');
  if (!AUTH_TYPES[type]) badRequest('invalid_type');
  if (type === 'temporal') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) badRequest('invalid_date_range');
    if (to < from) badRequest('invalid_date_range');
  }
  let att = null;
  if (attachmentId) { att = await getAttachment(ctx.q, attachmentId); if (!att) notFound('attachment_not_found'); }
  let pid = personId;
  if (!pid) {
    if (!newPerson || !String(newPerson.name || '').trim()) badRequest('name_required');
    if (!att) badRequest('document_required');
    pid = uid('p');
    await insertRow(ctx.q, 'persons', { id: pid, name: newPerson.name.trim(), relation: newPerson.relation || '', cedula: newPerson.cedula || '', phone: newPerson.phone || null, hasAccount: false, docName: att.name, docAttachmentId: att.id });
    await patchRow(ctx.q, 'attachments', att.id, { ownerPersonId: pid });
  } else {
    if (!(await getPerson(ctx.q, pid))) notFound('person_not_found');
    if (att) { await patchRow(ctx.q, 'persons', pid, { docName: att.name, docAttachmentId: att.id }); await patchRow(ctx.q, 'attachments', att.id, { ownerPersonId: pid }); }
  }
  const p = await getPerson(ctx.q, pid);
  const created = [];
  const names = [];
  for (const sid of studentIds) {
    const st = await getStudent(ctx.q, sid);
    if (!st) notFound('student_not_found');
    names.push(firstName(st.name));
    if (st.titulares.includes(pid)) continue; // ya es titular
    const a = { id: uid('a'), studentId: sid, personId: pid, type, createdBy: creator.personId || null, createdAt: ctx.now, validFrom: type === 'temporal' ? from : null, validTo: type === 'temporal' ? to : null };
    await insertRow(ctx.q, 'authorizations', a);
    created.push(await getAuthorization(ctx.q, a.id));
    await logEvent(ctx, 'Autorizó a ' + p.name + ' (' + p.relation + ') para retirar a ' + st.name + ' · ' + AUTH_TYPES[type], creator.name);
    for (const t of st.titulares.filter((x) => x !== creator.personId)) await notifyPerson(ctx, t, 'ℹ️ ' + creator.name + ' autorizó a ' + p.name + ' (' + p.relation + ') para retirar a ' + st.name + ' · ' + AUTH_TYPES[type] + '.');
    if (p.hasAccount) await notifyPerson(ctx, pid, '🔑 ' + creator.name + ' te autorizó para retirar a ' + st.name + ' (' + st.grade + ') · ' + AUTH_TYPES[type] + (type === 'temporal' ? ' del ' + from + ' al ' + to : '') + '. Lo verás en tu app.');
  }
  await notifyRole(ctx, 'recepcion', 'Nueva persona autorizada: ' + p.name + ' para ' + names.join(', ') + ' · ' + AUTH_TYPES[type]);
  return { personId: pid, authorizations: created };
}

export async function revokeAuthorization(ctx, id, actor) {
  const a = await getAuthorization(ctx.q, id);
  if (!a) notFound('authorization_not_found');
  await patchRow(ctx.q, 'authorizations', id, { revokedAt: ctx.now });
  const st = await getStudent(ctx.q, a.studentId);
  const p = await getPerson(ctx.q, a.personId);
  await logEvent(ctx, 'Revocó autorización de ' + p.name + ' para ' + st.name, actor.name);
  for (const t of st.titulares.filter((x) => x !== actor.personId)) await notifyPerson(ctx, t, 'ℹ️ Se revocó la autorización de ' + p.name + ' para retirar a ' + st.name + '.');
  return getAuthorization(ctx.q, id);
}
```

- [ ] **Step 4: Implement the commands**

`server/commands/authorizations.js`:

```js
import { register } from './index.js';
import { requireCap, requireTitular, STAFF_ROLES } from './guards.js';
import { addAuthorization, revokeAuthorization } from '../domain/authorizations.js';
import { getAuthorization, getAttachment } from '../db/repo.js';
import { deny, notFound, badRequest } from '../domain/errors.js';

const creatorOf = (ctx) => (ctx.person ? { personId: ctx.person.id, name: ctx.person.name } : { personId: null, name: ctx.staff.name });

register({
  add_authorization: {
    roles: ['parent', ...STAFF_ROLES],
    handler: async (ctx, input) => {
      const studentIds = [].concat(input.studentIds || []);
      if (!studentIds.length) badRequest('students_required');
      if (ctx.user.role === 'parent') for (const sid of studentIds) await requireTitular(ctx, sid);
      else requireCap(ctx, 'gestionar_autorizados');
      if (input.attachmentId) {
        const a = await getAttachment(ctx.q, input.attachmentId);
        if (!a) notFound('attachment_not_found');
        if (ctx.person && a.ownerPersonId && a.ownerPersonId !== ctx.person.id) deny('forbidden_attachment');
      }
      const mode = input.mode === 'cuenta' ? 'cuenta' : 'nueva';
      return addAuthorization(ctx, {
        studentIds, type: input.type, from: input.from, to: input.to, attachmentId: input.attachmentId || null, creator: creatorOf(ctx),
        personId: mode === 'cuenta' ? input.personId : null,
        newPerson: mode === 'nueva' ? { name: input.name, relation: input.relation, cedula: input.cedula, phone: input.phone } : null,
      });
    },
  },
  revoke_authorization: {
    roles: ['parent', ...STAFF_ROLES],
    handler: async (ctx, input) => {
      const a = await getAuthorization(ctx.q, input.authorizationId);
      if (!a) notFound('authorization_not_found');
      if (ctx.user.role === 'parent') await requireTitular(ctx, a.studentId);
      else requireCap(ctx, 'gestionar_autorizados');
      return revokeAuthorization(ctx, a.id, creatorOf(ctx));
    },
  },
});
```

Append to `server/commands/all.js`:

```js
import './authorizations.js';
```

- [ ] **Step 5: Run the tests**

Run: `node --test server/commands/authorizations.test.js`
Expected: 3 PASS. `npm test` green.

- [ ] **Step 6: Commit**

```bash
git add server/domain/authorizations.js server/commands/authorizations.js server/commands/all.js server/commands/authorizations.test.js
git commit -m "Add authorized-person registration and revocation" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 9: School bus — trips, boardings, opt-out, simulated GPS and "¿dónde está?"

**Files:**
- Create: `server/domain/bus.js`, `server/commands/bus.js`
- Modify: `server/commands/all.js`
- Test: `server/commands/bus.test.js`

**Interfaces:**
- Domain: `legStops(route, leg)`, `busPosition(route, leg, progress) → { lat, lng, prevStop, nextStop, index, frac, stops, minutesLeft, etaTo(stop) }`, `nextLegInfo(ctx, route)`, `busStatusFor(ctx, student) → null | { r, active:false } | { r, active:true, leg, trip, rec, noBus, stop, pos, progress, simulated }`, `whereIs(ctx, studentId) → { text, location? }`, `markBoarding(ctx, routeId, leg, studentId, status, byStaffId, stopId)`, `setTripStatus(ctx, routeId, leg, status, byStaffId)`, `markNoBus(ctx, studentId, personId, legs)`.
- Commands: `mark_boarding {routeId, leg, studentId, status, stopId?}`, `set_trip_status {routeId, leg, status}`, `mark_no_bus {studentId, legs?}`, `where_is {studentId}` → `{ text, location? }`.

- [ ] **Step 1: Write the failing test**

`server/commands/bus.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { listNotifications, findTrip, getSettings, saveSettings } from '../db/repo.js';

const texts = async (db, target) => (await listNotifications(db, target)).map((n) => n.text);

test('where_is answers by real state: on the bus with ETA and location', async () => {
  const t = await makeTestApp(); // simulateBus=true, vuelta at 22 %, e1 and e2 aboard since 10:09
  const { result } = await t.run('where_is', 'u_p1', { studentId: 'e1' });
  assert.match(result.text, /^🚌 Joseph va en el Bus 12 \(placa T-4521\), vuelta \(tarde\)\. Abordó a las 10:09 am\.\n📍 Próxima parada: Villa Lucre\n🏁 Llega a Villa Lucre en ~9 min\n👩 Monitora: Kenia Pérez$/);
  assert.equal(result.location.routeId, 'r1');
  assert.equal(result.location.leg, 'vuelta');
  assert.equal(result.location.label, 'Bus 12 · vuelta (tarde) · GPS simulado');
  assert.ok(result.location.lat > 9.012 && result.location.lat < 9.03);
  await assert.rejects(t.run('where_is', 'u_p7', { studentId: 'e1' }), /forbidden_not_titular/);
  await t.close();
});

test('where_is: not marked, opted out, got off, did not board, in class, retired, out of hours', async () => {
  const t = await makeTestApp();
  assert.equal((await t.run('where_is', 'u_p5', { studentId: 'e3' })).result.text, '⏳ El Bus 7 está en ruta, pero la monitora aún no ha marcado a Mateo a bordo. Si no lo esperabas, llama a recepción al +507 6800-0000.');
  await t.run('mark_no_bus', 'u_p5', { studentId: 'e3' });
  assert.equal((await t.run('where_is', 'u_p5', { studentId: 'e3' })).result.text, '🚌 Hoy Mateo no va en el Bus 7 (avisado por la familia). Está en el plantel.');
  assert.match((await texts(t.db, { staffId: 's8' })).at(-1), /^🚌 Mateo Castillo hoy no va en el bus \(ida, vuelta\) · avisó Laura Gómez$/);
  assert.match((await texts(t.db, { personId: 'p6' })).at(-1), /^ℹ️ Laura Gómez avisó que Mateo hoy no va en el Bus 7 \(ida, vuelta\)\.$/);
  assert.deepEqual((await findTrip(t.db, '2026-09-18', 'r2', 'ida')).noBus, ['e3']);

  await t.run('mark_boarding', 'u_s7', { routeId: 'r1', leg: 'vuelta', studentId: 'e1', status: 'bajo', stopId: 'st2' });
  assert.equal((await t.run('where_is', 'u_p1', { studentId: 'e1' })).result.text, '✅ Joseph bajó del Bus 12 en Villa Lucre a las 10:30 am. Lo confirmó la monitora Kenia Pérez.');
  await t.run('mark_boarding', 'u_s7', { routeId: 'r1', leg: 'vuelta', studentId: 'e2', status: 'no_abordo' });
  assert.equal((await t.run('where_is', 'u_p1', { studentId: 'e2' })).result.text, '⚠️ La monitora marcó que Sofía NO abordó el Bus 12 (10:30 am). Contacta a recepción al +507 6800-0000.');
  assert.match((await texts(t.db, { role: 'recepcion' })).at(-1), /^Sofía Rodríguez no abordó el Bus 12 \(vuelta \(tarde\)\)$/);

  assert.equal((await t.run('where_is', 'u_p7', { studentId: 'e4' })).result.text, '🏫 Emily está en el plantel · 9° Premedia · Prof. Jorge Ávila.');

  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' });
  await t.run('mark_exit', 'u_s6', { requestId: r.id });
  assert.equal((await t.run('where_is', 'u_p1', { studentId: 'e1' })).result.text, '🚪 Joseph salió por Puerta Principal a las 10:30 am, retirado(a) por Carlos Rodríguez (solicitante). Confirmó Manuel Ortega (Oficial de garita).');

  await saveSettings(t.db, { ...(await getSettings(t.db)), simulateBus: false });
  t.clock.now = new Date('2026-09-19T01:00:00Z'); // 20:00 in Panama
  assert.equal((await t.run('where_is', 'u_p1', { studentId: 'e2' })).result.text, '🕒 Fuera de horario escolar. No hay registro de salida especial de Sofía hoy. Próximo viaje del Bus 12: ida mañana a las 6:00 am.');
  await t.close();
});

test('monitor scope, trip status and validation', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('mark_boarding', 'u_s8', { routeId: 'r1', leg: 'vuelta', studentId: 'e1', status: 'abordo' }), /forbidden_route/);
  await assert.rejects(t.run('mark_boarding', 'u_s2', { routeId: 'r1', leg: 'vuelta', studentId: 'e1', status: 'abordo' }), /forbidden_capability:marcar_bus/);
  await assert.rejects(t.run('mark_boarding', 'u_s7', { routeId: 'r1', leg: 'noche', studentId: 'e1', status: 'abordo' }), /invalid_leg/);
  await assert.rejects(t.run('mark_boarding', 'u_s7', { routeId: 'r1', leg: 'ida', studentId: 'e1', status: 'volando' }), /invalid_status/);
  await assert.rejects(t.run('mark_boarding', 'u_s7', { routeId: 'r1', leg: 'ida', studentId: 'e3', status: 'abordo' }), /student_not_on_route/);
  await assert.rejects(t.run('mark_no_bus', 'u_p7', { studentId: 'e4' }), (e) => e.code === 'no_bus_route');
  await assert.rejects(t.run('set_trip_status', 'u_s7', { routeId: 'r2', leg: 'vuelta', status: 'en_ruta' }), /forbidden_route/);
  const { result } = await t.run('set_trip_status', 'u_s7', { routeId: 'r1', leg: 'vuelta', status: 'finalizado' });
  assert.equal(result.status, 'finalizado');
  assert.ok(result.endedAt);
  const { result: admin } = await t.run('set_trip_status', 'u_s1', { routeId: 'r2', leg: 'vuelta', status: 'en_ruta' });
  assert.equal(admin.status, 'en_ruta');
  await t.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/commands/bus.test.js`
Expected: FAIL, `unknown_command`.

- [ ] **Step 3: Implement `server/domain/bus.js`**

```js
import { getStudent, getRoute, findTrip, ensureTrip, upsertBoarding, insertOptOut, patchRow, getStaff, getPerson, listRequests, listStaff, listLevels } from '../db/repo.js';
import { minutesOf, nowHHMM, todayISO } from './time.js';
import { fmtTime, fmtClock, firstName, LEG_NAMES, roleName } from './text.js';
import { notifyPerson, notifyRole, notifyStaff, logEvent } from './notifications.js';
import { describePickup } from './requests.js';
import { conflict, notFound, badRequest } from './errors.js';

const EMPTY_TRIP = () => ({ status: 'programado', boarded: {}, noBus: [] });
export const currentLeg = (ctx, r) => ctx.gps.position(r, ctx);
export function nextLegInfo(ctx, r) {
  const now = minutesOf(nowHHMM(ctx.now, ctx.tz));
  for (const leg of ['ida', 'vuelta']) if (now < minutesOf(r.schedule[leg].start)) return LEG_NAMES[leg] + ' a las ' + fmtTime(r.schedule[leg].start);
  return 'ida mañana a las ' + fmtTime(r.schedule.ida.start);
}
export const legStops = (r, leg) => (leg === 'ida' ? r.stops.slice().reverse() : r.stops);
export function busPosition(r, leg, progress) {
  const stops = legStops(r, leg); const n = stops.length;
  const segF = Math.min(0.999, Math.max(0, progress)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(segF)); const f = segF - i;
  const a = stops[i]; const b = stops[i + 1];
  const total = minutesOf(r.schedule[leg].end) - minutesOf(r.schedule[leg].start);
  return {
    lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, prevStop: a, nextStop: b, index: i, frac: f, stops,
    minutesLeft: Math.round((1 - progress) * total),
    etaTo: (stop) => { const j = stops.findIndex((s) => s.id === stop.id); return Math.max(0, Math.round(((j - i - f) / (n - 1)) * total)); },
  };
}
export async function busStatusFor(ctx, st) {
  const r = st.routeId ? await getRoute(ctx.q, st.routeId) : null;
  if (!r) return null;
  const cur = currentLeg(ctx, r);
  if (!cur) return { r, active: false };
  const trip = (await findTrip(ctx.q, todayISO(ctx.now, ctx.tz), r.id, cur.leg)) || EMPTY_TRIP();
  return { r, active: true, leg: cur.leg, trip, rec: trip.boarded[st.id], noBus: trip.noBus.includes(st.id), stop: r.stops.find((s) => s.id === st.stopId), pos: busPosition(r, cur.leg, cur.progress), progress: cur.progress, simulated: cur.simulated };
}
export async function whereIs(ctx, studentId) {
  const st = await getStudent(ctx.q, studentId);
  if (!st) notFound('student_not_found');
  const today = todayISO(ctx.now, ctx.tz);
  const todays = await listRequests(ctx.q, { studentIds: [studentId], date: today, kind: 'salida' });
  const exit = todays.find((x) => x.status === 'retirado');
  if (exit) {
    const off = await getStaff(ctx.q, exit.exitBy);
    const pk = await getPerson(ctx.q, exit.pickupBy);
    return { text: '🚪 ' + firstName(st.name) + ' salió por ' + exit.pickupPoint + ' a las ' + fmtClock(ctx, exit.exitAt) + ', retirado(a) por ' + describePickup(exit, pk) + '. Confirmó ' + off.name + ' (' + (off.title || roleName(off.role)) + ').' };
  }
  const appr = todays.find((x) => x.status === 'aprobada');
  const apprTxt = appr ? ' Tiene salida aprobada a las ' + fmtTime(appr.time) + ' por ' + appr.pickupPoint + ', aún no ha salido.' : '';
  const bus = await busStatusFor(ctx, st);
  if (bus && bus.active) {
    const r = bus.r; const mon = await getStaff(ctx.q, r.monitorId);
    if (bus.noBus) return { text: '🚌 Hoy ' + firstName(st.name) + ' no va en el ' + r.name + ' (avisado por la familia).' + (apprTxt || ' Está en el plantel.') };
    if (bus.rec && bus.rec.status === 'abordo') {
      const eta = bus.stop ? bus.pos.etaTo(bus.stop) : bus.pos.minutesLeft;
      return {
        text: '🚌 ' + firstName(st.name) + ' va en el ' + r.name + ' (placa ' + r.plate + '), ' + LEG_NAMES[bus.leg] + '. Abordó a las ' + fmtClock(ctx, bus.rec.ts) + '.\n📍 Próxima parada: ' + bus.pos.nextStop.name + (bus.stop ? (eta > 0 ? '\n🏁 Llega a ' + bus.stop.name + ' en ~' + eta + ' min' : '\n🏁 Está llegando a ' + bus.stop.name) : '') + '\n👩 Monitora: ' + (mon ? mon.name : '—'),
        location: { lat: bus.pos.lat, lng: bus.pos.lng, routeId: r.id, leg: bus.leg, progress: bus.progress, label: r.name + ' · ' + LEG_NAMES[bus.leg] + (bus.simulated ? ' · GPS simulado' : ' · GPS en vivo') },
      };
    }
    if (bus.rec && bus.rec.status === 'bajo') {
      const monBy = await getStaff(ctx.q, bus.rec.by);
      return { text: '✅ ' + firstName(st.name) + ' bajó del ' + r.name + ' en ' + ((r.stops.find((s) => s.id === bus.rec.stopId) || {}).name || 'su parada') + ' a las ' + fmtClock(ctx, bus.rec.ts) + '. Lo confirmó la monitora ' + monBy.name + '.' };
    }
    if (bus.rec && bus.rec.status === 'no_abordo') return { text: '⚠️ La monitora marcó que ' + firstName(st.name) + ' NO abordó el ' + r.name + ' (' + fmtClock(ctx, bus.rec.ts) + ').' + (apprTxt || ' Contacta a recepción al ' + ctx.settings.school.phone + '.') };
    return { text: '⏳ El ' + r.name + ' está en ruta, pero la monitora aún no ha marcado a ' + firstName(st.name) + ' a bordo.' + (apprTxt || ' Si no lo esperabas, llama a recepción al ' + ctx.settings.school.phone + '.') };
  }
  const now = minutesOf(nowHHMM(ctx.now, ctx.tz));
  if (now >= minutesOf(ctx.settings.schoolStart) && now <= minutesOf(ctx.settings.schoolEnd)) {
    const tch = (await listStaff(ctx.q)).find((s) => s.role === 'profesor' && (s.grades || []).includes(st.grade));
    const lv = (await listLevels(ctx.q)).find((l) => l.id === st.levelId);
    return { text: '🏫 ' + firstName(st.name) + ' está en el plantel · ' + st.grade + ' ' + (lv ? lv.name : st.levelId) + (tch ? ' · ' + tch.name : '') + '.' + apprTxt };
  }
  return { text: '🕒 Fuera de horario escolar. No hay registro de salida especial de ' + firstName(st.name) + ' hoy.' + (bus && bus.r ? ' Próximo viaje del ' + bus.r.name + ': ' + nextLegInfo(ctx, bus.r) + '.' : '') };
}
export async function markBoarding(ctx, routeId, leg, studentId, status, byStaffId, stopId) {
  if (!LEG_NAMES[leg]) badRequest('invalid_leg');
  if (!['abordo', 'bajo', 'no_abordo'].includes(status)) badRequest('invalid_status');
  const st = await getStudent(ctx.q, studentId); const r = await getRoute(ctx.q, routeId);
  if (!st || !r) notFound('student_or_route_not_found');
  if (st.routeId !== r.id) conflict('student_not_on_route');
  const trip = await ensureTrip(ctx.q, todayISO(ctx.now, ctx.tz), r.id, leg);
  await upsertBoarding(ctx.q, trip.id, studentId, { status, stopId: stopId || null, by: byStaffId, at: ctx.now });
  const verb = status === 'abordo' ? 'Marcó a bordo' : status === 'bajo' ? 'Marcó que bajó' : 'Marcó NO abordó';
  await logEvent(ctx, verb + ' a ' + st.name + ' · ' + r.name + ' ' + LEG_NAMES[leg], (await getStaff(ctx.q, byStaffId)).name);
  if (status === 'no_abordo') await notifyRole(ctx, 'recepcion', st.name + ' no abordó el ' + r.name + ' (' + LEG_NAMES[leg] + ')');
  return findTrip(ctx.q, trip.date, r.id, leg);
}
export async function setTripStatus(ctx, routeId, leg, status, byStaffId) {
  if (!LEG_NAMES[leg]) badRequest('invalid_leg');
  if (!['programado', 'en_ruta', 'finalizado'].includes(status)) badRequest('invalid_status');
  const r = await getRoute(ctx.q, routeId);
  if (!r) notFound('route_not_found');
  const trip = await ensureTrip(ctx.q, todayISO(ctx.now, ctx.tz), r.id, leg);
  const patch = { status };
  if (status === 'en_ruta') patch.startedAt = ctx.now;
  if (status === 'finalizado') patch.endedAt = ctx.now;
  await patchRow(ctx.q, 'trips', trip.id, patch);
  await logEvent(ctx, (status === 'en_ruta' ? 'Inició' : status === 'finalizado' ? 'Finalizó' : 'Programó') + ' el viaje ' + r.name + ' ' + LEG_NAMES[leg], (await getStaff(ctx.q, byStaffId)).name);
  return findTrip(ctx.q, trip.date, r.id, leg);
}
export async function markNoBus(ctx, studentId, personId, legs) {
  const st = await getStudent(ctx.q, studentId);
  if (!st) notFound('student_not_found');
  const r = st.routeId ? await getRoute(ctx.q, st.routeId) : null;
  if (!r) conflict('no_bus_route');
  const today = todayISO(ctx.now, ctx.tz);
  for (const leg of legs) { const trip = await ensureTrip(ctx.q, today, r.id, leg); await insertOptOut(ctx.q, trip.id, studentId, personId, ctx.now); }
  const by = await getPerson(ctx.q, personId);
  await logEvent(ctx, 'Avisó que ' + st.name + ' hoy no va en el ' + r.name + ' (' + legs.join(', ') + ')', by.name);
  await notifyStaff(ctx, r.monitorId, '🚌 ' + st.name + ' hoy no va en el bus (' + legs.join(', ') + ') · avisó ' + by.name);
  for (const t of st.titulares.filter((x) => x !== personId)) await notifyPerson(ctx, t, 'ℹ️ ' + by.name + ' avisó que ' + firstName(st.name) + ' hoy no va en el ' + r.name + ' (' + legs.join(', ') + ').');
  return { route: r, legs };
}
```

- [ ] **Step 4: Implement `server/commands/bus.js`**

```js
import { register } from './index.js';
import { requireCap, requireTitular, requireRouteAccess, STAFF_ROLES } from './guards.js';
import { markBoarding, setTripStatus, markNoBus, whereIs } from '../domain/bus.js';
import { logEvent } from '../domain/notifications.js';
import { badRequest } from '../domain/errors.js';

const LEGS = ['ida', 'vuelta'];
register({
  mark_boarding: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => {
      requireCap(ctx, 'marcar_bus');
      requireRouteAccess(ctx, input.routeId);
      return markBoarding(ctx, input.routeId, input.leg, input.studentId, input.status, ctx.staff.id, input.stopId || null);
    },
  },
  set_trip_status: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => {
      requireCap(ctx, 'marcar_bus');
      requireRouteAccess(ctx, input.routeId);
      return setTripStatus(ctx, input.routeId, input.leg, input.status, ctx.staff.id);
    },
  },
  mark_no_bus: {
    roles: ['parent'],
    handler: async (ctx, input) => {
      await requireTitular(ctx, input.studentId);
      const legs = Array.isArray(input.legs) && input.legs.length ? input.legs : LEGS;
      if (legs.some((l) => !LEGS.includes(l))) badRequest('invalid_leg');
      return markNoBus(ctx, input.studentId, ctx.person.id, legs);
    },
  },
  where_is: {
    roles: ['parent'],
    handler: async (ctx, input) => {
      const st = await requireTitular(ctx, input.studentId);
      const w = await whereIs(ctx, st.id);
      await logEvent(ctx, 'Consultó la ubicación de ' + st.name + ' desde la app', ctx.person.name);
      return w;
    },
  },
});
```

Append to `server/commands/all.js`:

```js
import './bus.js';
```

- [ ] **Step 5: Run the tests**

Run: `node --test server/commands/bus.test.js`
Expected: 3 PASS. `npm test` green.

- [ ] **Step 6: Commit**

```bash
git add server/domain/bus.js server/commands/bus.js server/commands/all.js server/commands/bus.test.js
git commit -m "Add bus trips, boardings, opt-out, simulated GPS and where-is" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: WhatsApp bot on the server (NLP + conversation) and the simulated inbound command

**Files:**
- Create: `server/bot/nlp.js`, `server/bot/conversation.js`, `server/commands/whatsapp.js`
- Modify: `server/commands/all.js`
- Test: `server/bot/nlp.test.js`, `server/bot/conversation.test.js`

**Interfaces:**
- `nlp.js`: `normalize(s)`, `parseTime(n) → 'HH:MM'|null`, `parseDate(n, ctx) → 'YYYY-MM-DD'`, `matchKid(n, kids) → studentId|null`, `extractPickupHint(n) → string|null`, `detectIntent(n) → 'saludo'|'estado'|'cancelar'|'nobus'|'donde'|'salida'|'excusa'|'desconocido'`, `REL_WORDS`.
- `conversation.js`: `handleIncoming(ctx, chatKey, text)`; replies go through `ctx.transport.send(ctx, chatKey, { text, buttons, location, typing: true })`; state lives in `conversation_state`.
- Command `whatsapp_inbound {text, chatKey?}` (roles `parent`, `admin`) → `{ chatKey }`.

- [ ] **Step 1: Write the failing tests**

`server/bot/nlp.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, parseTime, parseDate, matchKid, extractPickupHint, detectIntent } from './nlp.js';

const ctx = { now: new Date('2026-09-18T15:30:00Z'), tz: 'America/Panama' }; // Friday 18 Sep 2026
const kids = [{ id: 'e1', name: 'Joseph Rodríguez', emoji: '👦' }, { id: 'e2', name: 'Sofía Rodríguez', emoji: '👧' }];

test('parseTime understands the prototype formats', () => {
  assert.equal(parseTime(normalize('a las 3:30 pm')), '15:30');
  assert.equal(parseTime(normalize('a las 11')), '11:00');
  assert.equal(parseTime(normalize('a las 2')), '14:00', 'no am/pm and ≤ 6 means afternoon');
  assert.equal(parseTime(normalize('1545')), '15:45');
  assert.equal(parseTime(normalize('12 am')), '00:00');
  assert.equal(parseTime(normalize('sin hora')), null);
});

test('parseDate: hoy, mañana, pasado mañana, weekday and dd/mm', () => {
  assert.equal(parseDate(normalize('hoy'), ctx), '2026-09-18');
  assert.equal(parseDate(normalize('mañana'), ctx), '2026-09-19');
  assert.equal(parseDate(normalize('pasado mañana'), ctx), '2026-09-20');
  assert.equal(parseDate(normalize('el lunes'), ctx), '2026-09-21');
  assert.equal(parseDate(normalize('el viernes'), ctx), '2026-09-25', 'same weekday means next week');
  assert.equal(parseDate(normalize('el 3/10'), ctx), '2026-10-03');
});

test('matchKid by name, by gender word or by being the only child', () => {
  assert.equal(matchKid(normalize('retirar a Joseph'), kids), 'e1');
  assert.equal(matchKid(normalize('mi hija'), kids), 'e2');
  assert.equal(matchKid(normalize('mi hijo'), kids), 'e1');
  assert.equal(matchKid(normalize('retirar temprano'), kids), null);
  assert.equal(matchKid(normalize('retirar temprano'), [kids[0]]), 'e1');
});

test('extractPickupHint and detectIntent', () => {
  assert.equal(extractPickupHint(normalize('A Joseph lo retira la abuela a las 2 pm')), 'abuela');
  assert.equal(extractPickupHint(normalize('Hoy retira a Joseph Laura Gómez a las 2 pm')), 'laura gomez');
  assert.equal(extractPickupHint(normalize('lo retiro yo')), 'yo');
  assert.equal(extractPickupHint(normalize('necesito retirar a joseph hoy a las 3 pm')), null);
  assert.equal(detectIntent(normalize('Hola')), 'saludo');
  assert.equal(detectIntent(normalize('Estado')), 'estado');
  assert.equal(detectIntent(normalize('Sofía hoy no va en el bus')), 'nobus');
  assert.equal(detectIntent(normalize('¿Dónde está Joseph?')), 'donde');
  assert.equal(detectIntent(normalize('Necesito retirar a Joseph hoy a las 3:30 pm')), 'salida');
  assert.equal(detectIntent(normalize('Emily no irá mañana, tiene cita médica')), 'excusa');
  assert.equal(detectIntent(normalize('cancelar')), 'cancelar');
  assert.equal(detectIntent(normalize('xyz')), 'desconocido');
});
```

`server/bot/conversation.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { listChat, getConversation, listRequests, listNotifications } from '../db/repo.js';

const lastBot = async (db, key) => (await listChat(db, key)).filter((m) => m.from === 'bot').at(-1);
const say = (t, user, text, chatKey) => t.run('whatsapp_inbound', user, chatKey ? { text, chatKey } : { text });

test('greeting, menu, unknown number and status', async () => {
  const t = await makeTestApp();
  await say(t, 'u_p1', 'hola');
  const m = await lastBot(t.db, 'p1');
  assert.match(m.text, /^Hola Carlos 👋 Soy el asistente de IAE Salidas\./);
  assert.ok(m.pendingUntil > t.clock.now.getTime(), 'bot replies are typed');
  assert.equal((await listChat(t.db, 'p1'))[0].from, 'user');
  await say(t, 'u_s1', 'hola', 'unknown');
  assert.match((await lastBot(t.db, 'unknown')).text, /^Hola 👋 Este número no está registrado en IAE Salidas/);
  await assert.rejects(say(t, 'u_p1', 'hola', 'p2'), /forbidden_chat_key/);
  await assert.rejects(say(t, 'u_s1', 'hola', 'p_nope'), /chat_key_not_found/);
  await say(t, 'u_p1', 'Estado');
  assert.equal((await lastBot(t.db, 'p1')).text, 'No tienes solicitudes recientes.');
  await say(t, 'u_p1', 'xyz');
  assert.match((await lastBot(t.db, 'p1')).text, /^No te entendí 🤔/);
  await t.close();
});

test('salida flow: confirm → auto-approved; short notice → pending; unknown pickup → ask', async () => {
  const t = await makeTestApp();
  await say(t, 'u_p1', 'Necesito retirar a Joseph hoy a las 3:30 pm');
  const c = await lastBot(t.db, 'p1');
  assert.equal(c.text, '📋 Confirma la solicitud:\n• Estudiante: Joseph Rodríguez (3°)\n• Fecha: hoy\n• Hora: 3:30 pm\n• Retira: tú\n\n¿Es correcto?');
  assert.deepEqual(c.buttons, ['Sí', 'No']);
  assert.equal((await getConversation(t.db, 'p1')).step, 'confirm');
  await say(t, 'u_p1', 'Sí');
  const [r] = await listRequests(t.db, { studentIds: ['e1'] });
  assert.equal(r.status, 'aprobada');
  assert.equal(r.channel, 'whatsapp');
  assert.equal(r.time, '15:30');
  assert.match((await lastBot(t.db, 'p1')).text, /^✅ Salida aprobada: Joseph Rodríguez hoy a las 3:30 pm/);
  assert.equal(await getConversation(t.db, 'p1'), null);

  await say(t, 'u_p1', 'A Joseph lo retira la abuela a las 11');
  assert.match((await lastBot(t.db, 'p1')).text, /• Retira: María Pérez \(Abuela\)/);
  await say(t, 'u_p1', 'Sí');
  const pend = (await listRequests(t.db, { studentIds: ['e1'] }))[0];
  assert.equal(pend.status, 'pendiente');
  assert.equal(pend.pickupBy, 'p3');
  assert.match((await lastBot(t.db, 'p1')).text, /^📝 Recibimos tu solicitud de salida de Joseph Rodríguez hoy a las 11:00 am/);

  await say(t, 'u_p1', 'A Joseph lo retira el vecino a las 2 pm');
  const ask = await lastBot(t.db, 'p1');
  assert.match(ask.text, /^"vecino" no aparece como persona autorizada para Joseph/);
  assert.deepEqual(ask.buttons, ['Yo', 'Ana (Mamá)', 'María (Abuela)', 'Luis (Tío)', 'Laura (Mamá)']);
  await say(t, 'u_p1', 'Luis (Tío)');
  assert.match((await lastBot(t.db, 'p1')).text, /• Retira: Luis Rodríguez \(Tío\)/);
  await say(t, 'u_p1', 'No');
  assert.match((await lastBot(t.db, 'p1')).text, /^Ok, la descarté\./);
  assert.equal(await getConversation(t.db, 'p1'), null);
  await t.close();
});

test('ask_child and ask_time steps, cancel mid-flow', async () => {
  const t = await makeTestApp();
  await say(t, 'u_p1', 'Necesito retirar temprano');
  const a = await lastBot(t.db, 'p1');
  assert.equal(a.text, '¿A cuál de tus hijos? ');
  assert.deepEqual(a.buttons, ['Joseph', 'Sofía']);
  await say(t, 'u_p1', 'Sofía');
  assert.match((await lastBot(t.db, 'p1')).text, /^¿A qué hora necesitas que Sofía salga hoy\?/);
  await say(t, 'u_p1', 'a las 4 pm');
  assert.match((await lastBot(t.db, 'p1')).text, /• Hora: 4:00 pm/);
  await say(t, 'u_p1', 'cancelar');
  assert.match((await lastBot(t.db, 'p1')).text, /^Listo, cancelé el proceso\./);
  assert.equal(await getConversation(t.db, 'p1'), null);
  await t.close();
});

test('excusa flow with attachment chip', async () => {
  const t = await makeTestApp();
  await say(t, 'u_p7', 'Emily no irá mañana, tiene cita médica');
  const c = await lastBot(t.db, 'p7');
  assert.match(c.text, /^📋 Confirma la excusa:\n• Estudiante: Emily Chen \(9°\)\n• Tipo: ausencia\n• Fecha: mañana/);
  assert.deepEqual(c.buttons, ['Sí', 'No', '📎 Adjuntar certificado']);
  await say(t, 'u_p7', '📎 Adjuntar certificado');
  const chat = await listChat(t.db, 'p7');
  assert.ok(chat.some((m) => m.text === '📎 Recibí certificado_medico.jpg ✅'));
  assert.match((await lastBot(t.db, 'p7')).text, /• Adjunto: certificado_medico\.jpg/);
  await say(t, 'u_p7', 'Sí');
  const [e] = await listRequests(t.db, { studentIds: ['e4'], kind: 'excusa' });
  assert.equal(e.status, 'pendiente');
  assert.equal(e.date, '2026-09-19');
  assert.equal(e.attachmentName, 'certificado_medico.jpg');
  await t.close();
});

test('where-is and no-bus intents', async () => {
  const t = await makeTestApp();
  await say(t, 'u_p1', '¿Dónde está Joseph?');
  const w = await lastBot(t.db, 'p1');
  assert.match(w.text, /^🚌 Joseph va en el Bus 12/);
  assert.equal(w.location.routeId, 'r1');
  await say(t, 'u_p1', 'Sofía hoy no va en el bus');
  assert.equal((await lastBot(t.db, 'p1')).text, '🚌 Listo. Avisé a la monitora Kenia Pérez que Sofía hoy no va en el Bus 12 (ida (mañana) y vuelta (tarde)).');
  assert.equal((await listNotifications(t.db, { staffId: 's7' })).length, 1);
  await say(t, 'u_p1', '¿dónde está?');
  assert.deepEqual((await lastBot(t.db, 'p1')).buttons, ['Joseph', 'Sofía']);
  await say(t, 'u_p1', 'Joseph');
  assert.match((await lastBot(t.db, 'p1')).text, /^🚌 Joseph va en el Bus 12/);
  await t.close();
});

test('proactive alert answered NO cancels; confirm_pickup answered through chat', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p4', reason: 'x' });
  assert.equal((await getConversation(t.db, 'p2')).step, 'alert_pickup');
  await say(t, 'u_p2', 'NO');
  assert.equal((await listRequests(t.db, { studentIds: ['e1'] }))[0].status, 'cancelada');
  assert.match((await lastBot(t.db, 'p2')).text, /^⛔ Cancelé la salida y avisé a la garita/);
  assert.match((await listNotifications(t.db, { role: 'garita' })).at(-1).text, /^⛔ Ana Pérez NO reconoce a Luis Rodríguez · salida de Joseph Rodríguez CANCELADA$/);
  assert.match((await listNotifications(t.db, { personId: 'p1' })).at(-1).text, /^⛔ Ana Pérez no reconoció a Luis Rodríguez; la salida de Joseph fue cancelada\.$/);
  assert.equal(await getConversation(t.db, 'p1'), null);

  const { result: r2 } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p5', reason: 'x' });
  await t.run('approve_request', 'u_s2', { requestId: r2.id });
  await say(t, 'u_p1', 'Es correcto');
  assert.match((await lastBot(t.db, 'p1')).text, /^👍 Gracias, queda confirmado\./);
  await t.run('request_confirmation', 'u_s6', { requestId: r2.id });
  await say(t, 'u_p1', 'Sí, confirmo');
  assert.match((await lastBot(t.db, 'p1')).text, /^✅ Gracias, confirmaste la entrega\./);
  assert.equal((await listRequests(t.db, { studentIds: ['e1'] }))[0].confirmation.status, 'confirmada');
  await t.close();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test server/bot/`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement `server/bot/nlp.js`** (logic copied from `app.js:415-500`, with the date helpers receiving `ctx`)

```js
import { pad, todayISO, shiftISO, weekdayOf } from '../domain/time.js';
import { firstName } from '../domain/text.js';

export const REL_WORDS = {
  abuela: 'abuela', abuelo: 'abuelo', tia: 'tía', tio: 'tío', mama: 'mamá', madre: 'mamá', papa: 'papá', padre: 'papá',
  hermano: 'hermano', hermana: 'hermana', nana: 'nana', ninera: 'niñera', chofer: 'chofer', vecina: 'vecina', vecino: 'vecino', prima: 'prima', primo: 'primo',
};
export function normalize(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim(); }

export function parseTime(n) {
  let m, h, mm = 0, ap = '';
  n = n.replace(/de la manana/g, 'am').replace(/de la tarde|de la noche/g, 'pm').replace(/(\d)\s*(pm|am)/g, '$1 $2');
  if ((m = n.match(/\b(\d{1,2})[:.h](\d{2})\s*(am|pm|a\.m\.?|p\.m\.?)?/))) { h = +m[1]; mm = +m[2]; ap = m[3] || ''; }
  else if ((m = n.match(/\b(\d{3,4})\s*(am|pm|a\.m\.?|p\.m\.?)?\b/))) { const d = m[1]; h = +d.slice(0, d.length - 2); mm = +d.slice(-2); ap = m[2] || ''; }
  else if ((m = n.match(/\b(?:a las|a la|las|la|hora)\s+(\d{1,2})\b\s*(am|pm|a\.m\.?|p\.m\.?)?/))) { h = +m[1]; ap = m[2] || ''; }
  else if ((m = n.match(/\b(\d{1,2})\s*(am|pm|a\.m\.?|p\.m\.?)\b/))) { h = +m[1]; ap = m[2]; }
  else return null;
  if (isNaN(h) || h > 23 || mm > 59) return null;
  if (/p/.test(ap) && h < 12) h += 12;
  if (/a/.test(ap) && h === 12) h = 0;
  if (!ap && h <= 6) h += 12; // sin am/pm: se asume tarde
  return pad(h) + ':' + pad(mm);
}
export function parseDate(n, ctx) {
  const t = n.replace(/de la manana/g, '');
  const today = todayISO(ctx.now, ctx.tz);
  if (/pasado manana/.test(t)) return shiftISO(ctx.now, ctx.tz, 2);
  if (/\bmanana\b/.test(t)) return shiftISO(ctx.now, ctx.tz, 1);
  const m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m) return today.slice(0, 4) + '-' + pad(+m[2]) + '-' + pad(+m[1]);
  const days = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  for (let i = 0; i < 7; i++) {
    if (new RegExp('\\bel ' + days[i] + '\\b').test(t)) {
      let diff = (i - weekdayOf(today) + 7) % 7;
      if (diff === 0) diff = 7;
      return shiftISO(ctx.now, ctx.tz, diff);
    }
  }
  return today;
}
export function matchKid(n, kids) {
  const found = kids.filter((k) => new RegExp('\\b' + normalize(firstName(k.name)) + '\\b').test(n));
  if (found.length === 1) return found[0].id;
  if (found.length > 1) return null;
  if (/\bmi hija\b/.test(n)) { const f = kids.filter((k) => k.emoji === '👧' || k.emoji === '👩‍🎓'); if (f.length === 1) return f[0].id; }
  if (/\bmi hijo\b/.test(n)) { const f = kids.filter((k) => k.emoji === '👦' || k.emoji === '🧒'); if (f.length === 1) return f[0].id; }
  if (kids.length === 1) return kids[0].id;
  return null;
}
export function extractPickupHint(n) {
  if (/\b(lo|la|los|las)?\s?(retiro|recojo|busco|paso)\s+yo\b|\byo\s+(lo|la)\s+(retiro|recojo|busco)\b/.test(n)) return 'yo';
  const stop = ['hoy', 'manana', 'a', 'las', 'la', 'el', 'temprano', 'de', 'en', 'por', 'y', 'que', 'mi', 'su'];
  const re = /(?:lo|la|los|las)?\s?(?:va a retirar|van a retirar|retira|retirara|recoge|recogera|busca|buscara|pasa a buscar|va a buscar|va a recoger|retirar[aá]?)\s+(?:a\s+\w+\s+)?(?:su|mi|la|el|los|las|nuestra|nuestro)?\s*([a-z]+(?:\s[a-z]+)?)/g;
  let m;
  while ((m = re.exec(n))) {
    const w = m[1].trim();
    const first = w.split(' ')[0];
    if (stop.includes(first) || /^\d/.test(first)) continue;
    const parts = w.split(' ');
    return parts.length > 1 && (stop.includes(parts[1]) || /^\d/.test(parts[1])) ? first : w;
  }
  const rel = Object.keys(REL_WORDS).find((r) => new RegExp('\\b(su|la|el|mi)\\s+' + r + '\\b').test(n));
  return rel || null;
}
export function detectIntent(n) {
  if (/^(hola|buenas|buenos dias|buenas tardes|menu|ayuda|hi)\b/.test(n)) return 'saludo';
  if (/\b(estado|mis solicitudes|estatus|status)\b/.test(n)) return 'estado';
  if (/\bcancelar\b/.test(n)) return 'cancelar';
  if (/no (va|ira|viaja|se va|toma|tomara|usa|usara|sube|subira)( a ir)?( hoy| manana)?( en| al| el)?( el)? bus|sin bus|no bus/.test(n)) return 'nobus';
  if (/donde (esta|estan|anda|va|queda)|\bdonde\b|ubicaci|en que bus|en el bus|ya (llego|salio|paso|bajo)|localiza|rastre|posicion|gps/.test(n)) return 'donde';
  if (/retir|salir|salida|recog|buscar|sacar|temprano|permiso/.test(n)) return 'salida';
  if (/no (va|ira|asistira|vendra|podra|puede)|falt|ausen|excusa|enferm|cita|tardanza|llegara tarde|llega tarde|reposo|fiebre|justific/.test(n)) return 'excusa';
  return 'desconocido';
}
```

- [ ] **Step 4: Implement `server/bot/conversation.js`** (async port of `app.js:502-669` and `app.js:778-800`)

```js
import { normalize, parseTime, parseDate, matchKid, extractPickupHint, detectIntent, REL_WORDS } from './nlp.js';
import { getPerson, getStudent, getRequest, insertChat, getConversation, setConversation, clearConversation, listRequests, getRoute, getStaff } from '../db/repo.js';
import { studentsOf, authorizedFor, pickupCandidates, pickupEligibility } from '../domain/eligibility.js';
import { createRequest, cancelRequest, confirmPickup } from '../domain/requests.js';
import { whereIs, markNoBus } from '../domain/bus.js';
import { notifyPerson, notifyRole, logEvent } from '../domain/notifications.js';
import { addRequestEvent } from '../db/repo.js';
import { fmtDate, fmtTime, firstName, STATUS, LEG_NAMES } from '../domain/text.js';
import { todayISO, shiftISO } from '../domain/time.js';

const reply = (ctx, key, text, buttons = null, extra = {}) => ctx.transport.send(ctx, key, { text, buttons, location: extra.location || null, typing: true });
const setState = (ctx, key, state) => setConversation(ctx.q, key, state, ctx.now);
const clearState = (ctx, key) => clearConversation(ctx.q, key);

function botMenu(ctx, p, kids) {
  const k = firstName(kids[0].name);
  return 'Hola ' + firstName(p.name) + ' 👋 Soy el asistente de ' + ctx.settings.school.short + ' Salidas.\n\nPuedo ayudarte con:\n1️⃣ Salida temprana: "Necesito retirar a ' + k + ' hoy a las 3:30 pm"\n2️⃣ Alguien más retira: "A ' + k + ' lo retira la abuela a las 2 pm"\n3️⃣ Excusa: "' + k + ' no irá mañana, tiene cita médica"\n4️⃣ Ubicación: "¿Dónde está ' + k + '?"\n5️⃣ Bus: "' + k + ' hoy no va en el bus"\n6️⃣ Escribe *estado* para ver tus solicitudes.';
}
async function resolvePickup(ctx, hint, studentId, requesterId) {
  if (!hint || hint === 'yo') return requesterId;
  const cands = await pickupCandidates(ctx, studentId);
  const words = hint.split(' ');
  let hit = cands.find((c) => words.some((w) => w.length > 2 && normalize(c.person.name).split(' ').includes(w)));
  if (hit) return hit.person.id;
  hit = cands.find((c) => words.some((w) => REL_WORDS[w] && normalize(c.person.relation) === normalize(REL_WORDS[w])));
  return hit ? hit.person.id : null;
}
const candidateLabels = (cands, p) => cands.map((c) => (c.person.id === p.id ? 'Yo' : firstName(c.person.name) + ' (' + c.person.relation + ')'));
async function statusSummary(ctx, p) {
  const kids = (await studentsOf(ctx, p.id)).map((k) => k.id);
  const list = (await listRequests(ctx.q, { studentIds: kids })).filter((r) => r.date >= shiftISO(ctx.now, ctx.tz, -1)).slice(0, 5);
  if (!list.length) return 'No tienes solicitudes recientes.';
  const lines = [];
  for (const r of list) {
    const st = await getStudent(ctx.q, r.studentId);
    const what = r.kind === 'salida' ? 'Salida ' + fmtDate(ctx, r.date) + ' ' + fmtTime(r.time) : 'Excusa ' + r.excusaType + ' ' + fmtDate(ctx, r.date);
    lines.push('• ' + firstName(st.name) + ' · ' + what + ' · ' + STATUS[r.status] + (r.pickupPoint && r.status === 'aprobada' ? ' (' + r.pickupPoint + ', código ' + r.code + ')' : ''));
  }
  return 'Tus solicitudes recientes:\n' + lines.join('\n');
}

export async function handleIncoming(ctx, key, text) {
  await insertChat(ctx.q, { chatKey: key, direction: 'in', text }, ctx.now);
  const p = key === 'unknown' ? null : await getPerson(ctx.q, key);
  if (!p || !p.hasAccount) {
    return reply(ctx, key, 'Hola 👋 Este número no está registrado en ' + ctx.settings.school.short + ' Salidas. Si eres padre o madre, regístrate en la app de padres o escribe a recepción al ' + ctx.settings.school.phone + '.');
  }
  const kids = await studentsOf(ctx, p.id);
  const n = normalize(text);
  const st = await getConversation(ctx.q, key);
  if (st && st.step) return handleStep(ctx, key, p, kids, st, n, text);
  if (!kids.length) {
    const auths = await authorizedFor(ctx, p.id);
    return reply(ctx, key, 'Hola ' + firstName(p.name) + '. No tienes hijos registrados como titular.' + (auths.length ? ' Estás autorizado(a) para retirar a: ' + auths.map((a) => a.student.name).join(', ') + '. Las solicitudes las crean los padres titulares.' : ''));
  }
  return dispatch(ctx, key, p, kids, n, text);
}
async function dispatch(ctx, key, p, kids, n, text) {
  const intent = detectIntent(n);
  if (intent === 'saludo') return reply(ctx, key, botMenu(ctx, p, kids));
  if (intent === 'estado') return reply(ctx, key, await statusSummary(ctx, p));
  if (intent === 'cancelar') return reply(ctx, key, 'No hay nada en proceso. ' + botMenu(ctx, p, kids));
  if (intent === 'nobus') return startNoBus(ctx, key, p, kids, n);
  if (intent === 'donde') return startDonde(ctx, key, p, kids, n);
  if (intent === 'salida') return startSalida(ctx, key, p, kids, n, text);
  if (intent === 'excusa') return startExcusa(ctx, key, p, kids, n, text);
  return reply(ctx, key, 'No te entendí 🤔\n\n' + botMenu(ctx, p, kids));
}

async function startSalida(ctx, key, p, kids, n, raw) {
  const draft = { kind: 'salida', requestedBy: p.id, channel: 'whatsapp', studentId: matchKid(n, kids), date: parseDate(n, ctx), time: parseTime(n), pickupHint: extractPickupHint(n), reason: raw };
  return continueSalida(ctx, key, p, kids, { step: 'salida', draft });
}
async function continueSalida(ctx, key, p, kids, st) {
  const d = st.draft;
  if (!d.studentId) { await setState(ctx, key, { step: 'ask_child', draft: d }); return reply(ctx, key, '¿A cuál de tus hijos? ', kids.map((k) => firstName(k.name))); }
  const kid = await getStudent(ctx.q, d.studentId);
  if (!d.time) { await setState(ctx, key, { step: 'ask_time', draft: d }); return reply(ctx, key, '¿A qué hora necesitas que ' + firstName(kid.name) + ' salga ' + fmtDate(ctx, d.date) + '? (ej. 3:30 pm)'); }
  if (d.pickupBy === undefined || d.pickupBy === null) {
    const pid = await resolvePickup(ctx, d.pickupHint, d.studentId, p.id);
    if (!pid) {
      await setState(ctx, key, { step: 'ask_pickup', draft: d });
      return reply(ctx, key, '"' + d.pickupHint + '" no aparece como persona autorizada para ' + firstName(kid.name) + '. Puedes registrarla en la app. ¿Quién va a retirar?', candidateLabels(await pickupCandidates(ctx, d.studentId), p));
    }
    d.pickupBy = pid;
  }
  await setState(ctx, key, { step: 'confirm', draft: d });
  const pk = await getPerson(ctx.q, d.pickupBy);
  const el = await pickupEligibility(ctx, d.studentId, d.pickupBy);
  return reply(ctx, key, '📋 Confirma la solicitud:\n• Estudiante: ' + kid.name + ' (' + kid.grade + ')\n• Fecha: ' + fmtDate(ctx, d.date) + '\n• Hora: ' + fmtTime(d.time) + '\n• Retira: ' + (pk.id === p.id ? 'tú' : pk.name + ' (' + pk.relation + ')') + (el.kind === 'una_vez' ? ' · autorización de una sola vez' : '') + '\n\n¿Es correcto?', ['Sí', 'No']);
}
async function startExcusa(ctx, key, p, kids, n, raw) {
  const draft = { kind: 'excusa', requestedBy: p.id, channel: 'whatsapp', studentId: matchKid(n, kids), date: parseDate(n, ctx), excusaType: /tard/.test(n) ? 'tardanza' : 'ausencia', reason: raw };
  return continueExcusa(ctx, key, p, kids, { step: 'excusa', draft });
}
async function continueExcusa(ctx, key, p, kids, st) {
  const d = st.draft;
  if (!d.studentId) { await setState(ctx, key, { step: 'ask_child', draft: d }); return reply(ctx, key, '¿Para cuál de tus hijos es la excusa?', kids.map((k) => firstName(k.name))); }
  const kid = await getStudent(ctx.q, d.studentId);
  await setState(ctx, key, { step: 'confirm', draft: d });
  return reply(ctx, key, '📋 Confirma la excusa:\n• Estudiante: ' + kid.name + ' (' + kid.grade + ')\n• Tipo: ' + d.excusaType + '\n• Fecha: ' + fmtDate(ctx, d.date) + '\n• Motivo: ' + d.reason + (d.attachment ? '\n• Adjunto: ' + d.attachment : '\n\nPuedes adjuntar el certificado con 📎 antes de confirmar.') + '\n\n¿Es correcto?', ['Sí', 'No', '📎 Adjuntar certificado']);
}
async function startDonde(ctx, key, p, kids, n) {
  const sid = matchKid(n, kids);
  if (!sid) { await setState(ctx, key, { step: 'ask_child', draft: { kind: 'donde' } }); return reply(ctx, key, '¿De cuál de tus hijos quieres saber?', kids.map((k) => firstName(k.name))); }
  return finishDonde(ctx, key, p, sid);
}
async function finishDonde(ctx, key, p, sid) {
  const w = await whereIs(ctx, sid);
  await logEvent(ctx, 'Consultó la ubicación de ' + (await getStudent(ctx.q, sid)).name + ' por WhatsApp', p.name);
  return reply(ctx, key, w.text, null, w.location ? { location: w.location } : {});
}
async function startNoBus(ctx, key, p, kids, n) {
  const legs = /manana|ida/.test(n) && !/tarde|vuelta|regreso/.test(n) ? ['ida'] : /tarde|vuelta|regreso/.test(n) && !/manana|ida/.test(n) ? ['vuelta'] : ['ida', 'vuelta'];
  const sid = matchKid(n, kids);
  if (!sid) { await setState(ctx, key, { step: 'ask_child', draft: { kind: 'nobus', legs } }); return reply(ctx, key, '¿Cuál de tus hijos no va en el bus hoy?', kids.map((k) => firstName(k.name))); }
  return finishNoBus(ctx, key, p, { studentId: sid, legs });
}
async function finishNoBus(ctx, key, p, d) {
  const st = await getStudent(ctx.q, d.studentId);
  if (!st.routeId) return reply(ctx, key, firstName(st.name) + ' no tiene ruta de bus registrada. Puedes asignarla en la app.');
  await markNoBus(ctx, d.studentId, p.id, d.legs);
  const r = await getRoute(ctx.q, st.routeId);
  const mon = await getStaff(ctx.q, r.monitorId);
  return reply(ctx, key, '🚌 Listo. Avisé a la monitora ' + mon.name + ' que ' + firstName(st.name) + ' hoy no va en el ' + r.name + ' (' + d.legs.map((l) => LEG_NAMES[l]).join(' y ') + ').');
}

async function handleStep(ctx, key, p, kids, st, n, raw) {
  if (/\bcancelar\b/.test(n)) { await clearState(ctx, key); return reply(ctx, key, 'Listo, cancelé el proceso. ' + botMenu(ctx, p, kids)); }
  const d = st.draft;
  const cont = async () => {
    if (d && d.kind === 'excusa') return continueExcusa(ctx, key, p, kids, st);
    if (d && d.kind === 'donde') { await clearState(ctx, key); return finishDonde(ctx, key, p, d.studentId); }
    if (d && d.kind === 'nobus') { await clearState(ctx, key); return finishNoBus(ctx, key, p, d); }
    return continueSalida(ctx, key, p, kids, st);
  };

  if (st.step === 'alert_pickup') {
    const req = await getRequest(ctx.q, st.requestId);
    if (/^(no|n)\b/.test(n)) {
      await clearState(ctx, key);
      if (req && ['aprobada', 'pendiente'].includes(req.status)) {
        const kid = await getStudent(ctx.q, req.studentId);
        const pk = await getPerson(ctx.q, req.pickupBy);
        await cancelRequest(ctx, req.id, p.id);
        await addRequestEvent(ctx.q, req.id, ctx.now, 'Cancelada: el titular NO reconoció a la persona que retira');
        await notifyRole(ctx, 'garita', '⛔ ' + p.name + ' NO reconoce a ' + pk.name + ' · salida de ' + kid.name + ' CANCELADA');
        for (const t of kid.titulares.filter((x) => x !== p.id)) {
          await notifyPerson(ctx, t, '⛔ ' + p.name + ' no reconoció a ' + pk.name + '; la salida de ' + firstName(kid.name) + ' fue cancelada.');
          const other = await getConversation(ctx.q, t);
          if (other && other.step === 'alert_pickup') await clearState(ctx, t);
        }
      }
      return reply(ctx, key, '⛔ Cancelé la salida y avisé a la garita. Recepción te contactará al ' + ctx.settings.school.phone + '.');
    }
    if (/correcto|^(si|sí|s|ok|dale)\b|conozco|reconozco/.test(n)) {
      await clearState(ctx, key);
      return reply(ctx, key, '👍 Gracias, queda confirmado. Te aviso cuando ' + firstName((await getStudent(ctx.q, req.studentId)).name) + ' salga.');
    }
    await clearState(ctx, key);
    return dispatch(ctx, key, p, kids, n, raw);
  }
  if (st.step === 'confirm_pickup') {
    const req = await getRequest(ctx.q, st.requestId);
    if (/^(si|sí|s|yes|confirmo|si, confirmo|ok|dale)\b/.test(n)) { await confirmPickup(ctx, req.id, p.id, true); return reply(ctx, key, '✅ Gracias, confirmaste la entrega. Te avisamos cuando ' + firstName((await getStudent(ctx.q, req.studentId)).name) + ' salga.'); }
    if (/^(no|n)\b/.test(n)) { await confirmPickup(ctx, req.id, p.id, false); return reply(ctx, key, '⛔ Entendido, NO se entregará al estudiante. La garita fue notificada.'); }
    return reply(ctx, key, 'Responde SÍ para confirmar o NO para negar la entrega.', ['Sí, confirmo', 'No']);
  }
  if (st.step === 'ask_child') {
    const kid = kids.find((k) => new RegExp('\\b' + normalize(firstName(k.name)) + '\\b').test(n));
    if (!kid) return reply(ctx, key, 'No reconocí el nombre. Elige uno:', kids.map((k) => firstName(k.name)));
    d.studentId = kid.id;
    return cont();
  }
  if (st.step === 'ask_time') {
    const t = parseTime(n);
    if (!t) return reply(ctx, key, 'No entendí la hora. Escríbela como 3:30 pm o 15:30.');
    d.time = t;
    const nd = parseDate(n, ctx);
    if (nd !== todayISO(ctx.now, ctx.tz)) d.date = nd;
    return cont();
  }
  if (st.step === 'ask_pickup') {
    if (/^(no|nadie|ninguno|ninguna)\b/.test(n)) { await clearState(ctx, key); return reply(ctx, key, 'Ok, descarté la solicitud. Registra a la persona en la app y vuelve a escribirme.'); }
    const hint = /^yo\b/.test(n) ? 'yo' : n.replace(/\(.*\)/, '').trim();
    const pid = await resolvePickup(ctx, hint, d.studentId, p.id);
    if (!pid) return reply(ctx, key, 'Esa persona no está autorizada. Elige una de la lista o regístrala en la app.', candidateLabels(await pickupCandidates(ctx, d.studentId), p));
    d.pickupBy = pid;
    return cont();
  }
  if (st.step === 'confirm') {
    if (/adjunt|certificado|📎/.test(n)) { d.attachment = 'certificado_medico.jpg'; await reply(ctx, key, '📎 Recibí certificado_medico.jpg ✅'); return cont(); }
    if (/^(si|sí|s|yes|correcto|ok|dale|confirmo)\b/.test(n)) {
      await clearState(ctx, key);
      const { pickupHint, attachment, ...data } = d;
      await createRequest(ctx, { ...data, attachmentName: attachment || null });
      return;
    }
    if (/^(no|n)\b/.test(n)) { await clearState(ctx, key); return reply(ctx, key, 'Ok, la descarté. Escríbeme de nuevo con los datos correctos, por ejemplo: "Necesito retirar a ' + firstName(kids[0].name) + ' hoy a las 3:30 pm".'); }
    return reply(ctx, key, 'Responde Sí para enviar o No para descartar.', ['Sí', 'No']);
  }
  await clearState(ctx, key);
  return reply(ctx, key, botMenu(ctx, p, kids));
}
```

Note: `handleIncoming` for a `confirm` step: `cont()` re-reads `st.draft` after mutation because `d` is the same object as `st.draft`; every `continue*` call persists the draft with `setState`.

- [ ] **Step 5: Implement `server/commands/whatsapp.js`**

```js
import { register } from './index.js';
import { handleIncoming } from '../bot/conversation.js';
import { getPerson } from '../db/repo.js';
import { deny, notFound, badRequest } from '../domain/errors.js';

register({
  whatsapp_inbound: {
    roles: ['parent', 'admin'],
    handler: async (ctx, input) => {
      const text = String(input.text || '').trim().slice(0, 500);
      if (!text) badRequest('text_required');
      let chatKey = ctx.person ? ctx.person.id : null;
      if (input.chatKey) {
        if (ctx.user.role !== 'admin' && input.chatKey !== chatKey) deny('forbidden_chat_key');
        if (input.chatKey !== 'unknown' && !(await getPerson(ctx.q, input.chatKey))) notFound('chat_key_not_found');
        chatKey = input.chatKey;
      }
      if (!chatKey) badRequest('chat_key_required');
      await handleIncoming({ ...ctx, channel: 'whatsapp' }, chatKey, text);
      return { chatKey };
    },
  },
});
```

Append to `server/commands/all.js`:

```js
import './whatsapp.js';
```

- [ ] **Step 6: Run the tests**

Run: `node --test server/bot/`
Expected: all PASS. `npm test` green.

- [ ] **Step 7: Commit**

```bash
git add server/bot server/commands/whatsapp.js server/commands/all.js
git commit -m "Move the WhatsApp bot to the server behind a simulated transport" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 11: Role projections (`GET /api/me/view`)

**Files:**
- Create: `server/projections/parent.js`, `server/projections/staff.js`
- Modify: `server/projections/index.js` (register builders)
- Test: `server/projections/views.test.js`

**Interfaces:**
- `VIEW_BUILDERS.parent(ctx)` and `VIEW_BUILDERS[<staff role>](ctx)`; every builder returns plain JSON. Shapes (all timestamps in ms, all ids as strings):
  - parent: `{ me, students[], persons{}, accounts[], authorizations[], authorizedFor[], requests[], notifications[], chat[], chatState, routes[], trips[], gpsNow{}, staffNames{}, unread }`
  - staff (admin, recepcion, profesor, garita, monitora): `{ me: staff, students[], persons{}, authorizations[], requests[], notifications[], staff[], routes[], trips[], gpsNow{}, staffNames{}, audit[], permissions{}, users[], chats{}, chatStates{}, unread }` where lists are scoped by the role rules below and admin-only fields are `null` for other roles.
- Scope rules: `todos_niveles` capability → all students; `staff.routeId` → students of that route; otherwise students whose grade is in `staff.grades`. Garita sees only today's salidas in `aprobada`/`retirado`. Requests of a scoped view are those whose `studentId` is in scope; excuses are dropped when the role lacks `ver_excusas`.

- [ ] **Step 1: Write the failing test**

`server/projections/views.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, call, loginAs } from '../test-helpers.js';

test('parent sees only the family, plus the directory of account holders', async () => {
  const t = await makeTestApp();
  await t.run('create_salida', 'u_p5', { studentId: 'e3', date: '2026-09-18', time: '13:00', pickupBy: 'p5', reason: 'x' });
  const v = await t.view('u_p1');
  assert.equal(v.user.role, 'parent');
  assert.equal(v.me.id, 'p1');
  assert.deepEqual(v.students.map((s) => s.id), ['e1', 'e2']);
  assert.deepEqual(v.students[0].titulares, ['p1', 'p2']);
  assert.deepEqual(Object.keys(v.persons).sort(), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.equal(v.persons.p3.docAttachmentId, 'att_p3');
  assert.ok(!('bytes' in v.persons.p3));
  assert.deepEqual(v.accounts.map((a) => a.id), ['p2', 'p5', 'p6', 'p7']);
  assert.ok(!('phone' in v.accounts[0]), 'directory has no phones');
  assert.deepEqual(v.authorizations.map((a) => a.id), ['a1', 'a2', 'a3', 'a4']);
  assert.equal(v.requests.length, 0, 'the e3 request belongs to another family');
  assert.deepEqual(v.routes.map((r) => r.id), ['r1']);
  assert.equal(v.trips[0].boarded.e1.status, 'abordo');
  assert.equal(v.staffNames.s6, 'Manuel Ortega');
  assert.equal(typeof v.serverNow, 'number');
  assert.equal(v.today, '2026-09-18');
  const laura = await t.view('u_p5');
  assert.deepEqual(laura.authorizedFor.map((x) => x.student.id), ['e1']);
  assert.equal(laura.requests.length, 1);
  assert.equal(laura.chat.length, 1, 'own chat only: the auto-approval message');
  assert.equal(laura.gpsNow.r2.leg, 'vuelta');
  await t.close();
});

test('teacher sees her grade, gate sees today approved salidas, monitor sees her route', async () => {
  const t = await makeTestApp();
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p3', reason: 'x' });
  await t.run('create_excusa', 'u_p5', { studentId: 'e3', date: '2026-09-19', excusaType: 'ausencia', reason: 'x' });
  const diana = await t.view('u_s3');
  assert.deepEqual(diana.students.map((s) => s.id), ['e1', 'e3']);
  assert.deepEqual(diana.requests.map((x) => x.kind).sort(), ['excusa', 'salida', 'salida'], 'r_h1 (e3), the excuse and the new salida');
  assert.ok(!diana.requests.some((x) => x.id === 'r_h3'), 'Emily is 9°');
  assert.equal(diana.audit, null);
  assert.equal(diana.users, null);
  assert.ok(diana.notifications.some((n) => n.text.startsWith('Salida aprobada: Joseph')));

  const gate = await t.view('u_s6');
  assert.deepEqual(gate.requests.map((x) => x.id), [r.id]);
  assert.equal(gate.persons.p3.cedula, '8-200-111');
  assert.ok(gate.notifications.some((n) => n.text.startsWith('Salida aprobada')));
  assert.equal(gate.authorizations.length, 0);

  const kenia = await t.view('u_s7');
  assert.deepEqual(kenia.routes.map((x) => x.id), ['r1']);
  assert.deepEqual(kenia.students.map((s) => s.id), ['e1', 'e2']);
  assert.equal(kenia.trips.length, 1);
  assert.equal(kenia.requests.length, 0);

  const rec = await t.view('u_s2');
  assert.equal(rec.students.length, 4);
  assert.equal(rec.requests.length, 5);
  assert.ok(rec.audit.length > 0);
  assert.equal(rec.users, null);

  const admin = await t.view('u_s1');
  assert.ok(admin.users.length >= 13);
  assert.equal(admin.permissions.garita.marcar_salida, true);
  assert.ok(Array.isArray(admin.chats.p1));
  assert.equal(admin.capabilities.config, true);
  await t.close();
});

test('the HTTP view carries the same shape and updates after a command', async () => {
  const t = await makeTestApp(); const { base, close } = await t.listen();
  const cookie = await loginAs(base, 'u_p1');
  const v1 = await call(base, '/api/me/view', { cookie });
  assert.equal(v1.json.view.requests.length, 0);
  const cmd = await call(base, '/api/commands/create_salida', { method: 'POST', cookie, body: { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' } });
  assert.equal(cmd.status, 200);
  assert.equal(cmd.json.view.requests.length, 1);
  assert.equal(cmd.json.revision, v1.json.revision + 1);
  const forbidden = await call(base, '/api/commands/approve_request', { method: 'POST', cookie, body: { requestId: cmd.json.result.id } });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.error, 'forbidden_role');
  await close(); await t.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/projections/views.test.js`
Expected: FAIL (`v.me` undefined).

- [ ] **Step 3: Implement `server/projections/parent.js`**

```js
import { listPersons, listAuthorizations, listRequests, listNotifications, listChat, getConversation, listRoutes, listTripsOn, listStaff, getStudent } from '../db/repo.js';
import { studentsOf, authorizedFor, todayOf } from '../domain/eligibility.js';

export const publicPerson = ({ id, name, phone, cedula, relation, hasAccount, docName, docAttachmentId }) => ({ id, name, phone, cedula, relation, hasAccount, docName, docAttachmentId });

export async function parentView(ctx) {
  const me = ctx.person;
  const students = await studentsOf(ctx, me.id);
  const ids = students.map((s) => s.id);
  const all = await listPersons(ctx.q);
  const byId = Object.fromEntries(all.map((p) => [p.id, p]));
  const authorizations = await listAuthorizations(ctx.q, { studentIds: ids, includeRevoked: false });
  const requests = await listRequests(ctx.q, { studentIds: ids });
  const wanted = new Set([me.id]);
  for (const s of students) for (const t of s.titulares) wanted.add(t);
  for (const a of authorizations) { wanted.add(a.personId); if (a.createdBy) wanted.add(a.createdBy); }
  for (const r of requests) { wanted.add(r.requestedBy); if (r.pickupBy) wanted.add(r.pickupBy); }
  const forOthers = await authorizedFor(ctx, me.id);
  for (const x of forOthers) if (x.auth.createdBy) wanted.add(x.auth.createdBy);
  const persons = {};
  for (const id of wanted) if (byId[id]) persons[id] = publicPerson(byId[id]);
  const routeIds = new Set(students.map((s) => s.routeId).filter(Boolean));
  const routes = (await listRoutes(ctx.q)).filter((r) => routeIds.has(r.id));
  const trips = (await listTripsOn(ctx.q, todayOf(ctx))).filter((t) => routeIds.has(t.routeId));
  const notifications = await listNotifications(ctx.q, { personId: me.id });
  return {
    me: publicPerson(me),
    students,
    persons,
    accounts: all.filter((p) => p.hasAccount && p.id !== me.id).map(({ id, name, relation }) => ({ id, name, relation })),
    authorizations,
    authorizedFor: forOthers.map((x) => ({ auth: x.auth, student: { id: x.student.id, name: x.student.name, grade: x.student.grade, emoji: x.student.emoji } })),
    requests,
    notifications,
    chat: await listChat(ctx.q, me.id),
    chatState: await getConversation(ctx.q, me.id),
    routes,
    trips,
    gpsNow: Object.fromEntries(routes.map((r) => [r.id, ctx.gps.position(r, ctx)])),
    staffNames: Object.fromEntries((await listStaff(ctx.q)).map((s) => [s.id, s.name])),
    unread: notifications.filter((n) => !n.read).length,
  };
}
```

`gpsNow` is the server's answer to "where is each bus right now" (`{ leg, progress, simulated } | null`), so the client never re-implements the GPS rule.

- [ ] **Step 4: Implement `server/projections/staff.js`**

```js
import { listStudents, listPersons, listAuthorizations, listRequests, listNotifications, listStaff, listRoutes, listTripsOn, listAudit, listUsers, listAllChats, listConversations } from '../db/repo.js';
import { todayOf } from '../domain/eligibility.js';
import { publicPerson } from './parent.js';

const can = (ctx, cap) => ctx.user.role === 'admin' || !!(ctx.permissions[ctx.user.role] || {})[cap];

export async function staffView(ctx) {
  const me = ctx.staff;
  const role = ctx.user.role;
  const everyone = await listStudents(ctx.q);
  const students = can(ctx, 'todos_niveles') ? everyone : me.routeId ? everyone.filter((s) => s.routeId === me.routeId) : everyone.filter((s) => (me.grades || []).includes(s.grade));
  const ids = students.map((s) => s.id);
  const today = todayOf(ctx);
  let requests = [];
  if (role === 'garita') requests = (await listRequests(ctx.q, { date: today, kind: 'salida' })).filter((r) => ['aprobada', 'retirado'].includes(r.status));
  else if (can(ctx, 'ver_solicitudes') || can(ctx, 'ver_excusas')) {
    requests = await listRequests(ctx.q, { studentIds: ids });
    if (!can(ctx, 'ver_solicitudes')) requests = requests.filter((r) => r.kind !== 'salida');
    if (!can(ctx, 'ver_excusas')) requests = requests.filter((r) => r.kind !== 'excusa');
  }
  const authorizations = can(ctx, 'gestionar_autorizados') || can(ctx, 'ver_estudiantes') ? await listAuthorizations(ctx.q, { studentIds: ids }) : [];
  const all = await listPersons(ctx.q);
  const byId = Object.fromEntries(all.map((p) => [p.id, p]));
  const persons = {};
  if (can(ctx, 'todos_niveles') && role !== 'garita') for (const p of all) persons[p.id] = publicPerson(p);
  else {
    const wanted = new Set();
    for (const s of students) for (const t of s.titulares) wanted.add(t);
    for (const a of authorizations) { wanted.add(a.personId); if (a.createdBy) wanted.add(a.createdBy); }
    for (const r of requests) { wanted.add(r.requestedBy); if (r.pickupBy) wanted.add(r.pickupBy); }
    for (const id of wanted) if (byId[id]) persons[id] = publicPerson(byId[id]);
  }
  if (role === 'garita') {
    const referenced = new Set(requests.map((r) => r.studentId));
    students.length = 0;
    for (const s of everyone) if (referenced.has(s.id)) students.push(s);
  }
  const allRoutes = await listRoutes(ctx.q);
  const routes = can(ctx, 'ver_rutas') ? (me.routeId ? allRoutes.filter((r) => r.id === me.routeId) : allRoutes) : [];
  const routeIds = new Set(routes.map((r) => r.id));
  const trips = (await listTripsOn(ctx.q, today)).filter((t) => routeIds.has(t.routeId));
  const notifications = [...(await listNotifications(ctx.q, { role })), ...(await listNotifications(ctx.q, { staffId: me.id }))].sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));
  const staff = await listStaff(ctx.q);
  return {
    me,
    students,
    persons,
    authorizations,
    requests,
    notifications,
    staff: can(ctx, 'personal') ? staff : staff.map(({ id, name, role: r, title }) => ({ id, name, role: r, title })),
    routes,
    trips,
    gpsNow: Object.fromEntries(routes.map((r) => [r.id, ctx.gps.position(r, ctx)])),
    staffNames: Object.fromEntries(staff.map((s) => [s.id, s.name])),
    audit: can(ctx, 'bitacora') ? await listAudit(ctx.q, 500) : null,
    permissions: role === 'admin' ? ctx.permissions : null,
    users: role === 'admin' ? (await listUsers(ctx.q)).map(({ id, name, role: r, kind, refId }) => ({ id, name, role: r, kind, refId })) : null,
    chats: role === 'admin' ? await listAllChats(ctx.q) : null,
    chatStates: role === 'admin' ? await listConversations(ctx.q) : null,
    unread: notifications.filter((n) => !n.read).length,
  };
}
```

- [ ] **Step 5: Register the builders in `server/projections/index.js`**

Add at the bottom of the file:

```js
import { parentView } from './parent.js';
import { staffView } from './staff.js';
VIEW_BUILDERS.parent = parentView;
for (const role of ['admin', 'recepcion', 'profesor', 'garita', 'monitora']) VIEW_BUILDERS[role] = staffView;
```

(ES module imports are hoisted, so placing the `import` lines after `export const VIEW_BUILDERS` is fine; keep them at the bottom for readability or move them to the top — both work.)

- [ ] **Step 6: Run the tests**

Run: `node --test server/projections/views.test.js`
Expected: 3 PASS. If the parent `chat.length` assertion for Laura fails, count the actual messages: the auto-approved salida sends Laura (requester and titular) exactly one WhatsApp message (`✅ Salida aprobada…`) and Pedro one info message; adjust the expected count to what `notifyPerson` produced and keep the assertion. `npm test` green.

- [ ] **Step 7: Commit**

```bash
git add server/projections
git commit -m "Add role-scoped projections for parents, staff, gate and monitors" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Administration commands — settings, permissions, demo reset, mark notifications read

**Files:**
- Create: `server/commands/admin.js`
- Modify: `server/commands/all.js`
- Test: `server/commands/admin.test.js`

**Interfaces:**
- `update_settings {data}` (staff with `config`) → settings; `set_permission {role, capability, allowed}` (staff with `personal`) → permissions; `reset_demo {}` (admin) → `{ revision }`; `mark_notifications_read {}` (everyone) → `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

`server/commands/admin.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers.js';
import { getSettings, getPermissions, listNotifications, listAudit } from '../db/repo.js';

test('update_settings validates and merges, and logs the change', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('update_settings', 'u_s2', { data: {} }), /forbidden_capability:config/);
  const { result } = await t.run('update_settings', 'u_s1', { data: { autoApprove: false, minAnticipationMin: 90, maxTitulares: 3, schoolStart: '07:00', schoolEnd: '14:30', simulateBus: false, busProgress: 0.5, newAuthDays: 10, school: { name: 'IAE Norte', phone: '+507 1', pickupPoints: ['Puerta A', 'Puerta B'] }, defaultPickupPoint: 'Puerta B' } });
  assert.equal(result.autoApprove, false);
  assert.equal(result.minAnticipationMin, 90);
  assert.equal(result.school.name, 'IAE Norte');
  assert.equal(result.defaultPickupPoint, 'Puerta B');
  assert.equal(result.timezone, 'America/Panama', 'timezone is kept');
  assert.equal((await getSettings(t.db)).school.short, 'IAE', 'untouched keys survive');
  const { result: fixed } = await t.run('update_settings', 'u_s1', { data: { defaultPickupPoint: 'No existe', minAnticipationMin: -5, busProgress: 7 } });
  assert.equal(fixed.defaultPickupPoint, 'Puerta A');
  assert.equal(fixed.minAnticipationMin, 0);
  assert.equal(fixed.busProgress, 1);
  await assert.rejects(t.run('update_settings', 'u_s1', { data: { schoolStart: '7am' } }), /invalid_time/);
  await assert.rejects(t.run('update_settings', 'u_s1', { data: { school: { pickupPoints: [] } } }), /pickup_points_required/);
  assert.match((await listAudit(t.db, 1))[0].summary, /^Actualizó la configuración \(auto-aprobación: inactiva, anticipación 0 min\)$/);
  await t.close();
});

test('set_permission edits the matrix except for admin', async () => {
  const t = await makeTestApp();
  await assert.rejects(t.run('set_permission', 'u_s2', { role: 'garita', capability: 'aprobar', allowed: true }), /forbidden_capability:personal/);
  await assert.rejects(t.run('set_permission', 'u_s1', { role: 'admin', capability: 'aprobar', allowed: false }), /admin_permissions_fixed/);
  await assert.rejects(t.run('set_permission', 'u_s1', { role: 'garita', capability: 'volar', allowed: true }), /invalid_capability/);
  const { result } = await t.run('set_permission', 'u_s1', { role: 'garita', capability: 'aprobar', allowed: true });
  assert.equal(result.garita.aprobar, true);
  assert.equal((await getPermissions(t.db)).garita.aprobar, true);
  const { result: r } = await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '11:00', pickupBy: 'p1', reason: 'x' });
  const { result: ok } = await t.run('approve_request', 'u_s6', { requestId: r.id });
  assert.equal(ok.status, 'aprobada', 'the gate can now approve');
  assert.match((await listAudit(t.db, 3)).map((a) => a.summary).join('\n'), /Permiso "aprobar" otorgado a Garita de salida/);
  await t.close();
});

test('reset_demo wipes movement and reseeds; mark_notifications_read marks mine', async () => {
  const t = await makeTestApp();
  await t.run('create_salida', 'u_p1', { studentId: 'e1', date: '2026-09-18', time: '13:00', pickupBy: 'p1', reason: 'x' });
  assert.equal((await listNotifications(t.db, { personId: 'p2' })).filter((n) => !n.read).length, 2);
  await t.run('mark_notifications_read', 'u_p2', {});
  assert.equal((await listNotifications(t.db, { personId: 'p2' })).filter((n) => !n.read).length, 0);
  assert.ok((await listNotifications(t.db, { role: 'garita' })).some((n) => !n.read));
  await t.run('mark_notifications_read', 'u_s6', {});
  assert.equal((await listNotifications(t.db, { role: 'garita' })).filter((n) => !n.read).length, 0);
  await assert.rejects(t.run('reset_demo', 'u_s2', {}), /forbidden_role/);
  const { result, revision } = await t.run('reset_demo', 'u_s1', {});
  assert.ok(result.revision >= 1);
  assert.ok(revision > result.revision);
  const v = await t.view('u_p1');
  assert.equal(v.requests.length, 0);
  assert.equal(v.notifications.length, 0);
  assert.equal(v.students.length, 2);
  await t.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/commands/admin.test.js`
Expected: FAIL, `unknown_command`.

- [ ] **Step 3: Implement `server/commands/admin.js`**

```js
import { register } from './index.js';
import { requireCap, STAFF_ROLES } from './guards.js';
import { getSettings, saveSettings, setPermission, getPermissions, markNotificationsRead } from '../db/repo.js';
import { resetAll, seedDemo } from '../db/seed.js';
import { logEvent } from '../domain/notifications.js';
import { roleName } from '../domain/text.js';
import { badRequest } from '../domain/errors.js';

const CAPS = ['ver_solicitudes', 'aprobar', 'ver_excusas', 'decidir_excusas', 'marcar_salida', 'ver_estudiantes', 'gestionar_autorizados', 'ver_rutas', 'marcar_bus', 'personal', 'config', 'bitacora', 'todos_niveles'];
const ROLES = ['recepcion', 'profesor', 'garita', 'monitora'];
const HHMM = /^\d{2}:\d{2}$/;
const clampInt = (v, min, max, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };

register({
  update_settings: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => {
      requireCap(ctx, 'config');
      const cur = await getSettings(ctx.q);
      const d = input.data || {};
      const next = { ...cur, school: { ...cur.school } };
      if ('autoApprove' in d) next.autoApprove = d.autoApprove === true || d.autoApprove === 'on';
      if ('simulateBus' in d) next.simulateBus = d.simulateBus === true || d.simulateBus === 'on';
      if ('minAnticipationMin' in d) next.minAnticipationMin = clampInt(d.minAnticipationMin, 0, 1440, cur.minAnticipationMin);
      if ('maxTitulares' in d) next.maxTitulares = clampInt(d.maxTitulares, 1, 4, cur.maxTitulares);
      if ('newAuthDays' in d) next.newAuthDays = clampInt(d.newAuthDays, 0, 60, cur.newAuthDays);
      if ('busProgress' in d) next.busProgress = Math.min(1, Math.max(0, Number(d.busProgress) || 0));
      for (const k of ['schoolStart', 'schoolEnd']) if (k in d) { if (!HHMM.test(String(d[k]))) badRequest('invalid_time'); next[k] = d[k]; }
      if (d.school) {
        if ('name' in d.school) next.school.name = String(d.school.name || '').trim() || cur.school.name;
        if ('phone' in d.school) next.school.phone = String(d.school.phone || '').trim() || cur.school.phone;
        if ('pickupPoints' in d.school) {
          const pts = [].concat(d.school.pickupPoints || []).map((x) => String(x).trim()).filter(Boolean);
          if (!pts.length) badRequest('pickup_points_required');
          next.school.pickupPoints = pts;
        }
      }
      const wanted = 'defaultPickupPoint' in d ? d.defaultPickupPoint : cur.defaultPickupPoint;
      next.defaultPickupPoint = next.school.pickupPoints.includes(wanted) ? wanted : next.school.pickupPoints[0];
      await saveSettings(ctx.q, next);
      await logEvent(ctx, 'Actualizó la configuración (auto-aprobación: ' + (next.autoApprove ? 'activa' : 'inactiva') + ', anticipación ' + next.minAnticipationMin + ' min)', ctx.staff.name);
      return next;
    },
  },
  set_permission: {
    roles: STAFF_ROLES,
    handler: async (ctx, input) => {
      requireCap(ctx, 'personal');
      if (input.role === 'admin') badRequest('admin_permissions_fixed');
      if (!ROLES.includes(input.role)) badRequest('invalid_role');
      if (!CAPS.includes(input.capability)) badRequest('invalid_capability');
      const allowed = input.allowed === true || input.allowed === 'on';
      await setPermission(ctx.q, input.role, input.capability, allowed);
      await logEvent(ctx, 'Permiso "' + input.capability + '" ' + (allowed ? 'otorgado a' : 'quitado a') + ' ' + roleName(input.role), ctx.staff.name);
      return getPermissions(ctx.q);
    },
  },
  reset_demo: {
    roles: ['admin'],
    handler: async (ctx) => {
      await resetAll(ctx.q);
      const revision = await seedDemo(ctx.q, { now: ctx.now, tz: ctx.tz });
      return { revision };
    },
  },
  mark_notifications_read: {
    roles: ['parent', ...STAFF_ROLES],
    handler: async (ctx) => {
      if (ctx.person) await markNotificationsRead(ctx.q, { personId: ctx.person.id }, ctx.now);
      if (ctx.staff) { await markNotificationsRead(ctx.q, { staffId: ctx.staff.id }, ctx.now); await markNotificationsRead(ctx.q, { role: ctx.user.role }, ctx.now); }
      return { ok: true };
    },
  },
});
```

Append to `server/commands/all.js`:

```js
import './admin.js';
```

Note on `reset_demo`: `runCommand` still inserts the audit row and bumps the revision after the handler, so the first audit entry after a reset is the reset itself and the revision keeps increasing (clients refresh because the ETag changes).

- [ ] **Step 4: Run the tests**

Run: `node --test server/commands/admin.test.js`
Expected: 3 PASS. `npm test` green.

- [ ] **Step 5: Commit**

```bash
git add server/commands/admin.js server/commands/all.js server/commands/admin.test.js
git commit -m "Add settings, permission matrix, demo reset and read-marking commands" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 13: Client — same UI, fed by `/api/me/view`, acting through commands

**Files:**
- Create: `index.html` (replace), `client/format.js`, `client/api.js`, `client/state.js`, `client/model.js`, `client/qr.js`
- Move: `styles.css` → `client/styles.css` (unchanged), `views.js` → `client/views.js` (edited as described)
- Modify: `package.json` (add `dev` script), `.env.example`, `.claude/launch.json`
- Test: manual end-to-end in the browser (there is no DOM test runner in this project); the server tests keep guarding the API.

**Interfaces:**
- Consumes: `GET /api/me/view`, `POST /api/commands/<name>` (response `{ ok, result, revision, view }`), `GET /api/attachments/:id`, `GET /api/events`, auth endpoints.
- Produces globals used across the classic scripts (load order matters): `format.js` → `api` (`api.js`) → `V, ME, UI, REV, serverNow(), adopt(), refresh(), apply(), boot(), showLogin(), doLogout(), toast()` (`state.js`) → model accessors (`model.js`) → `drawQRs()` (`qr.js`) → `render()` and handlers (`views.js`).

- [ ] **Step 1: Move the two files that stay as they are**

```bash
git mv styles.css client/styles.css
git mv views.js client/views.js
```

- [ ] **Step 2: Replace `index.html`**

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>IAE Salidas</title>
  <link rel="stylesheet" href="client/styles.css">
</head>
<body>
  <header class="topbar">
    <div class="brand">🏫 <b>IAE Salidas</b> <span id="connectedStatus" class="muted small">conectando…</span></div>
    <nav class="tabs" id="tabs"></nav>
    <div class="topbar-right">
      <label class="switch" id="splitWrap" style="display:none"><input type="checkbox" id="splitToggle"> Vista dividida</label>
      <span id="clock" class="muted mono"></span>
      <button class="btn ghost" data-action="showGuide">📖 Guion</button>
      <button class="btn ghost danger" data-action="resetDemo" id="resetBtn" style="display:none">↺ Reiniciar</button>
      <button class="btn ghost" data-action="logout" id="logoutBtn" style="display:none">Salir</button>
    </div>
  </header>
  <main id="main"></main>
  <div id="toasts"></div>
  <div id="modal" class="modal hidden"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <script>window.__IAE_SERVERLESS__ = /\.vercel\.app$/.test(location.hostname);</script>
  <script src="client/format.js"></script>
  <script src="client/api.js"></script>
  <script src="client/state.js"></script>
  <script src="client/model.js"></script>
  <script src="client/qr.js"></script>
  <script src="client/views.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create `client/format.js`** (browser copies of `server/domain/text.js` plus the formatters `views.js` already uses)

```js
/* Etiquetas y formateadores para el navegador (copia de server/domain/text.js). */
const pad = (n) => String(n).padStart(2, '0');
const ROLE_NAMES = { admin: 'Administración', recepcion: 'Recepción', profesor: 'Profesor', garita: 'Garita de salida', monitora: 'Monitora de bus', parent: 'Padre/Madre' };
const AUTH_TYPES = { siempre: 'Siempre', temporal: 'Por tiempo', una_vez: 'Una vez (con confirmación)' };
const STATUS = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada', retirado: 'Retirado', cancelada: 'Cancelada', aceptada: 'Aceptada' };
const CHANNEL = { whatsapp: 'WhatsApp', web: 'App' };
const LEG_NAMES = { ida: 'ida (mañana)', vuelta: 'vuelta (tarde)' };
const roleName = (r) => ROLE_NAMES[r] || r;
const kindLabel = (kind) => (kind === 'titular' ? 'Titular' : AUTH_TYPES[kind] || kind);
const firstName = (name) => (name || '').split(' ')[0];
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function localISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
/* "hoy" es el día de la escuela que manda el servidor (V.today), no el del navegador. */
function todayISO() { return (typeof V !== 'undefined' && V && V.today) || localISO(new Date()); }
function shiftISO(days) { const d = new Date(todayISO() + 'T12:00:00'); d.setDate(d.getDate() + days); return localISO(d); }
function nowHHMM() { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function minutesOf(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function addMinutes(hhmm, n) { const t = ((minutesOf(hhmm) + n) % 1440 + 1440) % 1440; return pad(Math.floor(t / 60)) + ':' + pad(t % 60); }
function fmtTime(hhmm) { if (!hhmm) return ''; const [h, m] = hhmm.split(':').map(Number); return (h % 12 || 12) + ':' + pad(m) + (h >= 12 ? ' pm' : ' am'); }
function fmtDate(iso) {
  if (!iso) return '';
  if (iso === todayISO()) return 'hoy';
  if (iso === shiftISO(1)) return 'mañana';
  if (iso === shiftISO(-1)) return 'ayer';
  return new Date(iso + 'T00:00:00').toLocaleDateString('es-PA', { weekday: 'short', day: 'numeric', month: 'short' });
}
function fmtTs(ts) { const d = new Date(ts); return d.toLocaleDateString('es-PA', { day: '2-digit', month: 'short' }) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function fmtClock(ts) { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function fmtClock12(ts) { return fmtTime(fmtClock(ts)); }
```

- [ ] **Step 4: Create `client/api.js`**

```js
/* Cliente HTTP mínimo. Todas las respuestas de comandos traen la proyección fresca (view). */
const api = (() => {
  async function req(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
    if (res.status === 304) return { notModified: true };
    const value = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(value.message || value.error || String(res.status)); e.status = res.status; e.code = value.error; throw e; }
    return value;
  }
  function shrinkImage(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const max = 640; const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.75));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }
  const readDataUrl = (file) => new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = reject; fr.readAsDataURL(file); });
  return {
    options: () => req('/api/auth/options'),
    login: (userId, pin) => req('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId, pin }) }),
    logout: () => req('/api/auth/logout', { method: 'POST' }),
    view: (etag) => req('/api/me/view', { headers: etag ? { 'if-none-match': etag } : {} }),
    command: (name, input) => req('/api/commands/' + name, { method: 'POST', body: JSON.stringify(input || {}) }),
    /* Convierte un File en el cuerpo de upload_attachment; las imágenes se reducen a 640 px JPEG. */
    async filePayload(file, purpose) {
      let dataUrl = await readDataUrl(file);
      if (/^image\//.test(file.type)) dataUrl = await shrinkImage(dataUrl);
      const [head, data] = dataUrl.split(',');
      const mime = (/^data:([^;]+)/.exec(head) || [])[1] || file.type;
      return { purpose, mime, name: file.name, dataBase64: data };
    },
    /* Notificación de cambios: SSE en local, sondeo cada 3 s en Vercel (o si SSE falla). */
    subscribe(onChange) {
      if (window.__IAE_SERVERLESS__ || !window.EventSource) { setInterval(onChange, 3000); return; }
      const es = new EventSource('/api/events');
      es.onmessage = () => onChange();
      setInterval(onChange, 15000); // red de seguridad si se pierde un evento
    },
  };
})();
```

- [ ] **Step 5: Create `client/state.js`**

```js
/* Estado del cliente: la proyección V que manda el servidor y el estado de interfaz UI. */
let V = null, ME = null, REV = 0, SKEW = 0;
const UI = { view: 'parents', split: false, phoneId: 'p1', schoolTab: 'inicio', parentTab: 'inicio', modal: null, filter: 'todas', busy: false };
const FORM_MODALS = ['newSalida', 'newExcusa', 'newAuth', 'reject', 'scan'];
let markTimer = null, subscribed = false;

function setBadge(text) { const el = document.getElementById('connectedStatus'); if (el) el.textContent = text; }
function serverNow() { return Date.now() + SKEW; }
function formOpen() { return !!(UI.modal && FORM_MODALS.includes(UI.modal.type)); }
function toast(text, kind = 'info') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 6000);
}
function toastNewNotifications(prev, next) {
  const seen = new Set((prev.notifications || []).map((n) => n.id));
  for (const n of next.notifications || []) if (!seen.has(n.id) && !n.read) toast((ME.role === 'parent' ? '📲 ' : '🏫 ') + n.text, ME.role === 'parent' ? 'wa' : 'school');
}
function adopt(payload) {
  const prev = V;
  V = payload.view; REV = payload.revision; ME = V.user; SKEW = V.serverNow - Date.now();
  if (prev && prev.user.id === ME.id) toastNewNotifications(prev, V);
}
async function refresh() {
  try {
    const r = await api.view('"' + REV + '"');
    if (r.notModified) return;
    adopt(r); setBadge('conectado · ' + ME.name);
    if (!formOpen()) render();
  } catch (e) { if (e.status === 401) return showLogin(); setBadge('sin conexión'); }
}
/* Ejecuta un comando y adopta la vista que devuelve. Lanza el error para que quien llama no siga. */
async function apply(name, input) {
  UI.busy = true; setBadge('guardando…');
  try { const r = await api.command(name, input); adopt(r); setBadge('conectado · ' + ME.name); return r.result; }
  catch (e) { if (e.status === 401) showLogin(); else toast('No se pudo guardar: ' + e.message, 'error'); throw e; }
  finally { UI.busy = false; }
}
function markReadSoon() {
  if (!V || !V.unread || markTimer) return;
  markTimer = setTimeout(() => { markTimer = null; apply('mark_notifications_read', {}).then(() => render()).catch(() => {}); }, 800);
}
async function boot() {
  try { const r = await api.view(); adopt(r); afterLogin(); }
  catch (e) { if (e.status === 401) showLogin(); else setBadge('sin conexión'); }
}
function afterLogin() {
  UI.view = ME.role === 'parent' ? 'parents' : 'school';
  UI.schoolTab = ME.role === 'garita' ? 'salidas_hoy' : ME.role === 'monitora' ? 'rutas' : 'inicio';
  UI.phoneId = ME.role === 'parent' ? V.me.id : 'p1';
  document.getElementById('splitWrap').style.display = ME.role === 'admin' ? '' : 'none';
  document.getElementById('resetBtn').style.display = ME.role === 'admin' ? '' : 'none';
  document.getElementById('logoutBtn').style.display = '';
  setBadge('conectado · ' + ME.name);
  render();
  if (!subscribed) { subscribed = true; api.subscribe(refresh); }
}
async function showLogin() {
  setBadge('inicia sesión');
  let options = [];
  try { options = await api.options(); } catch { setBadge('sin conexión'); return; }
  const modal = document.getElementById('modal');
  modal.className = 'modal';
  modal.innerHTML = '<div class="modal-card" style="max-width:420px"><h2>🏫 Entrar a IAE Salidas</h2><p class="muted">Elige tu usuario y escribe el PIN del piloto.</p>' +
    '<form id="loginForm" class="form"><label>Usuario<select name="userId">' + options.map((x) => '<option value="' + esc(x.id) + '">' + esc(x.name) + ' · ' + esc(roleName(x.role)) + '</option>').join('') + '</select></label>' +
    '<label>PIN<input name="pin" type="password" inputmode="numeric" required autofocus></label><button class="btn primary big">Entrar</button><div id="loginError" class="danger-text small"></div></form></div>';
  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try { await api.login(data.userId, data.pin); modal.className = 'modal hidden'; modal.innerHTML = ''; boot(); }
    catch (err) { document.getElementById('loginError').textContent = err.status === 429 ? 'Demasiados intentos. Espera 15 minutos.' : 'Usuario o PIN incorrecto.'; }
  };
}
async function doLogout() { try { await api.logout(); } finally { location.reload(); } }
```

- [ ] **Step 6: Create `client/model.js`** (the accessors `views.js` used from `app.js`, now over `V`)

```js
/* Accesores sobre la proyección V. Ninguna regla de negocio vive aquí: solo lectura para pintar. */
const person = (id) => (V.persons || {})[id] || null;
const student = (id) => (V.students || []).find((s) => s.id === id) || null;
const request = (id) => (V.requests || []).find((r) => r.id === id) || null;
const route = (id) => (V.routes || []).find((r) => r.id === id) || null;
const staffName = (id) => (V.staffNames || {})[id] || '';
const levelName = (id) => ((V.levels || []).find((l) => l.id === id) || {}).name || id;
function studentsOf(personId) { return (V.students || []).filter((s) => (s.titulares || []).includes(personId)); }
function isAuthActive(a) {
  const t = todayISO();
  if (a.revokedAt) return false;
  if (a.type === 'siempre') return true;
  if (a.type === 'temporal') return a.validFrom <= t && t <= a.validTo;
  if (a.type === 'una_vez') return !a.usedAt;
  return false;
}
function authsForStudent(sid) { return (V.authorizations || []).filter((a) => a.studentId === sid && !a.revokedAt); }
function authorizedFor() { return V.authorizedFor || []; }
function pickupEligibility(studentId, personId) {
  const st = student(studentId);
  if (!st || !personId) return { ok: false };
  if (st.titulares.includes(personId)) return { ok: true, kind: 'titular' };
  const a = (V.authorizations || []).find((x) => x.studentId === studentId && x.personId === personId && isAuthActive(x));
  return a ? { ok: true, kind: a.type, auth: a } : { ok: false };
}
function pickupCandidates(studentId) {
  const st = student(studentId);
  const list = st.titulares.map((id) => ({ person: person(id), kind: 'titular' }));
  authsForStudent(studentId).filter(isAuthActive).forEach((a) => list.push({ person: person(a.personId), kind: a.type, auth: a }));
  return list.filter((c) => c.person);
}
function staffCan(cap) { return !!(V.capabilities || {})[cap]; }
function getTrip(routeId, leg) { return (V.trips || []).find((t) => t.routeId === routeId && t.leg === leg) || { status: 'programado', boarded: {}, noBus: [] }; }
function currentLeg(r) { return (V.gpsNow || {})[r.id] || null; }
function legStops(r, leg) { return leg === 'ida' ? r.stops.slice().reverse() : r.stops; }
function busPosition(r, leg, progress) {
  const stops = legStops(r, leg); const n = stops.length;
  const segF = Math.min(0.999, Math.max(0, progress)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(segF)); const f = segF - i;
  const a = stops[i]; const b = stops[i + 1];
  const total = minutesOf(r.schedule[leg].end) - minutesOf(r.schedule[leg].start);
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, prevStop: a, nextStop: b, index: i, frac: f, stops, minutesLeft: Math.round((1 - progress) * total) };
}
function chatMessages(key) { return ME.role === 'parent' ? (V.chat || []) : ((V.chats || {})[key] || []); }
function chatStateFor(key) { return ME.role === 'parent' ? V.chatState : ((V.chatStates || {})[key] || null); }
function allChats() { return ME.role === 'parent' ? { me: V.chat || [] } : (V.chats || {}); }
function describePickup(r) { const pk = person(r.pickupBy); if (!pk) return ''; return pk.name + (r.pickupBy === r.requestedBy ? ' (solicitante)' : ' (' + pk.relation + ')'); }
```

- [ ] **Step 7: Create `client/qr.js`**

```js
function drawQRs() {
  document.querySelectorAll('.qrc[data-qr]').forEach((c) => {
    if (c.childNodes.length) return;
    if (window.QRCode) { try { new QRCode(c, { text: c.dataset.qr, width: 120, height: 120, correctLevel: QRCode.CorrectLevel.M }); } catch (e) { c.style.display = 'none'; } }
    else c.style.display = 'none';
  });
}
```

- [ ] **Step 8: Edit `client/views.js` — global substitutions**

Apply these replacements across the whole file (search each literal; every occurrence changes the same way):

| Find | Replace with |
|---|---|
| `S.school` | `V.settings.school` |
| `S.settings` | `V.settings` |
| `S.levels` | `V.levels` |
| `.level)` (in `levelName(k.level)`, `levelName(st.level)`, `s.level === lv.id`) | `.levelId)` / `.levelId ===` |
| `S.staff` | `V.staff` |
| `S.permissions` | `V.permissions` |
| `S.requests` | `V.requests` |
| `S.authorizations` | `V.authorizations` |
| `S.notifications` | `V.notifications` |
| `S.students` | `V.students` |
| `S.log` | `(V.audit \|\| [])` |
| `staffMember(r.exitBy).name`, `staffMember(r.decidedBy) \|\| {}).name \|\| ''`, `staffMember(rec.by).name`, `staffMember(x).name` | `staffName(r.exitBy)`, `staffName(r.decidedBy)`, `staffName(rec.by)`, … |
| `a.from` / `a.to` | `a.validFrom` / `a.validTo` |
| `a.used ?` | `a.usedAt ?` |
| `a.revoked` | `a.revokedAt` |
| `p.account` / `pr.account` / `x.account` / `pk.account` | `.hasAccount` |
| `p.docImage` / `pk.docImage` (as a truthy test) | `.docAttachmentId`; and every `src="' + p.docImage + '"` becomes `src="/api/attachments/' + esc(p.docAttachmentId) + '"` |
| `p.doc \|\|` / `pk.doc \|\|` | `.docName \|\|` |
| `n.to ?` `n.toRole` `n.toStaff` | `n.personId ?` `n.role` `n.staffId` |
| `person(UI.parentId)` | `V.me` |
| `UI.parentId` | `V.me.id` |
| `UI.staffId` | `V.me.id` |
| `save();` and `save()` | delete the call |
| `shrinkImage(` (the function definition block, lines 477-490) | delete the whole function (now in `api.js`) |
| `unreadFor(p.id)` | `V.unread` |
| `unreadForStaff(staff)` | `V.unread` |
| `visibleRequests(staff)` | `V.requests` |
| `staffScope(staff)` | `V.students` |
| `visibleRoutes(staff)` | `V.routes` |
| `staffCan(staff, ` | `staffCan(` |
| `logEvent(` … `)` calls inside `whereKid` and `scan` | delete (the server logs) |
| `r.confirmation.status` | unchanged (same shape) |
| `trip.boarded[k.id]` / `trip.noBus.includes` | unchanged |
| `mon ? mon.name : '—'` (after `const mon = staffMember(r.monitorId)`) | `staffName(r.monitorId) \|\| '—'` and delete the `const mon` line |
| `fmtClock12(rec.ts)` | unchanged (defined in `format.js`) |

- [ ] **Step 9: Edit `client/views.js` — replace these functions entirely**

Bootstrap (replace lines 6–19):

```js
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('splitToggle').addEventListener('change', (e) => { UI.split = e.target.checked; render(); });
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'waInput') { e.preventDefault(); sendChat(); }
    if (e.key === 'Escape' && UI.modal) { UI.modal = null; renderModal(); }
  });
  tickClock();
  setInterval(tickClock, 15000);
  boot();
});
```

`render()`:

```js
let pendingTimer = null;
function render() {
  if (!V) return;
  const main = document.getElementById('main');
  const active = document.activeElement;
  const keep = active && active.id === 'waInput' ? { id: 'waInput', value: active.value } : null;
  renderTabs();
  if (UI.split && ME.role === 'admin') {
    main.className = 'split';
    main.innerHTML = '<div class="pane">' + viewWhatsapp() + '</div><div class="pane">' + viewSchool() + '</div>';
  } else {
    main.className = 'single ' + UI.view;
    main.innerHTML = { parents: viewParents, whatsapp: viewWhatsapp, school: viewSchool, log: viewLog }[UI.view]();
  }
  renderModal();
  drawQRs();
  if (keep) { const el = document.getElementById(keep.id); if (el) { el.value = keep.value; el.focus(); } }
  const chat = document.getElementById('waChat');
  if (chat) chat.scrollTop = chat.scrollHeight;
  const now = serverNow();
  const pend = Object.values(allChats()).flat().filter((m) => m.pendingUntil && m.pendingUntil > now).map((m) => m.pendingUntil);
  clearTimeout(pendingTimer);
  if (pend.length) pendingTimer = setTimeout(render, Math.min(...pend) - now + 20);
}
```

Delete the old `drawQRs` from `views.js` (it lives in `qr.js`).

`renderTabs()`:

```js
function renderTabs() {
  const all = [['parents', '📱 App Padres'], ['whatsapp', '💬 WhatsApp'], ['school', '🏫 Escuela'], ['log', '📜 Bitácora']];
  const allowed = ME.role === 'parent' ? ['parents', 'whatsapp'] : ME.role === 'admin' ? ['whatsapp', 'school', 'log'] : ['school'];
  if (!allowed.includes(UI.view)) UI.view = allowed[0];
  document.getElementById('tabs').innerHTML = all.filter(([k]) => allowed.includes(k)).map(([k, l]) => '<button class="tab' + (UI.view === k ? ' active' : '') + '" data-action="setView" data-view="' + k + '">' + l + '</button>').join('');
}
```

`viewParents()` — first six lines become:

```js
function viewParents() {
  const p = V.me;
  const unread = V.unread;
  const tab = UI.parentTab;
  const body = { inicio: parentHome, solicitudes: parentRequests, autorizados: parentAuths, avisos: parentNotifs }[tab](p);
  return '<div class="phone-wrap"><div class="phone app">' +
```

(remove the `accounts` line, the `if (!person(UI.parentId)…)` line and the `sim-bar` `<select data-change="setParent">` fragment; the rest of the function is unchanged).

`parentHome(p)`: `const auths = authorizedFor();` (no argument).

`parentNotifs(p)`:

```js
function parentNotifs(p) {
  const list = V.notifications.slice().reverse();
  markReadSoon();
  return '<div class="section-title">Avisos</div>' + (list.length ? list.map((n) => '<div class="card notif"><div class="small muted">' + fmtTs(n.ts) + '</div>' + esc(n.text) + '</div>').join('') : '<div class="empty">Sin avisos todavía.</div>');
}
```

`viewWhatsapp()` — header part becomes:

```js
function viewWhatsapp() {
  const isParent = ME.role === 'parent';
  const key = isParent ? V.me.id : UI.phoneId;
  const p = key === 'unknown' ? null : (isParent ? V.me : person(key));
  const msgs = chatMessages(key);
  const now = serverNow();
  const lastBotIdx = msgs.map((m) => m.from).lastIndexOf('bot');
  const bubbles = /* unchanged */;
  const welcome = /* unchanged */;
  const picker = isParent ? '' : '<div class="sim-bar">📞 Simular teléfono de: <select data-change="setPhone">' +
    Object.values(V.persons).filter((x) => x.phone).map((x) => opt(x.id, x.name + ' · ' + x.phone + (x.hasAccount ? '' : ' (sin cuenta)'), x.id === key)).join('') +
    opt('unknown', 'Número desconocido · +507 6000-0000', key === 'unknown') + '</select></div>';
  return '<div class="phone-wrap">' + picker +
    '<div class="phone wa"> … (unchanged from here on) …';
}
```

`chatChips(p, key)`: replace `const st = S.chatState[key];` with `const st = chatStateFor(key);` and `p.account` with `p.hasAccount`.

`sendChat()` and the quick-reply helper:

```js
function sendText(text) {
  const t = (text || '').trim();
  if (!t) return;
  apply('whatsapp_inbound', ME.role === 'parent' ? { text: t } : { text: t, chatKey: UI.phoneId }).then(render).catch(() => {});
}
function sendChat() {
  const input = document.getElementById('waInput');
  const text = input.value;
  input.value = '';
  sendText(text);
}
```

`viewSchool()` — the user block:

```js
function viewSchool() {
  const staff = V.me;
  const tabs = availableTabs(staff);
  if (!tabs.some(([k]) => k === UI.schoolTab)) UI.schoolTab = staff.role === 'garita' ? 'salidas_hoy' : staff.role === 'monitora' ? 'rutas' : tabs[0][0];
  const unread = V.unread;
  const body = { /* unchanged */ }[UI.schoolTab](staff);
  const scope = staff.routeId ? '<span class="muted">solo ' + esc((route(staff.routeId) || {}).name || staff.routeId) + '</span>' : staff.grades ? '<span class="muted">grados: ' + esc(staff.grades.join(', ')) + '</span>' : '<span class="muted">todos los niveles</span>';
  return '<div class="dash"><aside class="side"><div class="side-brand">🏫 ' + esc(V.settings.school.short) + ' Salidas<div class="small muted">' + esc(V.settings.school.name) + '</div></div>' +
    '<div class="side-user"><label class="small muted">Usuario</label><div><b>' + esc(staff.name) + '</b></div>' +
    '<div class="small"><span class="badge role-' + staff.role + '">' + esc(roleName(staff.role)) + '</span> ' + scope + '</div></div>' +
    '<nav class="side-nav">' + /* unchanged */ + '</nav></aside>' +
    '<section class="content">' + body + '</section></div>';
}
```

`schoolHome(staff)`: `const notifs = V.notifications.slice(-8).reverse(); markReadSoon();` (delete the `forEach(n.read = true)` and `save()` lines).

`schoolGate(staff)`: `const list = V.requests.filter((r) => r.kind === 'salida' && r.date === t && ['aprobada', 'retirado'].includes(r.status)).sort((a, b) => a.time.localeCompare(b.time));` (same expression; `V.requests` is already scoped for the gate and filtered here for admin).

`schoolStudents`: the request count cell becomes `V.requests.filter((r) => r.studentId === k.id).length`.

`schoolAuths`: the `vig` line becomes `const vig = a.type === 'temporal' ? a.validFrom + ' → ' + a.validTo : a.type === 'una_vez' ? (a.usedAt ? 'usada ' + fmtTs(a.usedAt) : 'pendiente de uso') : 'permanente';` and `estado` uses `a.revokedAt`.

`schoolStaff`: `V.permissions[r][c]` (admin only tab, `V.permissions` present).

`logTable()` and `viewLog()`:

```js
function logTable() {
  return '<table class="tbl"><tr><th>Fecha</th><th>Actor</th><th>Evento</th></tr>' + (V.audit || []).slice(0, 200).map((l) => '<tr><td class="mono small">' + fmtTs(l.ts) + '</td><td>' + esc(l.actor) + '</td><td>' + esc(l.text) + '</td></tr>').join('') + '</table>';
}
function viewLog() { return '<div class="page"><h2>📜 Bitácora del sistema</h2>' + logTable() + '</div>'; }
```

`personDoc(p)`:

```js
function personDoc(p) {
  if (p.docAttachmentId) return '<img class="doc-thumb" src="/api/attachments/' + esc(p.docAttachmentId) + '" data-action="openDoc" data-id="' + p.id + '" title="Ver documento">';
  return '<div class="doc-placeholder" data-action="openDoc" data-id="' + p.id + '" title="Ver documento">🪪<br>' + esc(p.docName || 'sin foto') + '</div>';
}
```

`schoolRutas(staff)`: `const can = staffCan('marcar_bus'); const list = V.routes;` … inside the map: `const cur = currentLeg(r);` (unchanged call, now from `model.js`), `const trip = getTrip(r.id, leg);`, `const kids = V.students.filter(...)`, delete `const mon = staffMember(r.monitorId);` and use `staffName(r.monitorId) || '—'`.

`modalSalida(d)`, `modalExcusa(d)`, `modalAuth(d)`: `const p = V.me;` and in `modalAuth` the account list becomes `V.accounts.map((a) => opt(a.id, a.name + ' · ' + a.relation, a.id === d.personId)).join('')`.

`modalWhere(d)`:

```js
function modalWhere(d) {
  const st = student(d.id); const w = d.result;
  return '<h3>📍 ¿Dónde está ' + esc(firstName(st.name)) + '?</h3><div class="where-box">' + (w ? esc(w.text) : 'Consultando…') + '</div>' + (w && w.location ? '<div style="margin-top:10px">' + locationCard(w.location) + '</div>' : '') +
    '<p class="small muted" style="margin-top:8px">La ubicación solo se muestra a titulares, dentro del horario de la ruta, y proviene del GPS del bus (simulado en este demo).</p>' +
    '<div class="actions"><button class="btn primary" data-action="closeModal">Cerrar</button></div>';
}
```

`modalScan(d)`: `pk.docImage ? '<img … src="' + pk.docImage + '">'` becomes `pk.docAttachmentId ? '<img class="doc-big" style="max-width:220px; margin:0" src="/api/attachments/' + esc(pk.docAttachmentId) + '">'`; `esc(pk.doc || 'sin foto')` → `esc(pk.docName || 'sin foto')`; the `today` list uses `V.requests`.

`modalDoc(d)`: same `docAttachmentId` / `docName` treatment.

`modalGuide()`: change step 7 to `'<li><b>Permisos:</b> en otro dispositivo inicia sesión como Prof. Diana Ríos (solo ve 3°) y luego como Administración para editar la matriz de permisos y la regla de auto-aprobación.</li>'` and step 9 to start with `'<li><b>Monitora:</b> inicia sesión como Kenia Pérez (solo ve el Bus 12)…'`; the last bullet becomes `'<li>Como Administración, activa <b>Vista dividida</b> para ver WhatsApp y el dashboard a la vez; cada dispositivo del demo entra con su propio usuario.</li>'`.

Event handlers (replace everything from `const ACTIONS = {` to the end of the file):

```js
/* run: ejecuta un comando, repinta y avisa. Devuelve null si el servidor lo rechazó (apply ya mostró el error). */
function run(name, input, okText) {
  return apply(name, input).then((res) => { render(); if (okText) toast(okText, 'ok'); return res; }).catch(() => null);
}
const ACTIONS = {
  setView(el) { UI.view = el.dataset.view; },
  logout() { doLogout(); },
  resetDemo() { if (confirm('¿Reiniciar el demo con los datos de ejemplo?')) run('reset_demo', {}, 'Demo reiniciado con datos de ejemplo').then(() => { UI.modal = null; render(); }); },
  showGuide() { UI.modal = { type: 'guide' }; },
  closeModal() { UI.modal = null; },
  openModal(el) { UI.modal = { type: el.dataset.modal, data: { id: el.dataset.id } }; },
  parentTab(el) { UI.parentTab = el.dataset.tab; },
  schoolTab(el) { UI.schoolTab = el.dataset.tab; },
  setFilter(el) { UI.filter = el.dataset.f; },
  chatSend() { sendChat(); },
  chatQuick(el) { sendText(el.dataset.text); },
  cancelReq(el) { if (confirm('¿Cancelar esta solicitud?')) run('cancel_request', { requestId: el.dataset.id }); },
  revokeAuth(el) { if (confirm('¿Revocar esta autorización?')) run('revoke_authorization', { authorizationId: el.dataset.id }); },
  revokeAuthSchool(el) { if (confirm('¿Revocar esta autorización?')) run('revoke_authorization', { authorizationId: el.dataset.id }); },
  approve(el) {
    const sel = document.getElementById('pp-' + el.dataset.id);
    run('approve_request', { requestId: el.dataset.id, pickupPoint: sel ? sel.value : V.settings.defaultPickupPoint }, 'Salida aprobada y padres notificados');
  },
  acceptExcusa(el) { run('accept_excusa', { requestId: el.dataset.id }, 'Excusa aceptada'); },
  askConfirm(el) { run('request_confirmation', { requestId: el.dataset.id }, 'Se pidió confirmación a los titulares por WhatsApp'); },
  markExit(el) {
    const r = request(el.dataset.id);
    const pk = person(r.pickupBy);
    if (!confirm('¿Verificaste la cédula ' + pk.cedula + ' de ' + pk.name + ' (' + pk.relation + ')?\nCódigo de retiro: ' + r.code)) return;
    run('mark_exit', { requestId: r.id }, 'Salida registrada. Padres notificados.').then((res) => { if (res) { UI.modal = null; render(); } });
  },
  whereKid(el) {
    UI.modal = { type: 'where', data: { id: el.dataset.id } };
    apply('where_is', { studentId: el.dataset.id })
      .then((w) => { if (UI.modal && UI.modal.type === 'where' && UI.modal.data.id === el.dataset.id) { UI.modal.data.result = w; renderModal(); } })
      .catch(() => { UI.modal = null; renderModal(); });
  },
  noBusKid(el) { if (confirm('¿Avisar a la monitora que hoy no va en el bus (ida y vuelta)?')) run('mark_no_bus', { studentId: el.dataset.id, legs: ['ida', 'vuelta'] }, 'Aviso enviado a la monitora'); },
  openDoc(el) { UI.modal = { type: 'doc', data: { id: el.dataset.id } }; },
  board(el) { run('mark_boarding', { routeId: el.dataset.route, leg: el.dataset.leg, studentId: el.dataset.id, status: el.dataset.status, stopId: el.dataset.stop || null }); },
  tripStatus(el) { run('set_trip_status', { routeId: el.dataset.route, leg: el.dataset.leg, status: el.dataset.status }); },
};
function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) {
    if (e.target.id === 'modal' && V) { UI.modal = null; renderModal(); }
    return;
  }
  const fn = ACTIONS[el.dataset.action];
  if (!fn || !V) return;
  fn(el);
  render();
}
const FORMS = {
  newSalida(d) {
    run('create_salida', { studentId: d.studentId, date: d.date, time: d.time, pickupBy: d.pickupBy, reason: d.reason }).then((r) => {
      if (!r) return;
      UI.modal = null; UI.parentTab = 'solicitudes'; render();
      toast(r.status === 'aprobada' ? 'Solicitud auto-aprobada ✅' : 'Solicitud enviada, pendiente de la escuela', 'ok');
    });
  },
  async newExcusa(d, form) {
    const file = form.querySelector('input[name=attachment]').files[0] || null;
    let attachmentId = null, attachmentName = null;
    if (file) {
      const up = await run('upload_attachment', await api.filePayload(file, 'certificado'));
      if (!up) return;
      attachmentId = up.attachmentId; attachmentName = file.name;
    }
    const r = await run('create_excusa', { studentId: d.studentId, date: d.date, excusaType: d.excusaType, reason: d.reason, attachmentId, attachmentName });
    if (!r) return;
    UI.modal = null; UI.parentTab = 'solicitudes'; render(); toast('Excusa enviada', 'ok');
  },
  async newAuth(d, form) {
    const ids = [].concat(d.studentIds || []);
    if (!ids.length) { alert('Elige al menos un estudiante.'); return; }
    if (d.type === 'temporal' && d.to < d.from) { alert('La fecha "hasta" debe ser posterior a "desde".'); return; }
    const file = form.querySelector('input[name=docFile]').files[0] || null;
    if (d.mode === 'nueva' && !file) { alert('Sube una foto de la persona o de su cédula.'); return; }
    let attachmentId = null;
    if (file) {
      const up = await run('upload_attachment', await api.filePayload(file, 'cedula'));
      if (!up) return;
      attachmentId = up.attachmentId;
    }
    const r = await run('add_authorization', { studentIds: ids, mode: d.mode, personId: d.personId, name: d.name, relation: d.relation, cedula: d.cedula, phone: d.phone, attachmentId, type: d.type, from: d.from, to: d.to });
    if (!r) return;
    UI.modal = null; UI.parentTab = 'autorizados'; render(); toast('Autorización guardada', 'ok');
  },
  scan(d) {
    run('scan_code', { code: d.code }).then((res) => { if (res) { UI.modal = { type: 'scan', data: { found: res.requestId } }; render(); } });
  },
  reject(d) {
    run('reject_request', { requestId: d.id, reason: d.reason }, 'Rechazada y padres notificados').then((r) => { if (r) { UI.modal = null; render(); } });
  },
  saveConfig(d) {
    run('update_settings', { data: {
      autoApprove: d.autoApprove === 'on', minAnticipationMin: +d.minAnticipationMin, maxTitulares: +d.maxTitulares,
      schoolStart: d.schoolStart, schoolEnd: d.schoolEnd, simulateBus: d.simulateBus === 'on', busProgress: (+d.busProgress || 0) / 100,
      newAuthDays: +d.newAuthDays, defaultPickupPoint: d.defaultPickupPoint,
      school: { name: d.schoolName, phone: d.schoolPhone, pickupPoints: String(d.pickupPoints || '').split('\n').map((x) => x.trim()).filter(Boolean) },
    } }, 'Configuración guardada');
  },
};
function onSubmit(e) {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fn = FORMS[form.dataset.form];
  if (!fn || !V) return;
  fn(formData(form), form);
}
function onChange(e) {
  const el = e.target.closest('[data-change]');
  if (!el || !V) return;
  const k = el.dataset.change;
  if (k === 'setPhone') { UI.phoneId = el.value; render(); return; }
  if (k === 'busProgress') { const b = el.closest('label').querySelector('b'); if (b) b.textContent = el.value + '%'; return; } // se guarda con "Guardar"
  if (k === 'togglePerm') { run('set_permission', { role: el.dataset.role, capability: el.dataset.cap, allowed: el.checked }); return; }
  if (k === 'modalField') { const form = el.closest('form'); UI.modal.data = Object.assign({}, UI.modal.data, formData(form)); renderModal(); }
}
```

Keep `formData(form)` exactly as it was.

- [ ] **Step 10: Local run scripts**

`package.json` scripts add: `"dev": "node --env-file=.env server/index.js"`.

`.env.example` (replace):

```
# Obligatorios
SESSION_SECRET=cambia-esto-por-32-o-mas-caracteres-aleatorios
PILOT_PIN=4321
# Opcional en local (sin esto se usa PGlite en data/pglite). Obligatorio en Vercel (Neon).
# DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
PORT=3000
```

Create `.env` locally (it is gitignored) with a real 32+ char secret and `PILOT_PIN=4321`.

`.claude/launch.json` (replace):

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "iae-salidas", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 3000 }
  ]
}
```

- [ ] **Step 11: Syntax check and server tests**

```bash
node --check client/format.js && node --check client/api.js && node --check client/state.js && node --check client/model.js && node --check client/qr.js && node --check client/views.js && npm test
```

Expected: no syntax errors, tests green (the static test now serves `client/*.js` with 200).

- [ ] **Step 12: End-to-end check in the browser (two sessions)**

1. Delete `data/pglite` (`npm run reset`) and start the server (`npm run dev`, or the `iae-salidas` preview).
2. Tab A: open `http://localhost:3000`, log in as **Carlos Rodríguez** (PIN 4321). Expect the parent app with Joseph and Sofía, the WhatsApp tab, no "simular" selectors, badge "conectado · Carlos Rodríguez".
3. Tab A → WhatsApp: tap the chip "Necesito retirar a Joseph hoy a las …" (≈2 h ahead), then "Sí". Expect the typing dots, then "✅ Salida aprobada … Código: NNNN". Parents tab → Solicitudes shows the QR and code.
4. Tab B (private window): log in as **Yadira Batista**. Expect Inicio with "Salidas pendientes" and the notification "Salida aprobada: Joseph…" arriving without reload (SSE).
5. Tab A: send "A Joseph lo retira la abuela a las <30 min ahead>" → "Sí". Tab B: the request appears pending within seconds; approve it choosing "Recepción". Tab A: the approval message arrives in WhatsApp and in Avisos.
6. Tab C: log in as **Manuel Ortega**. "Garita · Hoy" lists both salidas; "Escanear QR / código" with the code → the modal shows María's document (SVG) → "marcar retirado". Tab A gets "🚪 Joseph salió por Recepción a las …".
7. Tab A: "¿Dónde está Sofía?" in WhatsApp → bus card with map. Parents tab → "📍 ¿Dónde está?" on Sofía → same text in the modal.
8. Tab B → Autorizados: nothing to add there; Tab A → Autorizados → "+ Autorizar" a new person with a photo (any image) → saved; Tab B sees "Nueva persona autorizada" in Avisos.
9. Log in as **Lic. Rosa Martínez** in Tab B: Escuela shows all tabs, "Vista dividida" toggles WhatsApp + dashboard, the WhatsApp picker offers every phone plus "Número desconocido"; "↺ Reiniciar" resets everything and Tab A refreshes to seed data.
10. `read_console_messages` in the browser tool: no errors. Fix anything found before committing.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "Port the UI to the server projection and command API" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 14: Vercel + Neon deployment files, CI, docs and removal of the old prototype files

**Files:**
- Modify: `vercel.json`, `Dockerfile`, `.dockerignore`, `.gitignore`, `README.md`, `ARCHITECTURE.md`, `VERCEL-DEPLOY.md`
- Create: `.vercelignore`, `.github/workflows/ci.yml`
- Delete: `app.js`, `seed.js`, `pilot.html`, `pilot.js`, `connected-app.js`, `demo.html`, `connected-bridge.js`, `deploy.example.yaml`, `compose.yaml`, `migrations.md`

- [ ] **Step 1: Delete the prototype and bridge files**

```bash
git rm -q app.js seed.js pilot.html pilot.js connected-app.js demo.html connected-bridge.js deploy.example.yaml compose.yaml migrations.md
```

Then grep to be sure nothing references them:

```bash
grep -rn "connected-bridge\|pilot.js\|connected-app\|makeSeed\|prototype-state" --include=*.js --include=*.html --include=*.json --include=*.md . | grep -v node_modules | grep -v brag-output | grep -v docs/superpowers
```

Expected: no output.

- [ ] **Step 2: Vercel files**

`vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": { "api/index.js": { "includeFiles": "server/**", "maxDuration": 15 } },
  "rewrites": [
    { "source": "/api/:path*", "destination": "/api?path=:path*" }
  ],
  "headers": [
    { "source": "/(.*)", "headers": [
      { "key": "X-Content-Type-Options", "value": "nosniff" },
      { "key": "Referrer-Policy", "value": "same-origin" },
      { "key": "Cache-Control", "value": "no-store" }
    ] }
  ]
}
```

`.vercelignore`:

```
data
docs
brag-output*
.claude
*.mp4
*.jpg
```

- [ ] **Step 3: CI**

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push:
    branches: [main, connected-pilot]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
```

- [ ] **Step 4: Docker**

`Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY api ./api
COPY client ./client
COPY index.html ./
RUN mkdir -p /data
ENV NODE_ENV=production PORT=3000 PGLITE_DIR=/data/pglite
EXPOSE 3000
CMD ["node", "server/index.js"]
```

`.dockerignore`:

```
node_modules
data
docs
brag-output*
.claude
.git
*.mp4
```

`.gitignore`: keep as is (already ignores `data/`, `.env`, `brag-output*/`).

- [ ] **Step 5: Documentation**

`README.md` (replace):

```markdown
# IAE Salidas

Plataforma de **salidas tempranas, excusas, autorizados, garita y bus escolar** para una escuela. Los padres piden por WhatsApp (simulado) o por la app; la escuela aprueba; la garita verifica identidad y marca el retiro; los dos titulares reciben el aviso.

Código: <https://github.com/isbpty/iae-salidas> · Diseño: [docs/superpowers/specs/2026-09-18-iae-salidas-relational-backend-design.md](docs/superpowers/specs/2026-09-18-iae-salidas-relational-backend-design.md)

## Correr en local

```bash
npm install
cp .env.example .env   # pon un SESSION_SECRET de 32+ caracteres y el PIN
npm run dev            # http://localhost:3000 · base de datos PGlite en data/pglite
npm test               # pruebas (node --test) sobre PGlite en memoria
npm run reset          # borra la base local; al arrancar se vuelve a sembrar
```

Sin `DATABASE_URL` el servidor usa PGlite (Postgres embebido). Con `DATABASE_URL` (Neon u otro Postgres) usa `pg`.

## Usuarios del demo (PIN único: el de `PILOT_PIN`)

| Usuario | Rol | Qué ve |
|---|---|---|
| Carlos Rodríguez / Ana Pérez | Padres de Joseph (3°) y Sofía (Kínder) | App de padres y WhatsApp |
| Laura Gómez / Pedro Castillo | Padres de Mateo (3°) | Laura además es autorizada "una vez" para Joseph |
| Wei Chen | Padre de Emily (9°) | |
| Lic. Rosa Martínez | Administración | Todo, permisos, configuración, reinicio, vista dividida |
| Yadira Batista | Recepción | Aprueba salidas y excusas, autorizados, bitácora |
| Prof. Diana Ríos / Jorge Ávila / Mónica Salas | Docentes | Solo sus grados |
| Manuel Ortega | Garita | Salidas aprobadas de hoy, escaneo de código, foto del autorizado |
| Kenia Pérez / Lisbeth Moreno | Monitoras | Solo su ruta: abordó / bajó / no abordó, iniciar y finalizar viaje |

Cada dispositivo entra con su usuario; los cambios llegan a los demás en segundos.

## Reglas implementadas

- Un estudiante tiene hasta 2 titulares; una familia puede tener varios hijos.
- Autorizados `siempre`, `por tiempo` o `una vez (con confirmación)`; foto o cédula obligatoria para personas nuevas; la garita la ve al escanear el código.
- Auto-aprobación: titular + anticipación mínima + persona que retira titular o autorizada siempre/por tiempo + sin rechazos en 30 días. Lo demás pasa a Recepción.
- Una vez: la garita pide confirmación por WhatsApp a los titulares; sin confirmación no se entrega.
- Aviso proactivo con "Es correcto / NO" cuando retira una persona nueva, por tiempo o de una vez; con NO se cancela y se avisa a garita.
- Excusas (ausencia/tardanza) con adjunto opcional, aceptadas por Recepción, visibles para el docente.
- Bus: rutas, paradas, viajes del día, GPS simulado, "¿dónde está mi hijo?" según el estado real y "hoy no va en bus".
- Bitácora de todo y matriz de permisos editable.

## Qué es real y qué es simulado

Todo corre en el servidor sobre PostgreSQL con permisos por rol. **WhatsApp es un simulador**: el chat del navegador envía los mensajes al mismo bot que atendería un número real; el transporte real se conecta detrás de `server/transports/whatsapp.js`. El GPS es `server/transports/gps.js`, simulado con la forma de una API real.

## Despliegue

Ver [VERCEL-DEPLOY.md](VERCEL-DEPLOY.md). También hay un `Dockerfile` para correrlo en cualquier host.
```

`ARCHITECTURE.md` (replace):

```markdown
# Arquitectura

El diseño completo está en `docs/superpowers/specs/2026-09-18-iae-salidas-relational-backend-design.md`. Resumen:

- **Un servicio Node (ESM, sin framework)**: `server/app.js` enruta; `server/commands/*` ejecuta cada acción en una transacción con validación de rol y alcance; `server/domain/*` y `server/bot/*` contienen las reglas puras; `server/projections/*` arma lo que cada rol puede ver.
- **PostgreSQL**: `server/db/schema.js` (migraciones embebidas), `server/db/repo.js` (SQL), `server/db/seed.js` (datos del demo). Neon en producción; PGlite en local y pruebas.
- **Cliente**: `index.html` + `client/*.js`. Solo pinta la proyección y envía comandos; sin lógica de negocio.
- **Tiempo real**: SSE en local; en Vercel sondeo cada 3 s con `If-None-Match` (304 si nada cambió).
- **Seguridad**: cookie HMAC, PIN con límite de intentos, secretos obligatorios, estáticos restringidos a `index.html` y `client/`, adjuntos servidos solo a quien puede verlos.
- **Adaptadores**: `server/transports/whatsapp.js` (simulador; interfaz `send`) y `server/transports/gps.js` (simulado; interfaz `position`).

Flujo de una acción: navegador → `POST /api/commands/<nombre>` → `runCommand` → handler (dominio + repositorio + notificaciones + bitácora) → `COMMIT` → revisión +1 → respuesta con la proyección fresca → los demás clientes reciben `changed` (SSE) o ven cambiar el ETag.
```

`VERCEL-DEPLOY.md` (replace):

```markdown
# Desplegar en Vercel con Neon

1. **Neon**: crea un proyecto y una base `iae_salidas`. Copia la cadena de conexión con `?sslmode=require`.
2. **Vercel**: importa el repo `isbpty/iae-salidas` (rama `connected-pilot` o `main`). Framework: *Other*. Sin comando de build.
3. **Variables de entorno** (Production y Preview):
   - `DATABASE_URL` = cadena de Neon
   - `SESSION_SECRET` = 32+ caracteres aleatorios (`openssl rand -hex 32`)
   - `PILOT_PIN` = el PIN compartido del demo
4. Deploy. La primera petición crea las tablas y siembra los datos.
5. Prueba: `https://<proyecto>.vercel.app/api/health` → `{"ok":true,"db":"pg",...}` y abre la raíz para entrar.

Notas
- `api/index.js` es la única función; `server/**` se incluye vía `vercel.json`. `index.html` y `client/` se sirven como estáticos.
- Los clientes en `*.vercel.app` sondean cada 3 s (no hay SSE en serverless).
- Para reiniciar los datos entra como Administración y pulsa "↺ Reiniciar".
- Si cambias el PIN o el secreto, las sesiones abiertas expiran al recargar.
```

- [ ] **Step 6: Full verification**

```bash
npm test
```

Expected: all green. Then start `npm run dev`, log in as Carlos and as Rosa in two tabs, and repeat steps 3–6 of Task 13's browser check to confirm nothing regressed after the deletions (the root `app.js`/`views.js` are gone; only `client/` is loaded).

Verify the Vercel handler locally by importing it once:

```bash
node -e "import('./api/index.js').then(m => console.log(typeof m.default))"
```

Expected: `function`.

- [ ] **Step 7: Commit and push**

```bash
git add -A
git commit -m "Deployment files, CI, docs; remove the browser-only prototype and JSON bridge" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin connected-pilot
```

Expected: the `ci` workflow runs on GitHub and passes.

---

## Self-review notes (plan author)

- Spec coverage: §2 architecture → Tasks 1–4; §3 data model → Task 2 (schema) and 3 (repo/seed); §4 commands → Tasks 6–10, 12; §5 projections → Task 11; §6 bot → Task 10; §7 bus/GPS → Task 9; §8 auth/security/realtime → Task 4 (+ attachments in 7); §9 seed/reset → Tasks 3 and 12; §10 client → Task 13; §11 tests/CI → every task + Task 14; §12 deployment → Task 14; §13 cleanup → Tasks 4 (server side) and 14 (root files).
- The spec's `upload_attachment` "multipart" option is implemented as JSON base64 only (the client already reduces images to 640 px, well under 512 KB).
- Names used across tasks: `makeTestApp/run/view/listen/clock`, `call/loginAs` (test-helpers, Task 4), `register` (commands/index.js), `requireCap/requireTitular/requireRouteAccess/STAFF_ROLES` (guards), `VIEW_BUILDERS` (projections/index.js), `SimulatorTransport.send(ctx, key, {text, buttons, location, typing})`, `SimulatedGps.position(route, ctx)`, `HttpError(status, code, detail)`.
