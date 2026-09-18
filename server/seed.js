export function connectedSeed() {
  return {
    version: 1,
    school: { id: 'iae', name: 'Instituto Académico Esperanza', pickupPoints: ['Puerta Principal', 'Recepción'] },
    users: [
      { id: 'parent-carlos', name: 'Carlos Rodríguez', role: 'parent', phone: '+50761111111', studentIds: ['joseph', 'sofia'] },
      { id: 'parent-ana', name: 'Ana Pérez', role: 'parent', phone: '+50762222222', studentIds: ['joseph', 'sofia'] },
      { id: 'reception-yadira', name: 'Yadira Batista', role: 'reception' },
      { id: 'gate-manuel', name: 'Manuel Ortega', role: 'gate' },
      { id: 'admin-rosa', name: 'Rosa Martínez', role: 'admin' }
    ],
    students: [
      { id: 'joseph', name: 'Joseph Rodríguez', grade: '3°', guardianIds: ['parent-carlos', 'parent-ana'] },
      { id: 'sofia', name: 'Sofía Rodríguez', grade: 'Kínder', guardianIds: ['parent-carlos', 'parent-ana'] }
    ],
    authorizedPickups: [
      { id: 'pickup-maria', studentId: 'joseph', name: 'María Pérez', relation: 'Abuela', cedula: '8-200-111', status: 'active' }
    ],
    requests: [], notifications: [], audit: [], inboundMessages: [],
    transports: { simulator: { status: 'connected' }, whatsappQr: { status: 'disconnected', testOnly: true } }
  };
}
