import './all.js';
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
