# Probadores con PIN, registro de actividad y panel Actividad — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 10 probadores con PIN propio, registro técnico de toda la actividad (servidor y cliente) y un panel "Actividad" solo para el super admin.

**Architecture:** Nueva tabla `testers` (PIN hasheado con scrypt) y `activity_events` (append-only). La cookie de sesión lleva `testerId/super/sid`. Un envoltorio en `app.js` registra cada petición; un módulo cliente `telemetry.js` envía lotes de eventos de pantalla/clic/error a `POST /api/telemetry`. Rutas `GET /api/activity/*` (solo `super`) alimentan `public/client/activity.js`.

**Tech Stack:** Node ≥20 ESM, `pg`/PGlite, `node:test`, cliente vanilla (scripts clásicos).

**Spec:** `docs/superpowers/specs/2026-09-20-probadores-y-actividad-design.md`

## Global Constraints

- Sin frameworks ni dependencias nuevas. Sin lógica de negocio en el cliente.
- Los PINs nunca se guardan ni se registran en claro (ni en `activity_events.data`).
- El registro de actividad nunca puede hacer fallar una petición (try/catch propio).
- `reset_demo` y `seed_load` conservan `testers` y vacían `activity_events`.
- `npm test` verde al final de cada tarea.

---

### Task 1: Esquema, hash de PIN y repositorio de probadores/actividad

**Files:** Modify `server/db/schema.js` (migración `003_testers_activity`), Create `server/testers.js`, Modify `server/db/repo.js`, Modify `server/db/seed.js` (`activity_events` en MOVEMENT_TABLES; `testers` NO), Test `server/testers.test.js`.

**Interfaces (produce):**
- `hashPin(pin) → 'scrypt$salt$hash'`, `verifyPin(pin, stored) → boolean`, `randomPin() → '######'` (`server/testers.js`).
- `createTesters(q, now) → [{ id, name, pin }]` (10, `t1` super "Super admin", `t2..t10` "Probador n"), `regenerateTesterPin(q, id) → { id, name, pin }`, `findTesterByPin(q, pin) → tester|null`, `listTesters(q)`, `getTester(q, id)`, `renameTester(q, id, name)`.
- `insertActivity(q, row)`, `purgeActivity(q, before)`.

```sql
CREATE TABLE IF NOT EXISTS testers (id text PRIMARY KEY, name text NOT NULL, pin_hash text NOT NULL, super boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS activity_events (id bigserial PRIMARY KEY, at timestamptz NOT NULL, tester_id text, user_id text, role text, sid text, source text NOT NULL, kind text NOT NULL, name text, screen text, target text, duration_ms integer, ok boolean, error text, status integer, revision integer, ip text, ua text, data jsonb);
CREATE INDEX IF NOT EXISTS activity_tester_at ON activity_events(tester_id, at);
CREATE INDEX IF NOT EXISTS activity_sid_at ON activity_events(sid, at);
CREATE INDEX IF NOT EXISTS activity_kind_name_at ON activity_events(kind, name, at);
```

- [ ] Test: hash distinto por sal, verify true/false, `createTesters` devuelve 10 PINs de 6 dígitos y `findTesterByPin` los resuelve; `resetAll` conserva testers y vacía activity.
- [ ] Implementar. `npm test`. Commit.

### Task 2: Sesión con probador, login en dos pasos, switch, comandos de probadores

**Files:** Modify `server/session.js` (payload arbitrario, `pinToken(testerId)`/`verifyPinToken`), `server/config.js` (`sharedPin: env.PILOT_PIN_SHARED !== 'false'`), `server/app.js` (rutas `auth/pin`, `auth/login` dos formas, `auth/switch`; `sessionUser` devuelve `{ user, session }`; vista decorada con `user.super` y `tester`), `server/commands/run.js` + `server/domain/context.js` (`ctx.super`), `server/commands/admin.js` (`create_testers`, `regenerate_tester_pin`, `rename_tester`, `purge_activity`), `server/test-helpers.js` (`run` acepta `{ super }`, `loginAs` con pin de probador). Test `server/auth.test.js` (nuevo o ampliar el existente de router).

**Interfaces:** cookie `{ userId, testerId: string|null, super: boolean, sid, exp }`; `runCommand(deps, { userId, name, input, channel, super })`.

- [ ] Tests: dos pasos → cookie con testerId; `pinToken` caducado/alterado → 401; un paso con PIN de probador y con compartido; `switch` conserva sid; `create_testers` con compartido solo la primera vez; `regenerate_tester_pin` sin super → 403; `PILOT_PIN_SHARED=false` rechaza 4321.
- [ ] Implementar. `npm test`. Commit.

### Task 3: Registro de servidor y endpoint de telemetría

**Files:** Create `server/activity.js` (`maskInput(input)`, `recordServerEvent(db, ev)`, `ingestClientEvents(db, session, user, meta, events)`), Modify `server/app.js` (envoltorio de tiempo en `handler`; `POST /api/telemetry`), Test `server/activity.test.js`.

- [ ] Tests: login/command/view/view_304/attachment registrados con `duration_ms` y `status`; comando con error de dominio → `ok=false`, `error='forbidden_role'`; `data` enmascarado (`pin`, `cedula`, `dataBase64`); telemetry sin sesión 401; ignora `testerId/userId` del cuerpo; corta a 100; `telemetry` y `activity/*` no generan eventos de servidor.
- [ ] Implementar. `npm test`. Commit.

### Task 4: Consultas de resumen/eventos/export y rutas `activity/*`

**Files:** Modify `server/activity.js` (`summary(q, f)`, `events(q, f)`, `exportCsv(q, f)`), Modify `server/app.js` (rutas, 403 sin super), Test `server/activity.test.js`.

Sesiones (SQL): `lag(at) OVER (PARTITION BY sid ORDER BY at)`; corte cuando la diferencia > 10 min; segmentos con `sum(brk) OVER (...)`; `min/max(at)` por `(tester_id, sid, seg)`.

- [ ] Tests: dos sesiones separadas por 15 min cuentan 2; `activeMs` = suma; pantallas suman `duration_ms` de `screen_leave`; acciones p50/p95; errores agrupados; 403 sin super; CSV con cabecera y filas.
- [ ] Implementar. `npm test`. Commit.

### Task 5: Cliente: login en dos pasos, telemetría y pestaña Actividad

**Files:** Modify `public/client/api.js` (`pin`, `login(userId, pinToken)`, `switchUser`, `telemetry`, `activity*`), `public/client/state.js` (login en dos pasos, botón "Cambiar usuario", hooks de telemetría en `render`/`onSubmit`), Create `public/client/telemetry.js`, Create `public/client/activity.js`, Modify `public/client/views.js` (pestaña `actividad` si `V.user.super`; hook de pantalla en `render`), `public/client/styles.css`, `public/index.html` (orden de scripts: format, api, telemetry, state, model, qr, activity, views).

- [ ] Implementar, verificar en el navegador (login, cambio de usuario, panel con datos reales, exportar CSV, regenerar PIN). Commit.

### Task 6: Prueba de carga y despliegue

- [ ] `server/tools/load-test.js` acepta `--pin` de probador (sin cambios de código si el login de un paso sigue). Push, ejecutar `create_testers` en producción y entregar PINs.
