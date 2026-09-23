/* Accesores sobre la proyección V. Ninguna regla de negocio vive aquí: solo lectura para pintar. */
const person = (id) => (V.persons || {})[id] || null;
const student = (id) => (V.students || []).find((s) => s.id === id) || null;
const request = (id) => (V.requests || []).find((r) => r.id === id) || null;
const route = (id) => (V.routes || []).find((r) => r.id === id) || null;
const staffName = (id) => (V.staffNames || {})[id] || '';
const levelName = (id) => ((V.levels || []).find((l) => l.id === id) || {}).name || id;
function studentsOf(personId) { return (V.students || []).filter((s) => (s.titulares || []).includes(personId)); }
/* `date` defaults to "hoy" but a caller building the salida form must pass the date actually
   being requested: a temporal or una_vez authorization is only valid for its own window, which
   may not include today (mirrors server/domain/eligibility.js).
   `date` must be a YYYY-MM-DD string; anything else (notably a bare `.filter(isAuthActive)`,
   which passes the array index as the second argument) falls back to "hoy" instead of comparing
   dates against a number. */
function isAuthActive(a, date) {
  const t = typeof date === 'string' && date ? date : todayISO();
  if (a.revokedAt) return false;
  if (a.type === 'siempre') return true;
  if (a.type === 'temporal') return a.validFrom <= t && t <= a.validTo;
  if (a.type === 'una_vez') {
    if (a.usedAt) return false;
    /* expiresOn is computed server-side, in the school's timezone (server/domain/eligibility.js
       withAuthExpiry) -- the client never redoes "createdAt + 7 days" arithmetic in the browser's
       own local timezone, which used to disagree with the server around the cutoff day. */
    const validTo = a.validTo || a.expiresOn || null;
    return !validTo || t <= validTo;
  }
  return false;
}
function authsForStudent(sid) { return (V.authorizations || []).filter((a) => a.studentId === sid && !a.revokedAt); }
function authorizedFor() { return V.authorizedFor || []; }
function pickupEligibility(studentId, personId, date) {
  const st = student(studentId);
  if (!st || !personId) return { ok: false };
  if (st.titulares.includes(personId)) return { ok: true, kind: 'titular' };
  const a = (V.authorizations || []).find((x) => x.studentId === studentId && x.personId === personId && isAuthActive(x, date));
  return a ? { ok: true, kind: a.type, auth: a } : { ok: false };
}
function pickupCandidates(studentId, date) {
  const st = student(studentId);
  const list = st.titulares.map((id) => ({ person: person(id), kind: 'titular' }));
  authsForStudent(studentId).filter((a) => isAuthActive(a, date)).forEach((a) => list.push({ person: person(a.personId), kind: a.type, auth: a }));
  return list.filter((c) => c.person);
}
function staffCan(cap) { return !!(V.capabilities || {})[cap]; }
function getTrip(routeId, leg) { return (V.trips || []).find((t) => t.routeId === routeId && t.leg === leg) || { status: 'programado', boarded: {}, noBus: [] }; }
function gpsPosition(r) { return (V.gpsNow || {})[r.id] || null; }
function legStops(r, leg) { return leg === 'ida' ? r.stops.slice().reverse() : r.stops; }
function busPosition(r, leg, progress) {
  const stops = legStops(r, leg); const n = stops.length;
  const segF = Math.min(0.999, Math.max(0, progress)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(segF)); const f = segF - i;
  const a = stops[i]; const b = stops[i + 1];
  const total = minutesOf(r.schedule[leg].end) - minutesOf(r.schedule[leg].start);
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, prevStop: a, nextStop: b, index: i, frac: f, stops, minutesLeft: Math.round((1 - progress) * total) };
}
/* R3: `V.chats` is now a summary per chat_key (last message, count, unread), not every family's full
   transcript -- the admin/recepción view stopped carrying that (see server/db/repo.js
   listChatSummaries). The full messages for whichever phone the simulator has selected load on
   demand through the `get_chat` command and are cached here, keyed by the view's own revision so a
   real change (a new incoming/outgoing message) invalidates the cache and a stale one does not
   re-fetch on every render. */
const chatCache = {};
function chatSummary(key) { return (V.chats || {})[key] || null; }
function ensureChatLoaded(key) {
  if (ME.role === 'parent' || !key || key === 'unknown') return;
  const cached = chatCache[key];
  if (cached && (cached.loading || cached.rev === REV)) return;
  chatCache[key] = { rev: cached ? cached.rev : -1, messages: cached ? cached.messages : [], loading: true };
  api.command('get_chat', { chatKey: key }).then((r) => {
    chatCache[key] = { rev: REV, messages: (r.result && r.result.messages) || [], loading: false };
    if (UI.phoneId === key) render();
  }).catch((e) => {
    chatCache[key] = { rev: REV, messages: (cached && cached.messages) || [], loading: false };
    if (e && e.status === 401) showLogin();
  });
}
function chatMessages(key) {
  if (ME.role === 'parent') return V.chat || [];
  ensureChatLoaded(key);
  return (chatCache[key] && chatCache[key].messages) || [];
}
function chatStateFor(key) { return ME.role === 'parent' ? V.chatState : ((V.chatStates || {})[key] || null); }
function describePickup(r) { const pk = person(r.pickupBy); if (!pk) return ''; return pk.name + (r.pickupBy === r.requestedBy ? ' (solicitante)' : ' (' + pk.relation + ')'); }
