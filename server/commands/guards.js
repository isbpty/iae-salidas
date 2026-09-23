import { deny, notFound } from '../domain/errors.js';
import { STAFF_ROLES } from '../domain/constants.js';

export { STAFF_ROLES };
/* Non-throwing twin of `requireCap`, for code that filters instead of refusing (the staff view, the
   `search_requests` scope). */
export const can = (ctx, cap) => ctx.user.role === 'admin' || !!(ctx.permissions[ctx.user.role] || {})[cap];
export function requireCap(ctx, cap) {
  if (ctx.user.role === 'admin') return;
  if (!ctx.permissions[ctx.user.role] || !ctx.permissions[ctx.user.role][cap]) deny('forbidden_capability:' + cap);
}
export async function requireTitular(ctx, studentId) {
  const st = await ctx.getStudent(studentId);
  if (!st) notFound('student_not_found');
  if (!ctx.person || !st.titulares.includes(ctx.person.id)) deny('forbidden_not_titular');
  return st;
}
export function requireRouteAccess(ctx, routeId) {
  if (ctx.user.role === 'admin') return;
  if (!ctx.staff || ctx.staff.routeId !== routeId) deny('forbidden_route');
}
