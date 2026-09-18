import { createRequest } from './domain.js';
function tomorrow() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); }
export function simulateInbound(state, actor, text) {
  const normalized = text.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const student = state.students.find(s => actor.studentIds.includes(s.id) && normalized.includes(s.name.split(' ')[0].toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '')));
  if (!student) throw Object.assign(new Error('student_not_found_in_message'), { status: 400 });
  state.inboundMessages.unshift({ at: new Date().toISOString(), transport: 'simulator', actorId: actor.id, text });
  if (/no ira|ausen|excusa|cita medica/.test(normalized)) {
    const req = createRequest(state, actor, { kind: 'excuse', studentId: student.id, date: tomorrow(), excuseType: 'absence', reason: text }, 'simulator');
    return { reply: `Recibimos la excusa de ${student.name}. La escuela la revisará.`, request: req };
  }
  if (/retirar|salida|retira/.test(normalized)) {
    const time = (text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/) || []).slice(1).join(':') || '16:45';
    const req = createRequest(state, actor, { kind: 'dismissal', studentId: student.id, date: new Date().toISOString().slice(0,10), time, pickupName: /abuela/.test(normalized) ? 'María Pérez' : actor.name, pickupCedula: /abuela/.test(normalized) ? '8-200-111' : '' }, 'simulator');
    return { reply: `Recibimos la salida de ${student.name} para las ${time}. La escuela la revisará.`, request: req };
  }
  return { reply: 'Puedo registrar una salida o una excusa. Incluye el nombre del estudiante.', request: null };
}
