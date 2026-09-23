import './all.js';
import { HttpError } from '../domain/errors.js';
import { makeCtx } from '../domain/context.js';
import { insertAudit, bumpRevision, getRevision } from '../db/repo.js';
import { spendAttempt } from '../auth.js';
import { COMMANDS } from './index.js';

const sanitize = (input) => {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) out[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
  return out;
};

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
    await insertAudit(q, { at: ctx.now, actorUserId: ctx.user.id, actorRole: ctx.user.role, actorName: ctx.user.name, command: name, channel, input: sanitize(cmd.auditInput ? cmd.auditInput(input || {}) : input) });
    /* Read-only commands (bump: false) do not invalidate every open screen: the caller already gets
       their fresh view back in the response (app.js), and nothing changed for anyone else. */
    const revision = cmd.bump === false ? await getRevision(q) : await bumpRevision(q);
    return { result, revision };
  });
}
