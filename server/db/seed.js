import { shiftISO } from '../domain/time.js';
import { insertRow, saveSettings, setPermission, getRevision } from './repo.js';

/* `testers` and `activity_events` are deliberately absent: tester PINs and the activity history survive every
   demo reset (the simulator resets the demo on each run); only the /super purge deletes activity.
   `login_attempts` too: a reset must not wipe the failed-login counters (nor the used PIN tokens). */
const MOVEMENT_TABLES = ['audit_log', 'bus_opt_outs', 'trip_boardings', 'trips', 'conversation_state', 'chat_messages', 'notifications', 'pickup_confirmations', 'request_events', 'requests', 'authorizations', 'guardianships', 'users', 'students', 'persons', 'attachments', 'stops', 'routes', 'role_permissions', 'staff', 'levels', 'app_meta', 'settings'];

export async function resetAll(q) { await q.exec(`TRUNCATE ${MOVEMENT_TABLES.join(', ')} RESTART IDENTITY CASCADE`); }
export async function isEmpty(q) { return (await q.query('SELECT count(*)::int AS c FROM users'))[0].c === 0; }
export async function seedIfEmpty(q, env) { if (await isEmpty(q)) await seedDemo(q, env); }

const svgDoc = (title, name) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" rx="12" fill="#eef3ee" stroke="#9aa89a"/>` +
  `<text x="16" y="36" font-size="13" font-family="sans-serif" fill="#374151">REPÚBLICA DE PANAMÁ · ${title} (demo)</text>` +
  `<circle cx="60" cy="110" r="32" fill="#cbd5cb"/><text x="110" y="104" font-size="20" font-family="sans-serif" font-weight="bold" fill="#111">${name}</text>` +
  `<text x="110" y="130" font-size="13" font-family="sans-serif" fill="#374151">Documento de ejemplo</text></svg>`, 'utf8');

