import { makeCtx } from '../domain/context.js';
import { todayISO } from '../domain/time.js';
import { listLevels } from '../db/repo.js';
import { CAPABILITIES } from '../domain/constants.js';

export const VIEW_BUILDERS = {};

export async function buildView(q, userId, env) {
  const ctx = await makeCtx(q, env, userId);
  const { user } = ctx;
  const capabilities = user.role === 'admin' ? Object.fromEntries(CAPABILITIES.map((c) => [c, true])) : (ctx.permissions[user.role] || {});
  const base = {
    user: { id: user.id, name: user.name, role: user.role, kind: user.kind, refId: user.refId },
    serverNow: ctx.now.getTime(),
    today: todayISO(ctx.now, ctx.tz),
    settings: ctx.settings,
    capabilities,
    /* Serverless has no long-lived connection to hold an EventSource open, so the client polls. */
    realtime: env.serverless ? 'poll' : 'sse',
    levels: await listLevels(q),
  };
  const builder = VIEW_BUILDERS[user.role];
  return builder ? { ...base, ...(await builder(ctx)) } : base;
}

import { parentView } from './parent.js';
import { staffView } from './staff.js';
VIEW_BUILDERS.parent = parentView;
for (const role of ['admin', 'recepcion', 'profesor', 'garita', 'monitora']) VIEW_BUILDERS[role] = staffView;
