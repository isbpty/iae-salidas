/* C7 (calidad #7): the capability list used to be copy-pasted verbatim in two places
   (`ALL_CAPS` in server/projections/index.js, `CAPS` in server/commands/admin.js) and roles/statuses
   were literals scattered across guards, commands and tests. One source of truth here, imported
   wherever a piece of code needs the enum itself (not its Spanish label -- those stay in
   server/domain/text.js, e.g. `STATUS`/`ROLE_NAMES`/`AUTH_TYPES`, which is a client-facing wording
   concern, not a validation one). Keep this file in sync with the matching `CHECK`s in
   server/db/schema.js (`staff.role`, `users.role`, `requests.status`, `authorizations.type`) --
   nothing generates one from the other. */

/* Every capability a role can be granted (role_permissions.capability, and `admin`'s implicit "all"). */
export const CAPABILITIES = ['ver_solicitudes', 'aprobar', 'ver_excusas', 'decidir_excusas', 'marcar_salida', 'ver_estudiantes', 'gestionar_autorizados', 'ver_rutas', 'marcar_bus', 'personal', 'config', 'bitacora', 'todos_niveles'];

/* Every staff role (staff.role / users.role minus 'parent'), admin included. */
export const STAFF_ROLES = ['admin', 'recepcion', 'profesor', 'garita', 'monitora'];

/* Staff roles that can be granted per-capability permissions -- admin's are fixed (always all of
   CAPABILITIES) and not stored in role_permissions, so it's excluded here. */
export const ROLES = ['recepcion', 'profesor', 'garita', 'monitora'];

/* users.role -- every STAFF_ROLES entry plus the one parent-facing role. */
export const USER_ROLES = ['parent', ...STAFF_ROLES];

/* requests.status */
export const REQUEST_STATUSES = ['pendiente', 'aprobada', 'rechazada', 'retirado', 'cancelada', 'aceptada'];

/* requests.kind */
export const REQUEST_KINDS = ['salida', 'excusa'];

/* authorizations.type */
export const AUTH_TYPES = ['siempre', 'temporal', 'una_vez'];
