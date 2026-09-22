import { HttpError } from './errors.js';
import { getUser, getPerson, getStaff, getSettings, getPermissions } from '../db/repo.js';

export async function makeCtx(q, deps, userId, extra = {}) {
  const user = await getUser(q, userId);
  if (!user || !user.active) throw new HttpError(401, 'authentication_required');
  const settings = await getSettings(q);
  const permissions = await getPermissions(q);
  return {
    q, user, settings, permissions,
    now: typeof deps.now === 'function' ? deps.now() : deps.now, tz: settings.timezone || 'America/Panama',
    transport: deps.transport, gps: deps.gps,
    /* Server settings a command may need (the PIN pepper, demo mode). Never sent to a client. */
    config: deps.config || {},
    person: user.kind === 'person' ? await getPerson(q, user.refId) : null,
    staff: user.kind === 'staff' ? await getStaff(q, user.refId) : null,
    ...extra,
  };
}