export async function seedDemo(q, { now, tz }) {
  const shift = (d) => shiftISO(now, tz, d);
  const T = now.getTime();
  const H = 3600 * 1000;
  const at = (ms) => new Date(ms);

  await saveSettings(q, {
    autoApprove: true, minAnticipationMin: 60, defaultPickupPoint: 'Puerta Principal', maxTitulares: 2,
    schoolStart: '07:20', schoolEnd: '15:00', simulateBus: true, busProgress: 0.22, newAuthDays: 7,
    timezone: tz,
    school: { name: 'Instituto Académico Esperanza', short: 'IAE', phone: '+507 6800-0000', pickupPoints: ['Puerta Principal', 'Puerta Lateral (Parqueo)', 'Recepción'] },
  });

  const levels = [['preescolar', 'Preescolar', ['Kínder']], ['primaria', 'Primaria', ['1°', '2°', '3°', '4°', '5°', '6°']], ['premedia', 'Premedia', ['7°', '8°', '9°']], ['media', 'Media', ['10°', '11°', '12°']]];
  for (const [i, [id, name, grades]] of levels.entries()) await insertRow(q, 'levels', { id, name, grades, position: i });

  const staff = [
    { id: 's1', name: 'Lic. Rosa Martínez', role: 'admin', title: 'Dirección' },
    { id: 's2', name: 'Yadira Batista', role: 'recepcion', title: 'Recepción' },
    { id: 's3', name: 'Prof. Diana Ríos', role: 'profesor', title: 'Docente 3° Primaria', grades: ['3°'] },
    { id: 's4', name: 'Prof. Jorge Ávila', role: 'profesor', title: 'Docente 9° Premedia', grades: ['9°'] },
    { id: 's5', name: 'Prof. Mónica Salas', role: 'profesor', title: 'Docente Kínder', grades: ['Kínder'] },
    { id: 's6', name: 'Manuel Ortega', role: 'garita', title: 'Oficial de garita' },
    { id: 's7', name: 'Kenia Pérez', role: 'monitora', title: 'Monitora · Bus 12', routeId: 'r1' },
    { id: 's8', name: 'Lisbeth Moreno', role: 'monitora', title: 'Monitora · Bus 7', routeId: 'r2' },
  ];
  for (const s of staff) await insertRow(q, 'staff', s);

  const perms = {
    admin:     { ver_solicitudes: true,  aprobar: true,  ver_excusas: true,  decidir_excusas: true,  marcar_salida: true,  ver_estudiantes: true,  gestionar_autorizados: true,  ver_rutas: true,  marcar_bus: true,  personal: true,  config: true,  bitacora: true,  todos_niveles: true },
    recepcion: { ver_solicitudes: true,  aprobar: true,  ver_excusas: true,  decidir_excusas: true,  marcar_salida: false, ver_estudiantes: true,  gestionar_autorizados: true,  ver_rutas: true,  marcar_bus: false, personal: false, config: false, bitacora: true,  todos_niveles: true },
    profesor:  { ver_solicitudes: true,  aprobar: false, ver_excusas: true,  decidir_excusas: false, marcar_salida: false, ver_estudiantes: true,  gestionar_autorizados: false, ver_rutas: false, marcar_bus: false, personal: false, config: false, bitacora: false, todos_niveles: false },
    garita:    { ver_solicitudes: false, aprobar: false, ver_excusas: false, decidir_excusas: false, marcar_salida: true,  ver_estudiantes: false, gestionar_autorizados: false, ver_rutas: false, marcar_bus: false, personal: false, config: false, bitacora: false, todos_niveles: true },
    monitora:  { ver_solicitudes: false, aprobar: false, ver_excusas: false, decidir_excusas: false, marcar_salida: false, ver_estudiantes: true,  gestionar_autorizados: false, ver_rutas: true,  marcar_bus: true,  personal: false, config: false, bitacora: false, todos_niveles: false },
  };
  for (const [role, caps] of Object.entries(perms)) for (const [cap, allowed] of Object.entries(caps)) await setPermission(q, role, cap, allowed);

  const persons = [
    { id: 'p1', name: 'Carlos Rodríguez', phone: '+507 6111-1111', cedula: '8-701-123', relation: 'Papá', hasAccount: true, docName: 'cedula_carlos.jpg' },
    { id: 'p2', name: 'Ana Pérez', phone: '+507 6222-2222', cedula: '8-702-456', relation: 'Mamá', hasAccount: true, docName: 'cedula_ana.jpg' },
    { id: 'p3', name: 'María Pérez', phone: '+507 6999-0001', cedula: '8-200-111', relation: 'Abuela', hasAccount: false, docName: 'foto_maria.jpg' },
    { id: 'p4', name: 'Luis Rodríguez', phone: '+507 6999-0002', cedula: '8-650-222', relation: 'Tío', hasAccount: false, docName: 'cedula_luis.jpg' },
    { id: 'p5', name: 'Laura Gómez', phone: '+507 6333-3333', cedula: '8-703-789', relation: 'Mamá', hasAccount: true, docName: 'cedula_laura.jpg' },
    { id: 'p6', name: 'Pedro Castillo', phone: '+507 6444-4444', cedula: '8-704-321', relation: 'Papá', hasAccount: true, docName: 'cedula_pedro.jpg' },
    { id: 'p7', name: 'Wei Chen', phone: '+507 6555-5555', cedula: 'E-8-12345', relation: 'Papá', hasAccount: true, docName: 'pasaporte_wei.jpg' },
  ];
  for (const p of persons) {
    const bytes = svgDoc(p.docName.startsWith('foto') ? 'Foto' : 'Cédula', p.name);
    await insertRow(q, 'attachments', { id: 'att_' + p.id, ownerPersonId: p.id, purpose: p.docName.startsWith('foto') ? 'foto' : 'cedula', mime: 'image/svg+xml', bytes, size: bytes.length, name: p.docName });
    await insertRow(q, 'persons', { ...p, docAttachmentId: 'att_' + p.id });
  }

  const routes = [
    { id: 'r1', name: 'Bus 12', plate: 'T-4521', driver: 'José Pinto', monitorStaffId: 's7', color: '#1f5eff', schedule: { ida: { start: '06:00', end: '07:15' }, vuelta: { start: '15:00', end: '16:20' } },
      stops: [['st1', 'Colegio IAE', 9.0125, -79.5100], ['st2', 'Villa Lucre', 9.0300, -79.4900], ['st3', 'Brisas del Golf', 9.0450, -79.4700], ['st4', 'Cerro Viento', 9.0600, -79.4500]] },
    { id: 'r2', name: 'Bus 7', plate: 'T-3310', driver: 'Ana Castro', monitorStaffId: 's8', color: '#d97706', schedule: { ida: { start: '06:10', end: '07:15' }, vuelta: { start: '15:00', end: '16:00' } },
      stops: [['st5', 'Colegio IAE', 9.0125, -79.5100], ['st6', 'Parque Lefevre', 9.0020, -79.4850], ['st7', 'Costa del Este', 8.9900, -79.4650]] },
  ];
  for (const { stops, ...r } of routes) {
    await insertRow(q, 'routes', r);
    for (const [i, [id, name, lat, lng]] of stops.entries()) await insertRow(q, 'stops', { id, routeId: r.id, position: i, name, lat, lng });
  }

  const students = [
    { id: 'e1', name: 'Joseph Rodríguez', grade: '3°', levelId: 'primaria', emoji: '👦', familyId: 'f1', routeId: 'r1', stopId: 'st2', busLegs: ['ida', 'vuelta'], titulares: ['p1', 'p2'] },
    { id: 'e2', name: 'Sofía Rodríguez', grade: 'Kínder', levelId: 'preescolar', emoji: '👧', familyId: 'f1', routeId: 'r1', stopId: 'st2', busLegs: ['ida', 'vuelta'], titulares: ['p1', 'p2'] },
    { id: 'e3', name: 'Mateo Castillo', grade: '3°', levelId: 'primaria', emoji: '🧒', familyId: 'f2', routeId: 'r2', stopId: 'st7', busLegs: ['vuelta'], titulares: ['p5', 'p6'] },
    { id: 'e4', name: 'Emily Chen', grade: '9°', levelId: 'premedia', emoji: '👩‍🎓', familyId: 'f3', titulares: ['p7'] },
  ];
  for (const { titulares, ...s } of students) {
    await insertRow(q, 'students', s);
    for (const personId of titulares) await insertRow(q, 'guardianships', { studentId: s.id, personId });
  }

  for (const p of persons) if (p.hasAccount) await insertRow(q, 'users', { id: 'u_' + p.id, kind: 'person', refId: p.id, name: p.name, role: 'parent' });
  for (const s of staff) await insertRow(q, 'users', { id: 'u_' + s.id, kind: 'staff', refId: s.id, name: s.name, role: s.role });

  const auths = [
    { id: 'a1', studentId: 'e1', personId: 'p3', type: 'siempre', createdBy: 'p1', createdAt: at(T - 40 * 24 * H) },
    { id: 'a2', studentId: 'e2', personId: 'p3', type: 'siempre', createdBy: 'p1', createdAt: at(T - 40 * 24 * H) },
    { id: 'a3', studentId: 'e1', personId: 'p4', type: 'temporal', validFrom: shift(-2), validTo: shift(12), createdBy: 'p2', createdAt: at(T - 3 * 24 * H) },
    { id: 'a4', studentId: 'e1', personId: 'p5', type: 'una_vez', createdBy: 'p1', createdAt: at(T - 1 * 24 * H) },
  ];
  for (const a of auths) await insertRow(q, 'authorizations', a);

  await insertRow(q, 'requests', { id: 'r_h1', kind: 'salida', studentId: 'e3', requestedBy: 'p5', pickupBy: 'p5', pickupKind: 'titular', date: shift(-1), time: '14:30', reason: 'Cita con el dentista', channel: 'whatsapp', status: 'retirado', pickupPoint: 'Puerta Principal', code: '4821', createdAt: at(T - 26 * H), decidedAt: at(T - 25.5 * H), decidedBy: 's2', autoApproved: false, exitAt: at(T - 22 * H), exitBy: 's6' });
  await insertRow(q, 'request_events', { requestId: 'r_h1', at: at(T - 26 * H), text: 'Solicitud creada por Laura Gómez vía WhatsApp' });
  await insertRow(q, 'request_events', { requestId: 'r_h1', at: at(T - 25.5 * H), text: 'Aprobada por Yadira Batista · Puerta Principal' });
  await insertRow(q, 'request_events', { requestId: 'r_h1', at: at(T - 22 * H), text: 'Retirado por Laura Gómez · marcado en garita por Manuel Ortega' });
  await insertRow(q, 'requests', { id: 'r_h2', kind: 'excusa', studentId: 'e4', requestedBy: 'p7', date: shift(-3), excusaType: 'ausencia', reason: 'Fiebre, reposo indicado por el pediatra', attachmentName: 'certificado_medico.jpg', channel: 'web', status: 'aceptada', createdAt: at(T - 75 * H), decidedAt: at(T - 70 * H), decidedBy: 's2' });
  await insertRow(q, 'request_events', { requestId: 'r_h2', at: at(T - 75 * H), text: 'Excusa enviada por Wei Chen vía App' });
  await insertRow(q, 'request_events', { requestId: 'r_h2', at: at(T - 70 * H), text: 'Aceptada por Yadira Batista' });
  await insertRow(q, 'requests', { id: 'r_h3', kind: 'salida', studentId: 'e4', requestedBy: 'p7', pickupBy: 'p7', pickupKind: 'titular', date: shift(0), time: '12:15', reason: 'Trámite de pasaporte', channel: 'web', status: 'pendiente', code: '7730', createdAt: at(T - 0.5 * H) });
  await insertRow(q, 'request_events', { requestId: 'r_h3', at: at(T - 0.5 * H), text: 'Solicitud creada por Wei Chen vía App' });
  await insertRow(q, 'request_events', { requestId: 'r_h3', at: at(T - 0.5 * H), text: 'Pendiente de revisión: menos de 60 min de anticipación' });

  const tripId = `${shift(0)}_r1_vuelta`;
  await insertRow(q, 'trips', { id: tripId, date: shift(0), routeId: 'r1', leg: 'vuelta', status: 'en_ruta', startedAt: at(T - 22 * 60000) });
  for (const sid of ['e1', 'e2']) await insertRow(q, 'trip_boardings', { tripId, studentId: sid, status: 'abordo', stopId: 'st1', byStaffId: 's7', at: at(T - 21 * 60000) });

  const log = [
    [T - 26 * H, 'Sistema', 'Solicitud de salida de Mateo Castillo creada por Laura Gómez (WhatsApp)'],
    [T - 25.5 * H, 'Yadira Batista', 'Aprobó salida de Mateo Castillo · Puerta Principal'],
    [T - 22 * H, 'Manuel Ortega', 'Marcó retirado a Mateo Castillo (Laura Gómez)'],
    [T - 0.5 * H, 'Sistema', 'Solicitud de salida de Emily Chen creada por Wei Chen (App) · pendiente'],
  ];
  for (const [ts, actor, text] of log) await insertRow(q, 'audit_log', { at: at(ts), actorName: actor, actorRole: 'seed', command: 'seed', summary: text });

  await q.query("INSERT INTO app_meta(id, value) VALUES ('revision', 1) ON CONFLICT (id) DO UPDATE SET value = app_meta.value + 1");
  return getRevision(q);
}
