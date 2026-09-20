/* Accesores sobre la proyección V. Ninguna regla de negocio vive aquí: solo lectura para pintar. */
const person = (id) => (V.persons || {})[id] || null;
const student = (id) => (V.students || []).find((s) => s.id === id) || null;
const request = (id) => (V.requests || []).find((r) => r.id === id) || null;
const route = (id) => (V.routes || []).find((r) => r.id === id) || null;
const staffName = (id) => (V.staffNames || {})[id] || '';
const levelName = (id) => ((V.levels || []).find((l) => l.id === id) || {}).name || id;
function studentsOf(personId) { return (V.students || []).filter((s) => (s.titulares || []).includes(personId)); }
function isAuthActive(a) {
  const t = todayISO();
  if (a.revokedAt) return false;
  if (a.type === 'siempre') return true;
  if (a.type === 'temporal') return a.validFrom <= t && t <= a.validTo;
  if (a.type === 'una_vez') return !a.usedAt;
  return false;
}
function authsForStudent(sid) { return (V.authorizations || []).filter((a) => a.studentId === sid && !a.revokedAt); }
function authorizedFor() { return V.authorizedFor || []; }
function pickupEligibility(studentId, personId) {
  const st = student(studentId);
  if (!st || !personId) return { ok: false };
  if (st.titulares.includes(personId)) return { ok: true, kind: 'titular' };
  const a = (V.authorizations || []).find((x) => x.studentId === studentId && x.personId === personId && isAuthActive(x));
  return a ? { ok: true, kind: a.type, auth: a } : { ok: false };
}
function pickupCandidates(studentId) {
  const st = student(studentId);
  const list = st.titulares.map((id) => ({ person: person(id), kind: 'titular' }));
  authsForStudent(studentId).filter(isAuthActive).forEach((a) => list.push({ person: person(a.personId), kind: a.type, auth: a }));
  return list.filter((c) => c.person);
}
function staffCan(cap) { return !!(V.capabilities || {})[cap]; }
function getTrip(routeId, leg) { return (V.trips || []).find((t) => t.routeId === routeId && t.leg === leg) || { status: 'programado', boarded: {}, noBus: [] }; }
function currentLeg(r) { return (V.gpsNow || {})[r.id] || null; }
function legStops(r, leg) { return leg === 'ida' ? r.stops.slice().reverse() : r.stops; }
function busPosition(r, leg, progress) {
  const stops = legStops(r, leg); const n = stops.length;
  const segF = Math.min(0.999, Math.max(0, progress)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(segF)); const f = segF - i;
  const a = stops[i]; const b = stops[i + 1];
  const total = minutesOf(r.schedule[leg].end) - minutesOf(r.schedule[leg].start);
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, prevStop: a, nextStop: b, index: i, frac: f, stops, minutesLeft: Math.round((1 - progress) * total) };
}
function chatMessages(key) { return ME.role === 'parent' ? (V.chat || []) : ((V.chats || {})[key] || []); }
function chatStateFor(key) { return ME.role === 'parent' ? V.chatState : ((V.chatStates || {})[key] || null); }
function allChats() { return ME.role === 'parent' ? { me: V.chat || [] } : (V.chats || {}); }
function describePickup(r) { const pk = person(r.pickupBy); if (!pk) return ''; return pk.name + (r.pickupBy === r.requestedBy ? ' (solicitante)' : ' (' + pk.relation + ')'); }
