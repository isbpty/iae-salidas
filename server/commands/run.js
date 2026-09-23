import './all.js';
import { HttpError } from '../domain/errors.js';
import { makeCtx } from '../domain/context.js';
import { insertAudit, bumpRevision, getRevision } from '../db/repo.js';
import { spendAttempt } from '../auth.js';
import { maskInput } from '../activity.js';
import { COMMANDS } from './index.js';

/* S10: `add_authorization` (modo 'nueva') y otros comandos guardan cédula/teléfono de personas nuevas en
   `input`; `maskInput` (server/activity.js) ya enmascara esas claves y trunca los strings largos -- la misma
   regla que la telemetría, en vez de un `sanitize` propio que solo truncaba. */
/* R7: no vale la pena una fila de auditoría por cada "marcar leído" (el comando más frecuente de todos,
   ver L10) -- no cambia nada que un administrador necesite reconstruir después. */
const NO_AUDIT = new Set(['mark_notifications_read']);

export async function runCommand(deps, { userId, name, input = {}, channel = 'web' }) {
  const cmd = COMMANDS[name];
  if (!cmd) throw new HttpError(404, 'unknown_command');
  /* Commands that look people up count every use per user, outside the transaction so a miss (404, rolled back)
     still counts. */
  if (cmd.limit && (!cmd.limit.when || cmd.limit.when(input || {}))) {
    const now = typeof deps.now === 'function' ? deps.now() : deps.now;
    if (!(await spendAttempt(deps.db, cmd.limit.key + ':' + userId, now, cmd.limit.max))) throw new HttpError(429, 'too_many_attempts');
  }
  return deps.db.tx(async (q) => {
    const ctx = await makeCtx(q, deps, userId, { command: name, channel });
    if (!cmd.roles.includes(ctx.user.role)) throw new HttpError(403, 'forbidden_role');
    const result = await cmd.handler(ctx, input || {});
    if (!NO_AUDIT.has(name)) {
      await insertAudit(q, { at: ctx.now, actorUserId: ctx.user.id, actorRole: ctx.user.role, actorName: ctx.user.name, command: name, channel, input: maskInput(cmd.auditInput ? cmd.auditInput(input || {}) : input) });
    }
    /* Read-only commands (bump: false) do not invalidate every open screen: the caller already gets
       their fresh view back in the response (app.js), and nothing changed for anyone else. */
    const revision = cmd.bump === false ? await getRevision(q) : await bumpRevision(q);
    return { result, revision };
  });
}
