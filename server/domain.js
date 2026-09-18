import { randomInt, randomUUID } from 'node:crypto';
const can = (actor, roles) => actor && roles.includes(actor.role);
const studentFor = (state, id) => state.students.find(x => x.id === id);
const requestFor = (state, id) => state.requests.find(x => x.id === id);

export function audit(state, actor, action, entity, detail = {}) {
  const event = { id: randomUUID(), at: new Date().toISOString(), actorId: actor?.id || 'system', actorRole: actor?.role || 'system', action, entity, detail };
  state.audit.unshift(event); return event;
}
export function notifyGuardians(state, student, text) {
  for (const userId of student.guardianIds) state.notifications.unshift({ id: randomUUID(), at: new Date().toISOString(), userId, text, read: false });
}
export function createRequest(state, actor, input, source = 'web') {
  if (!can(actor, ['parent'])) throw Object.assign(new Error('forbidden'), { status: 403 });
  const student = studentFor(state, input.studentId);
  if (!student || !actor.studentIds.includes(student.id)) throw Object.assign(new Error('student_not_linked'), { status: 403 });
  if (!['dismissal', 'excuse'].includes(input.kind)) throw Object.assign(new Error('invalid_kind'), { status: 400 });
  const req = { id: randomUUID(), kind: input.kind, studentId: student.id, requestedBy: actor.id, source, status: 'pending', createdAt: new Date().toISOString(), reason: input.reason || '' };
  if (input.kind === 'dismissal') Object.assign(req, { date: input.date, time: input.time, pickupName: input.pickupName || actor.name, pickupCedula: input.pickupCedula || '', pickupPoint: null, code: null });
  else Object.assign(req, { date: input.date, excuseType: input.excuseType || 'absence', attachmentKey: input.attachmentKey || null });
  state.requests.unshift(req); audit(state, actor, 'request.created', `request:${req.id}`, { kind: req.kind, source });
  notifyGuardians(state, student, `${actor.name} registró ${req.kind === 'dismissal' ? 'una salida' : 'una excusa'} para ${student.name}.`);
  return req;
}
export function decideRequest(state, actor, id, input) {
  if (!can(actor, ['reception', 'admin'])) throw Object.assign(new Error('forbidden'), { status: 403 });
  const req = requestFor(state, id); if (!req) throw Object.assign(new Error('not_found'), { status: 404 });
  if (req.status !== 'pending') throw Object.assign(new Error('already_decided'), { status: 409 });
  if (!['approved', 'rejected'].includes(input.decision)) throw Object.assign(new Error('invalid_decision'), { status: 400 });
  req.status = input.decision; req.decidedAt = new Date().toISOString(); req.decidedBy = actor.id;
  if (req.kind === 'dismissal' && input.decision === 'approved') { req.pickupPoint = input.pickupPoint || state.school.pickupPoints[0]; req.code = String(randomInt(1000, 10000)); }
  if (input.decision === 'rejected') req.rejectReason = input.reason || 'No especificado';
  const student = studentFor(state, req.studentId); audit(state, actor, `request.${input.decision}`, `request:${req.id}`);
  notifyGuardians(state, student, input.decision === 'approved' ? `${student.name}: solicitud aprobada${req.code ? `, código ${req.code}` : ''}.` : `${student.name}: solicitud rechazada. ${req.rejectReason}`);
  return req;
}
export function checkout(state, actor, id, code) {
  if (!can(actor, ['gate', 'admin'])) throw Object.assign(new Error('forbidden'), { status: 403 });
  const req = requestFor(state, id); if (!req) throw Object.assign(new Error('not_found'), { status: 404 });
  if (req.kind !== 'dismissal' || req.status !== 'approved') throw Object.assign(new Error('not_approved'), { status: 409 });
  if (String(code) !== req.code) throw Object.assign(new Error('invalid_code'), { status: 403 });
  req.status = 'picked_up'; req.pickedUpAt = new Date().toISOString(); req.pickedUpByStaff = actor.id;
  const student = studentFor(state, req.studentId); audit(state, actor, 'dismissal.picked_up', `request:${req.id}`, { pickupName: req.pickupName });
  notifyGuardians(state, student, `${student.name} fue retirado por ${req.pickupName} en ${req.pickupPoint}.`); return req;
}
