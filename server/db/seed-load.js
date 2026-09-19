/* Datos de carga: cientos de familias generadas de forma determinista (misma semilla → mismos datos)
   encima del seed base, para probar el sistema con el tamaño real de una escuela. */
import { shiftISO } from '../domain/time.js';
import { insertRows, getRevision } from './repo.js';

/* Tamaño de familia: 1 hijo 15 %, 2 hijos 30 %, 3 hijos 35 %, 4 hijos 15 %, 5 hijos 5 % (promedio ≈ 2.65). */
export const FAMILY_SIZE_WEIGHTS = [[1, 0.15], [2, 0.30], [3, 0.35], [4, 0.15], [5, 0.05]];
const GRADES = [['Kínder', 'preescolar'], ['1°', 'primaria'], ['2°', 'primaria'], ['3°', 'primaria'], ['4°', 'primaria'], ['5°', 'primaria'], ['6°', 'primaria'], ['7°', 'premedia'], ['8°', 'premedia'], ['9°', 'premedia'], ['10°', 'media'], ['11°', 'media'], ['12°', 'media']];
const BOYS = ['Mateo', 'Santiago', 'Sebastián', 'Diego', 'Daniel', 'Gabriel', 'Lucas', 'Samuel', 'Alejandro', 'David', 'Nicolás', 'Andrés', 'Adrián', 'Benjamín', 'Tomás', 'Emmanuel', 'Isaac', 'Julián', 'Martín', 'Thiago', 'Iker', 'Josué', 'Ángel', 'Ian', 'Leonardo', 'Bruno', 'Elías', 'Rafael', 'Joel', 'Kevin'];
const GIRLS = ['Sofía', 'Valentina', 'Isabella', 'Camila', 'Valeria', 'Mariana', 'Luciana', 'Ximena', 'Victoria', 'Emma', 'Renata', 'Regina', 'Zoe', 'Julieta', 'Antonella', 'Emily', 'Nicole', 'Paula', 'Daniela', 'Fernanda', 'Gabriela', 'Alanis', 'Ariana', 'Melany', 'Génesis', 'Abigail', 'Naomi', 'Sara', 'Elena', 'Amelia'];
const ADULTS_M = ['Carlos', 'José', 'Luis', 'Juan', 'Miguel', 'Roberto', 'Jorge', 'Ricardo', 'Fernando', 'Eduardo', 'Rubén', 'Óscar', 'Alberto', 'Manuel', 'Javier', 'Raúl', 'Héctor', 'Iván', 'Marcos', 'Enrique'];
const ADULTS_F = ['Ana', 'María', 'Carmen', 'Rosa', 'Yadira', 'Patricia', 'Lorena', 'Gloria', 'Marta', 'Diana', 'Elsa', 'Yolanda', 'Iris', 'Vielka', 'Marisol', 'Karina', 'Nadia', 'Leyla', 'Aracelis', 'Betzaida'];
const SURNAMES = ['Rodríguez', 'González', 'Pérez', 'Castillo', 'Gómez', 'Morales', 'Batista', 'Ortega', 'Sánchez', 'Ramos', 'Herrera', 'Jiménez', 'Vega', 'Moreno', 'Díaz', 'Quintero', 'Espinosa', 'Pinto', 'Castro', 'Ríos', 'Ávila', 'Salas', 'Martínez', 'Chen', 'Lee', 'Wong', 'Núñez', 'Cedeño', 'Barría', 'Aguilar', 'Vásquez', 'Guerra', 'Pitti', 'Samaniego', 'Bernal', 'Camarena', 'Domínguez', 'Fuentes', 'Ibarra', 'Lasso', 'Mendoza', 'Navarro', 'Ortiz', 'Reyes', 'Serrano', 'Tejada', 'Urriola', 'Villarreal', 'Zambrano', 'De León'];
const RELATIONS = ['Abuela', 'Abuelo', 'Tía', 'Tío', 'Niñera', 'Chofer', 'Vecina', 'Hermana mayor'];
const ROUTE_NAMES = [['Bus 3', 'Costa del Este'], ['Bus 5', 'San Francisco'], ['Bus 8', 'Brisas del Golf'], ['Bus 14', 'Villa Lucre'], ['Bus 21', 'Tocumen'], ['Bus 27', 'Arraiján']];
const STOP_NAMES = ['Parque', 'Plaza', 'Entrada', 'Iglesia', 'Supermercado', 'Estación', 'Colegio'];

