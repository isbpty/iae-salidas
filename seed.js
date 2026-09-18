/* =====================================================================
   IAE Salidas · Datos de demostración
   Una escuela, varios niveles/grados, familias con 1+ hijos, 2 titulares
   por estudiante y personas autorizadas (siempre / temporal / una vez).
   ===================================================================== */

function makeSeed() {
  const today = new Date();
  const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const shift = (days) => { const d = new Date(today); d.setDate(d.getDate() + days); return iso(d); };
  const T = today.getTime();
  const H = 3600 * 1000;

  return {
    school: {
      name: 'Instituto Académico Esperanza',
      short: 'IAE',
      phone: '+507 6800-0000',
      pickupPoints: ['Puerta Principal', 'Puerta Lateral (Parqueo)', 'Recepción'],
    },

    settings: {
      autoApprove: true,          // regla simple de auto-aprobación
      minAnticipationMin: 60,     // minutos de anticipación para auto-aprobar
      defaultPickupPoint: 'Puerta Principal',
      maxTitulares: 2,
      schoolStart: '07:20',
      schoolEnd: '15:00',
      simulateBus: true,          // modo demo: el bus de vuelta está en ruta "ahora"
      busProgress: 0.22,          // avance simulado del viaje (0–1)
      newAuthDays: 7,             // una autorización con menos días se considera "nueva"
    },

    /* Rutas de bus (GPS simulado) */
    routes: [
      {
        id: 'r1', name: 'Bus 12', plate: 'T-4521', driver: 'José Pinto', monitorId: 's7', color: '#1f5eff',
        stops: [
          { id: 'st1', name: 'Colegio IAE', lat: 9.0125, lng: -79.5100 },
          { id: 'st2', name: 'Villa Lucre', lat: 9.0300, lng: -79.4900 },
          { id: 'st3', name: 'Brisas del Golf', lat: 9.0450, lng: -79.4700 },
          { id: 'st4', name: 'Cerro Viento', lat: 9.0600, lng: -79.4500 },
        ],
        schedule: { ida: { start: '06:00', end: '07:15' }, vuelta: { start: '15:00', end: '16:20' } },
      },
      {
        id: 'r2', name: 'Bus 7', plate: 'T-3310', driver: 'Ana Castro', monitorId: 's8', color: '#d97706',
        stops: [
          { id: 'st5', name: 'Colegio IAE', lat: 9.0125, lng: -79.5100 },
          { id: 'st6', name: 'Parque Lefevre', lat: 9.0020, lng: -79.4850 },
          { id: 'st7', name: 'Costa del Este', lat: 8.9900, lng: -79.4650 },
        ],
        schedule: { ida: { start: '06:10', end: '07:15' }, vuelta: { start: '15:00', end: '16:00' } },
      },
    ],
    busTrips: {     // clave fecha_ruta_tramo → { status, boarded: {estudiante: {status, ts, by, stopId}}, noBus: [ids] }
      [shift(0) + '_r1_vuelta']: {
        status: 'en_ruta', startedAt: T - 22 * 60000,
        boarded: {
          e1: { status: 'abordo', ts: T - 21 * 60000, by: 's7', stopId: 'st1' },
          e2: { status: 'abordo', ts: T - 21 * 60000, by: 's7', stopId: 'st1' },
        },
        noBus: [],
      },
    },

    levels: [
      { id: 'preescolar', name: 'Preescolar', grades: ['Kínder'] },
      { id: 'primaria', name: 'Primaria', grades: ['1°', '2°', '3°', '4°', '5°', '6°'] },
      { id: 'premedia', name: 'Premedia', grades: ['7°', '8°', '9°'] },
      { id: 'media', name: 'Media', grades: ['10°', '11°', '12°'] },
    ],

    /* Personal de la escuela y sus roles */
    staff: [
      { id: 's1', name: 'Lic. Rosa Martínez', role: 'admin', title: 'Dirección' },
      { id: 's2', name: 'Yadira Batista', role: 'recepcion', title: 'Recepción' },
      { id: 's3', name: 'Prof. Diana Ríos', role: 'profesor', title: 'Docente 3° Primaria', grades: ['3°'] },
      { id: 's4', name: 'Prof. Jorge Ávila', role: 'profesor', title: 'Docente 9° Premedia', grades: ['9°'] },
      { id: 's5', name: 'Prof. Mónica Salas', role: 'profesor', title: 'Docente Kínder', grades: ['Kínder'] },
      { id: 's6', name: 'Manuel Ortega', role: 'garita', title: 'Oficial de garita' },
      { id: 's7', name: 'Kenia Pérez', role: 'monitora', title: 'Monitora · Bus 12', routeId: 'r1' },
      { id: 's8', name: 'Lisbeth Moreno', role: 'monitora', title: 'Monitora · Bus 7', routeId: 'r2' },
    ],

    /* Matriz de permisos por rol (editable desde Configuración) */
    permissions: {
      admin:     { ver_solicitudes: true,  aprobar: true,  ver_excusas: true,  decidir_excusas: true,  marcar_salida: true,  ver_estudiantes: true,  gestionar_autorizados: true,  ver_rutas: true,  marcar_bus: true,  personal: true,  config: true,  bitacora: true,  todos_niveles: true },
      recepcion: { ver_solicitudes: true,  aprobar: true,  ver_excusas: true,  decidir_excusas: true,  marcar_salida: false, ver_estudiantes: true,  gestionar_autorizados: true,  ver_rutas: true,  marcar_bus: false, personal: false, config: false, bitacora: true,  todos_niveles: true },
      profesor:  { ver_solicitudes: true,  aprobar: false, ver_excusas: true,  decidir_excusas: false, marcar_salida: false, ver_estudiantes: true,  gestionar_autorizados: false, ver_rutas: false, marcar_bus: false, personal: false, config: false, bitacora: false, todos_niveles: false },
      garita:    { ver_solicitudes: false, aprobar: false, ver_excusas: false, decidir_excusas: false, marcar_salida: true,  ver_estudiantes: false, gestionar_autorizados: false, ver_rutas: false, marcar_bus: false, personal: false, config: false, bitacora: false, todos_niveles: true },
      monitora:  { ver_solicitudes: false, aprobar: false, ver_excusas: false, decidir_excusas: false, marcar_salida: false, ver_estudiantes: true,  gestionar_autorizados: false, ver_rutas: true,  marcar_bus: true,  personal: false, config: false, bitacora: false, todos_niveles: false },
    },

    /* Personas: padres titulares (con cuenta) y autorizados (con o sin cuenta) */
    persons: [
      { id: 'p1', name: 'Carlos Rodríguez', phone: '+507 6111-1111', cedula: '8-701-123', relation: 'Papá', account: true, doc: 'cedula_carlos.jpg' },
      { id: 'p2', name: 'Ana Pérez', phone: '+507 6222-2222', cedula: '8-702-456', relation: 'Mamá', account: true, doc: 'cedula_ana.jpg' },
      { id: 'p3', name: 'María Pérez', phone: '+507 6999-0001', cedula: '8-200-111', relation: 'Abuela', account: false, doc: 'foto_maria.jpg' },
      { id: 'p4', name: 'Luis Rodríguez', phone: '+507 6999-0002', cedula: '8-650-222', relation: 'Tío', account: false, doc: 'cedula_luis.jpg' },
      { id: 'p5', name: 'Laura Gómez', phone: '+507 6333-3333', cedula: '8-703-789', relation: 'Mamá', account: true, doc: 'cedula_laura.jpg' },
      { id: 'p6', name: 'Pedro Castillo', phone: '+507 6444-4444', cedula: '8-704-321', relation: 'Papá', account: true, doc: 'cedula_pedro.jpg' },
      { id: 'p7', name: 'Wei Chen', phone: '+507 6555-5555', cedula: 'E-8-12345', relation: 'Papá', account: true, doc: 'pasaporte_wei.jpg' },
    ],

    /* Estudiantes: cada uno con hasta 2 titulares y, opcionalmente, ruta y parada de bus */
    students: [
      { id: 'e1', name: 'Joseph Rodríguez', grade: '3°', level: 'primaria', emoji: '👦', titulares: ['p1', 'p2'], familyId: 'f1', routeId: 'r1', stopId: 'st2', busLegs: ['ida', 'vuelta'] },
      { id: 'e2', name: 'Sofía Rodríguez', grade: 'Kínder', level: 'preescolar', emoji: '👧', titulares: ['p1', 'p2'], familyId: 'f1', routeId: 'r1', stopId: 'st2', busLegs: ['ida', 'vuelta'] },
      { id: 'e3', name: 'Mateo Castillo', grade: '3°', level: 'primaria', emoji: '🧒', titulares: ['p5', 'p6'], familyId: 'f2', routeId: 'r2', stopId: 'st7', busLegs: ['vuelta'] },
      { id: 'e4', name: 'Emily Chen', grade: '9°', level: 'premedia', emoji: '👩‍🎓', titulares: ['p7'], familyId: 'f3' },
    ],

    /* Autorizaciones para retirar */
    authorizations: [
      { id: 'a1', studentId: 'e1', personId: 'p3', type: 'siempre', createdBy: 'p1', createdAt: T - 40 * 24 * H },
      { id: 'a2', studentId: 'e2', personId: 'p3', type: 'siempre', createdBy: 'p1', createdAt: T - 40 * 24 * H },
      { id: 'a3', studentId: 'e1', personId: 'p4', type: 'temporal', from: shift(-2), to: shift(12), createdBy: 'p2', createdAt: T - 3 * 24 * H },
      { id: 'a4', studentId: 'e1', personId: 'p5', type: 'una_vez', used: false, createdBy: 'p1', createdAt: T - 1 * 24 * H },
    ],

    /* Historial de solicitudes */
    requests: [
      {
        id: 'r_h1', kind: 'salida', studentId: 'e3', requestedBy: 'p5', pickupBy: 'p5', date: shift(-1), time: '14:30',
        reason: 'Cita con el dentista', channel: 'whatsapp', status: 'retirado', pickupPoint: 'Puerta Principal', code: '4821',
        createdAt: T - 26 * H, decidedAt: T - 25.5 * H, decidedBy: 's2', autoApproved: false, exitAt: T - 22 * H, exitBy: 's6',
        history: [
          { ts: T - 26 * H, text: 'Solicitud creada por Laura Gómez vía WhatsApp' },
          { ts: T - 25.5 * H, text: 'Aprobada por Yadira Batista · Puerta Principal' },
          { ts: T - 22 * H, text: 'Retirado por Laura Gómez · marcado en garita por Manuel Ortega' },
        ],
      },
      {
        id: 'r_h2', kind: 'excusa', studentId: 'e4', requestedBy: 'p7', date: shift(-3), excusaType: 'ausencia',
        reason: 'Fiebre, reposo indicado por el pediatra', attachment: 'certificado_medico.jpg', channel: 'web', status: 'aceptada',
        createdAt: T - 75 * H, decidedAt: T - 70 * H, decidedBy: 's2',
        history: [
          { ts: T - 75 * H, text: 'Excusa enviada por Wei Chen vía App' },
          { ts: T - 70 * H, text: 'Aceptada por Yadira Batista' },
        ],
      },
      {
        id: 'r_h3', kind: 'salida', studentId: 'e4', requestedBy: 'p7', pickupBy: 'p7', date: shift(0), time: '12:15',
        reason: 'Trámite de pasaporte', channel: 'web', status: 'pendiente', code: '7730',
        createdAt: T - 0.5 * H,
        history: [
          { ts: T - 0.5 * H, text: 'Solicitud creada por Wei Chen vía App' },
          { ts: T - 0.5 * H, text: 'Pendiente de revisión: menos de 60 min de anticipación' },
        ],
      },
    ],

    notifications: [],
    chats: {},
    chatState: {},
    log: [
      { ts: T - 26 * H, actor: 'Sistema', text: 'Solicitud de salida de Mateo Castillo creada por Laura Gómez (WhatsApp)' },
      { ts: T - 25.5 * H, actor: 'Yadira Batista', text: 'Aprobó salida de Mateo Castillo · Puerta Principal' },
      { ts: T - 22 * H, actor: 'Manuel Ortega', text: 'Marcó retirado a Mateo Castillo (Laura Gómez)' },
      { ts: T - 0.5 * H, actor: 'Sistema', text: 'Solicitud de salida de Emily Chen creada por Wei Chen (App) · pendiente' },
    ],
  };
}
