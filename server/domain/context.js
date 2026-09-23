import { HttpError } from './errors.js';
import { getUser, getPerson, getStudent, getStaff, getSettings, getPermissions, listStaff } from '../db/repo.js';

/* A tiny memoized loader: `fn(id)` runs at most once per id per command/transaction, and every
   later call for the same id returns the same promise instead of re-querying. Safe because nothing
   in a command's own transaction ever races with itself, and none of `create_salida`'s repeated
   `getStudent('e1')`/`getPerson('p1')` calls expect to see a write another *earlier statement in the
   same transaction* just made to that same row (they don't -- domain code always re-reads via
   `getRequest` after a `patchRow`, never through these caches). */
function memoLoader(fn, seed) {
  const cache = new Map(seed);
  return (id) => {
    if (!cache.has(id)) cache.set(id, fn(id));
    return cache.get(id);
  };
}

export async function makeCtx(q, deps, userId, extra = {}) {
  const user = await getUser(q, userId);
  if (!user || !user.active) throw new HttpError(401, 'authentication_required');
  const settings = await getSettings(q);
  const permissions = await getPermissions(q);
  /* The caller's own person/staff row is fetched once, right here, regardless -- seeding the
     caches below with it means the command's first `ctx.getPerson(ctx.person.id)` (create_salida:
     the requester is almost always also the pickup person) is a cache hit instead of a second,
     redundant `SELECT`. */
  const person = user.kind === 'person' ? await getPerson(q, user.refId) : null;
  const staff = user.kind === 'staff' ? await getStaff(q, user.refId) : null;
  const ctx = {
    q, user, settings, permissions,
    now: typeof deps.now === 'function' ? deps.now() : deps.now, tz: settings.timezone || 'America/Panama',
    transport: deps.transport, gps: deps.gps,
    /* Server settings a command may need (the PIN pepper, demo mode). Never sent to a client. */
    config: deps.config || {},
    person, staff,
    ...extra,
  };
  /* `notifyTeachers` used to re-run `listStaff` (the full roster) for every notice it sent -- a
     `create_salida` that reaches several teachers/notices paid for that table scan once per notice
     (R2). One lazy, memoized load per command/transaction is enough: nothing in a command's own
     transaction can change `staff` out from under it. */
  let staffCache = null;
  ctx.staffList = async () => staffCache || (staffCache = await listStaff(q));
  /* `create_salida` reads the same student (~8 times: guard, creation, eligibility x2,
     auto-approval, notifyTeachers x2...) and the same handful of persons (requester, pickup person,
     titulares) over and over within one command (R2). `students` and `persons` are never written by
     any *other* command mid-transaction -- guardianships/students only change via seed/seed-load,
     and the one command that does patch a person's row (`addAuthorization`, doc attachment fields)
     deliberately does not use this cache (see its own direct `getPerson` calls) -- so memoizing both
     for the life of the transaction is safe. */
  ctx.getStudent = memoLoader((id) => getStudent(q, id));
  ctx.getPerson = memoLoader((id) => getPerson(q, id), person ? [[person.id, Promise.resolve(person)]] : []);
  return ctx;
}