/* mulberry32: pequeño generador determinista. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
export function weighted(r, weights) { let x = r(); for (const [v, w] of weights) { x -= w; if (x <= 0) return v; } return weights[weights.length - 1][0]; }
/* Reparte `target` estudiantes en familias según los pesos; la última familia se recorta para cuadrar el total. */
export function planFamilies(r, target) {
  const sizes = []; let total = 0;
  while (total < target) { const s = Math.min(weighted(r, FAMILY_SIZE_WEIGHTS), target - total); sizes.push(s); total += s; }
  return sizes;
}
const svgDoc = (name) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" rx="12" fill="#eef3ee" stroke="#9aa89a"/><text x="16" y="36" font-size="13" font-family="sans-serif" fill="#374151">Cédula (demo de carga)</text><circle cx="60" cy="110" r="32" fill="#cbd5cb"/><text x="110" y="104" font-size="20" font-family="sans-serif" font-weight="bold" fill="#111">${name}</text></svg>`, 'utf8');

export async function seedLoad(q, { students = 700, seed = 7, now, tz }) {
  const r = rng(seed);
  const shift = (d) => shiftISO(now, tz, d);
  const T = now.getTime();
  const H = 3600 * 1000;
  const counts = { families: 0, students: 0, persons: 0, users: 0, authorizations: 0, requests: 0, staff: 0, routes: 0 };
  let seq = 0; const next = (p) => p + '_' + (++seq);
  const usedCedula = new Set(); const usedPhone = new Set();
  const cedula = () => { for (;;) { const c = `8-${700 + Math.floor(r() * 300)}-${1000 + Math.floor(r() * 9000)}`; if (!usedCedula.has(c)) { usedCedula.add(c); return c; } } };
  const phone = () => { for (;;) { const p = `+507 6${100 + Math.floor(r() * 900)}-${1000 + Math.floor(r() * 9000)}`; if (!usedPhone.has(p)) { usedPhone.add(p); return p; } } };

  /* Rutas y monitoras extra (r3..r8) */
  const routes = [], stops = [], staff = [];
  ROUTE_NAMES.forEach(([name, zone], i) => {
    const id = 'rl_' + (i + 3);
    const monitor = { id: 'sml_' + (i + 3), name: pick(r, ADULTS_F) + ' ' + pick(r, SURNAMES), role: 'monitora', title: 'Monitora · ' + name, routeId: id };
    staff.push(monitor);
    routes.push({ id, name, plate: 'T-' + (5000 + Math.floor(r() * 4000)), driver: pick(r, ADULTS_M) + ' ' + pick(r, SURNAMES), monitorStaffId: monitor.id, color: pick(r, ['#0891b2', '#7c3aed', '#db2777', '#059669', '#ea580c', '#4f46e5']), schedule: { ida: { start: '06:00', end: '07:15' }, vuelta: { start: '15:00', end: '16:20' } } });
    const base = [9.0125 + (r() - 0.5) * 0.02, -79.51 + (r() - 0.5) * 0.02];
    for (let s = 0; s < 4; s++) stops.push({ id: `${id}_st${s + 1}`, routeId: id, position: s, name: s === 0 ? 'Colegio IAE' : `${pick(r, STOP_NAMES)} ${zone}`, lat: base[0] + s * 0.012 + (r() - 0.5) * 0.004, lng: base[1] + s * 0.014 + (r() - 0.5) * 0.004 });
  });
  /* Un docente por grado que aún no lo tenga (el seed base cubre Kínder, 3° y 9°) */
  for (const [grade, level] of GRADES) {
    if (['Kínder', '3°', '9°'].includes(grade)) continue;
    staff.push({ id: 'stl_' + grade.replace('°', ''), name: 'Prof. ' + pick(r, [...ADULTS_M, ...ADULTS_F]) + ' ' + pick(r, SURNAMES), role: 'profesor', title: `Docente ${grade} ${level[0].toUpperCase() + level.slice(1)}`, grades: [grade] });
  }
  /* Sin logins nuevos: el juego de usuarios (padres, autorizados y personal) sigue siendo el del seed base. */

  /* Familias */
  const persons = [], attachments = [], studentsRows = [], guardianships = [], authorizations = [], requests = [], events = [];
  const sizes = planFamilies(r, students);
  const allRouteIds = ['r1', 'r2', ...routes.map((x) => x.id)];
  const stopsByRoute = { r1: ['st1', 'st2', 'st3', 'st4'], r2: ['st5', 'st6', 'st7'] };
  for (const s of stops) (stopsByRoute[s.routeId] ||= []).push(s.id);
  let studentSeq = 0;
  sizes.forEach((size, fi) => {
    const familyId = 'fl_' + (fi + 1);
    const surname = pick(r, SURNAMES), surname2 = pick(r, SURNAMES);
    const twoParents = r() < 0.85;
    const dad = { id: next('pl'), name: pick(r, ADULTS_M) + ' ' + surname, phone: phone(), cedula: cedula(), relation: 'Papá', hasAccount: false };
    const mom = { id: next('pl'), name: pick(r, ADULTS_F) + ' ' + surname2, phone: phone(), cedula: cedula(), relation: 'Mamá', hasAccount: false };
    const titulares = twoParents ? [dad, mom] : [r() < 0.7 ? mom : dad];
    for (const p of titulares) persons.push(p);
    const onBus = r() < 0.4; const routeId = onBus ? pick(r, allRouteIds) : null; const stopId = routeId ? pick(r, stopsByRoute[routeId].slice(1)) : null;
    const kids = [];
    for (let k = 0; k < size; k++) {
      const girl = r() < 0.5; const [grade, level] = pick(r, GRADES);
      const st = { id: 'el_' + (++studentSeq), name: (girl ? pick(r, GIRLS) : pick(r, BOYS)) + ' ' + surname, grade, levelId: level, emoji: girl ? (level === 'media' || level === 'premedia' ? '👩‍🎓' : '👧') : (level === 'media' || level === 'premedia' ? '🧑‍🎓' : '👦'), familyId, routeId, stopId, busLegs: routeId ? (r() < 0.8 ? ['ida', 'vuelta'] : ['vuelta']) : null };
      studentsRows.push(st); kids.push(st);
      for (const p of titulares) guardianships.push({ studentId: st.id, personId: p.id });
    }
    /* Autorizados: 0–2 por familia, con documento */
    const nAuth = weighted(r, [[0, 0.35], [1, 0.4], [2, 0.25]]);
    for (let a = 0; a < nAuth; a++) {
      const relation = pick(r, RELATIONS);
      const p = { id: next('pl'), name: (relation.endsWith('a') || relation === 'Niñera' || relation === 'Vecina' ? pick(r, ADULTS_F) : pick(r, ADULTS_M)) + ' ' + pick(r, SURNAMES), phone: r() < 0.7 ? phone() : null, cedula: cedula(), relation, hasAccount: false };
      const bytes = svgDoc(p.name); const att = { id: 'attl_' + p.id, ownerPersonId: p.id, purpose: 'cedula', mime: 'image/svg+xml', bytes, size: bytes.length, name: 'cedula.svg' };
      attachments.push(att); persons.push({ ...p, docName: att.name, docAttachmentId: att.id });
      const type = weighted(r, [['siempre', 0.6], ['temporal', 0.25], ['una_vez', 0.15]]);
      for (const st of kids) authorizations.push({ id: next('al'), studentId: st.id, personId: p.id, type, validFrom: type === 'temporal' ? shift(-3) : null, validTo: type === 'temporal' ? shift(20) : null, createdBy: titulares[0].id, createdAt: new Date(T - Math.floor(r() * 60) * 24 * H) });
    }
    /* Historial: ~12 % de los estudiantes con una solicitud */
    for (const st of kids) {
      if (r() >= 0.12) continue;
      const by = pick(r, titulares); const kind = weighted(r, [['retirado', 0.55], ['pendiente', 0.3], ['excusa', 0.15]]);
      const id = next('rl'); const time = pick(r, ['11:30', '12:15', '13:00', '13:45', '14:30']);
      if (kind === 'excusa') {
        requests.push({ id, kind: 'excusa', studentId: st.id, requestedBy: by.id, date: shift(1), excusaType: r() < 0.7 ? 'ausencia' : 'tardanza', reason: pick(r, ['Cita médica', 'Viaje familiar', 'Control con el pediatra', 'Trámite de pasaporte']), channel: 'web', status: 'pendiente', createdAt: new Date(T - 2 * H) });
        events.push({ requestId: id, at: new Date(T - 2 * H), text: 'Excusa enviada por ' + by.name + ' vía App' });
      } else if (kind === 'pendiente') {
        requests.push({ id, kind: 'salida', studentId: st.id, requestedBy: by.id, pickupBy: by.id, pickupKind: 'titular', date: shift(0), time, reason: pick(r, ['Cita médica', 'Trámite', 'Actividad familiar']), channel: r() < 0.6 ? 'whatsapp' : 'web', status: 'pendiente', code: String(1000 + Math.floor(r() * 9000)), createdAt: new Date(T - 0.4 * H) });
        events.push({ requestId: id, at: new Date(T - 0.4 * H), text: 'Solicitud creada por ' + by.name + ' vía WhatsApp' });
        events.push({ requestId: id, at: new Date(T - 0.4 * H), text: 'Pendiente de revisión: menos de 60 min de anticipación' });
      } else {
        requests.push({ id, kind: 'salida', studentId: st.id, requestedBy: by.id, pickupBy: by.id, pickupKind: 'titular', date: shift(-1), time, reason: 'Cita médica', channel: 'whatsapp', status: 'retirado', pickupPoint: 'Puerta Principal', code: String(1000 + Math.floor(r() * 9000)), createdAt: new Date(T - 26 * H), decidedAt: new Date(T - 25.5 * H), decidedBy: 'auto', autoApproved: true, exitAt: new Date(T - 22 * H), exitBy: 's6' });
        events.push({ requestId: id, at: new Date(T - 26 * H), text: 'Solicitud creada por ' + by.name + ' vía WhatsApp' });
        events.push({ requestId: id, at: new Date(T - 25.5 * H), text: 'Aprobada automáticamente (regla: titular, anticipación, autorizado vigente) · Puerta Principal' });
        events.push({ requestId: id, at: new Date(T - 22 * H), text: 'Retirado por ' + by.name + ' · marcado en garita por Manuel Ortega' });
      }
    }
  });

  const norm = (rows, keys) => rows.map((row) => Object.fromEntries(keys.map((k) => [k, row[k] === undefined ? (k === 'autoApproved' ? false : null) : row[k]])));
  await insertRows(q, 'staff', norm(staff, ['id', 'name', 'role', 'title', 'grades', 'routeId']));
  await insertRows(q, 'routes', norm(routes, ['id', 'name', 'plate', 'driver', 'monitorStaffId', 'color', 'schedule']));
  await insertRows(q, 'stops', norm(stops, ['id', 'routeId', 'position', 'name', 'lat', 'lng']));
  await insertRows(q, 'attachments', norm(attachments, ['id', 'ownerPersonId', 'purpose', 'mime', 'bytes', 'size', 'name']));
  await insertRows(q, 'persons', norm(persons, ['id', 'name', 'phone', 'cedula', 'relation', 'hasAccount', 'docName', 'docAttachmentId']));
  await insertRows(q, 'students', norm(studentsRows, ['id', 'name', 'grade', 'levelId', 'emoji', 'familyId', 'routeId', 'stopId', 'busLegs']));
  await insertRows(q, 'guardianships', guardianships);
  await insertRows(q, 'authorizations', norm(authorizations, ['id', 'studentId', 'personId', 'type', 'validFrom', 'validTo', 'createdBy', 'createdAt']));
  await insertRows(q, 'requests', norm(requests, ['id', 'kind', 'studentId', 'requestedBy', 'pickupBy', 'pickupKind', 'date', 'time', 'reason', 'excusaType', 'channel', 'status', 'pickupPoint', 'code', 'decidedBy', 'decidedAt', 'autoApproved', 'exitAt', 'exitBy', 'createdAt']));
  await insertRows(q, 'request_events', events);
  await q.query("INSERT INTO app_meta(id, value) VALUES ('revision', 1) ON CONFLICT (id) DO UPDATE SET value = app_meta.value + 1");

  Object.assign(counts, { families: sizes.length, students: studentsRows.length, persons: persons.length, users: 0, authorizations: authorizations.length, requests: requests.length, staff: staff.length, routes: routes.length, revision: await getRevision(q) });
  return counts;
}
