# Storage migration

The pilot selects PostgreSQL when `DATABASE_URL` is set and keeps the atomic JSON store as the local fallback.

1. Deploy with `WHATSAPP_TRANSPORT=simulator` and a new managed PostgreSQL database.
2. The service creates `app_state` and `schema_migrations` in one transaction and seeds an empty database.
3. Validate login, simulator, reception, gate, audit, restart persistence, and concurrent revision handling.
4. Export the last JSON pilot state before cutover. Import it only into an empty PostgreSQL state using `migrateJsonIntoPostgres`; the import records an audit event and refuses to overwrite a non-empty database.
5. Keep the JSON export until the pilot acceptance window closes.
6. Enable `qr-web` only after the persistent `/data` volume is mounted and the approved test number is ready to scan.

`app_state` is an intentional compatibility stage. The next database migration should normalize students, guardians, requests, notifications, authorizations, and audit events into relational tables while preserving the command API.
