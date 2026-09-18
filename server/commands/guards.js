import { deny, notFound } from '../domain/errors.js';
import { getStudent } from '../db/repo.js';

export const STAFF_ROLES = ['admin', 'recepcion', 'profesor', 'garita', 'monitora'];
export function requireCap(ctx, cap) {
  if (ctx.user.role === 'admin') return;
  if (!ctx.permissions[ctx.user.role] || !ctx.permissions[ctx.user.role][cap]) deny('forbidden_capability:' + cap);
}
export async function requireTitular(ctx, studentId) {
  const st = await getStudent(ctx.q, studentId);
  if (!st) notFound('student_not_found');
  if (!ctx.person || !st.titulares.includes(ctx.person.id)) deny('forbidden_not_titular');
  return st;
}
export function requireRouteAccess(ctx, routeId) {
  if (ctx.user.role === 'admin') return;
  if (!ctx.staff || ctx.staff.routeId !== routeId) deny('forbidden_route');
}
