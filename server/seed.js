export function connectedSeed() {
  return {
    version: 1,
    school: { id: 'iae', name: 'Instituto Académico Esperanza', pickupPoints: ['Puerta Principal', 'Recepción'] },
    users: [
      { id: 'parent-carlos', name: 'Carlos Rodríguez', role: 'parent', phone: '+50761111111', studentIds: ['joseph', 'sofia'], prototypeIdentity: { personId: 'p1', phoneId: 'p1' } },
      { id: 'parent-ana', name: 'Ana Pérez', role: 'parent', phone: '+50762222222', studentIds: ['joseph', 'sofia'], prototypeIdentity: { personId: 'p2', phoneId: 'p2' } },
      { id: 'reception-yadira', name: 'Yadira Batista', role: 'reception', prototypeIdentity: { staffId: 's2' } },
      { id: 'gate-manuel', name: 'Manuel Ortega', role: 'gate', prototypeIdentity: { staffId: 's6' } },
      { id: 'admin-rosa', name: 'Rosa Martínez', role: 'admin', prototypeIdentity: { staffId: 's1' } },
      { id: 'teacher-diana', name: 'Prof. Diana Ríos', role: 'teacher', prototypeIdentity: { staffId: 's3' } },
      { id: 'monitor-kenia', name: 'Kenia Pérez', role: 'monitora', prototypeIdentity: { staffId: 's7' } }
    ],
    students: [
      { id: 'joseph', name: 'Joseph Rodríguez', grade: '3°', guardianIds: ['parent-carlos', 'parent-ana'] },
      { id: 'sofia', name: 'Sofía Rodríguez', grade: 'Kínder', guardianIds: ['parent-carlos', 'parent-ana'] }
    ],
    authorizedPickups: [
      { id: 'pickup-maria', studentId: 'joseph', name: 'María Pérez', relation: 'Abuela', cedula: '8-200-111', status: 'active' }
    ],
    requests: [], notifications: [], deliveryAttempts: [], audit: [], inboundMessages: [], prototypeState: null, prototypeRevision: 0,
    transports: { simulator: { status: 'connected' }, whatsappQr: { status: 'disconnected', testOnly: true } }
  };
}
