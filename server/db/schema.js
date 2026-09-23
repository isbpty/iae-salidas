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
  {
    version: '002_notifications_seq',
    sql: `
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS seq bigserial;
`,
  },
  {
    version: '003_testers_activity',
    sql: `
CREATE TABLE IF NOT EXISTS testers (id text PRIMARY KEY, name text NOT NULL, pin_hash text NOT NULL, super boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS activity_events (
  id bigserial PRIMARY KEY, at timestamptz NOT NULL, tester_id text, user_id text, role text, sid text, source text NOT NULL, kind text NOT NULL,
  name text, screen text, target text, duration_ms integer, ok boolean, error text, status integer, revision integer, ip text, ua text, data jsonb);
CREATE INDEX IF NOT EXISTS activity_tester_at ON activity_events(tester_id, at);
CREATE INDEX IF NOT EXISTS activity_sid_at ON activity_events(sid, at);
CREATE INDEX IF NOT EXISTS activity_kind_name_at ON activity_events(kind, name, at);
`,
  },
  {
    version: '004_requests_code_unique',
    sql: `
CREATE UNIQUE INDEX IF NOT EXISTS requests_date_code ON requests(date, code) WHERE kind='salida' AND code IS NOT NULL;
`,
  },
  {
    /* Pending proactive alerts (`alert_pickup`) waiting behind whatever the chat is currently doing
       (a draft in progress, or an urgent `confirm_pickup`): a list of { requestId }, never overwriting
       `step`/`draft`. See queueAlert/advanceAlert/releasePickupState in domain/requests.js. */
    version: '005_conversation_alerts',
    sql: `
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS alerts jsonb NOT NULL DEFAULT '[]';
`,
  },
  {
    /* Per-tester access (review S1/S4/S5): which demo users a tester may open (NULL = all), the instant
       before which their session tokens no longer count (logout, new PIN), and HMAC-SHA256(SESSION_SECRET, pin)
       so a PIN is found with one indexed read. Testers created earlier keep pin_lookup NULL until their
       first successful login fills it in (see findTesterByPin). */
    version: '006_testers_access',
    sql: `
ALTER TABLE testers ADD COLUMN IF NOT EXISTS allowed_users jsonb;
ALTER TABLE testers ADD COLUMN IF NOT EXISTS sessions_valid_after timestamptz;
ALTER TABLE testers ADD COLUMN IF NOT EXISTS pin_lookup text;
CREATE UNIQUE INDEX IF NOT EXISTS testers_pin_lookup ON testers(pin_lookup);
`,
  },
  {
    /* Devices (the installed /super page) that get a push notice when a tester logs in. `keys` is the
       browser's { p256dh, auth }; a 404/410 from the push service deletes the row (see server/push.js). */
    version: '009_push_subscriptions',
    sql: `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id bigserial PRIMARY KEY, tester_id text NOT NULL, endpoint text NOT NULL UNIQUE, keys jsonb NOT NULL, ua text,
  created_at timestamptz NOT NULL, last_ok_at timestamptz, failures integer NOT NULL DEFAULT 0);
`,
  },
  {
    /* Task 15: IP, geolocalización aproximada (por cabeceras de Vercel) y huella del dispositivo por sesión.
       `fp` es el hash corto que el cliente calcula de su huella (pantalla, plataforma, zona horaria…) y
       manda solo en el evento `session_start`; sirve para agrupar "Dispositivos" por probador en /super sin
       guardar nada que identifique a la persona por sí solo. La IP y la geolocalización ya vivían en las
       columnas `ip`/`data` de `activity_events` (sin columna propia): esta migración solo añade `fp`. */
    version: '010_activity_fingerprint',
    sql: `
ALTER TABLE activity_events ADD COLUMN IF NOT EXISTS fp text;
CREATE INDEX IF NOT EXISTS activity_tester_fp ON activity_events(tester_id, fp);
`,
  },
  {
    /* Task 8 (L10): role notices ("todo el rol") were read for everyone the instant one member of
       the role opened the app, because `mark_notifications_read` set the shared `notifications.read_at`
       column. This table tracks who (which `users.id`) has read which role notice, so two recepcionistas
       reading independently don't silence each other's unread badge/toasts. Personal notices
       (`person_id`/`staff_id` target) keep using `notifications.read_at` -- only one user can ever see
       those anyway. */
    version: '011_notification_reads',
    sql: `
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id text NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  read_at timestamptz NOT NULL,
  PRIMARY KEY (notification_id, user_id));
`,
  },
];
