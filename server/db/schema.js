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
];
