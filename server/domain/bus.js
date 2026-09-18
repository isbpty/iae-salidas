import { getStudent, getRoute, findTrip, ensureTrip, upsertBoarding, insertOptOut, patchRow, getStaff, getPerson, listRequests, listStaff, listLevels } from '../db/repo.js';
import { minutesOf, nowHHMM, todayISO } from './time.js';
import { fmtTime, fmtClock, firstName, LEG_NAMES, roleName } from './text.js';
import { notifyPerson, notifyRole, notifyStaff, logEvent } from './notifications.js';
import { describePickup } from './requests.js';
import { conflict, notFound, badRequest } from './errors.js';

const EMPTY_TRIP = () => ({ status: 'programado', boarded: {}, noBus: [] });
export const currentLeg = (ctx, r) => ctx.gps.position(r, ctx);
export function nextLegInfo(ctx, r) {
  const now = minutesOf(nowHHMM(ctx.now, ctx.tz));
  for (const leg of ['ida', 'vuelta']) if (now < minutesOf(r.schedule[leg].start)) return LEG_NAMES[leg] + ' a las ' + fmtTime(r.schedule[leg].start);
  return 'ida mañana a las ' + fmtTime(r.schedule.ida.start);
}
export const legStops = (r, leg) => (leg === 'ida' ? r.stops.slice().reverse() : r.stops);
export function busPosition(r, leg, progress) {
  const stops = legStops(r, leg); const n = stops.length;
  const segF = Math.min(0.999, Math.max(0, progress)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(segF)); const f = segF - i;
  const a = stops[i]; const b = stops[i + 1];
  const total = minutesOf(r.schedule[leg].end) - minutesOf(r.schedule[leg].start);
  return {
    lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, prevStop: a, nextStop: b, index: i, frac: f, stops,
    minutesLeft: Math.round((1 - progress) * total),
    etaTo: (stop) => { const j = stops.findIndex((s) => s.id === stop.id); return Math.max(0, Math.round(((j - i - f) / (n - 1)) * total)); },
  };
}
export async function busStatusFor(ctx, st) {
  const r = st.routeId ? await getRoute(ctx.q, st.routeId) : null;
  if (!r) return null;
  const cur = currentLeg(ctx, r);
  if (!cur) return { r, active: false };
  const trip = (await findTrip(ctx.q, todayISO(ctx.now, ctx.tz), r.id, cur.leg)) || EMPTY_TRIP();
  return { r, active: true, leg: cur.leg, trip, rec: trip.boarded[st.id], noBus: trip.noBus.includes(st.id), stop: r.stops.find((s) => s.id === st.stopId), pos: busPosition(r, cur.leg, cur.progress), progress: cur.progress, simulated: cur.simulated };
}
export async function whereIs(ctx, studentId) {
  const st = await getStudent(ctx.q, studentId);
  if (!st) notFound('student_not_found');
  const today = todayISO(ctx.now, ctx.tz);
  const todays = await listRequests(ctx.q, { studentIds: [studentId], date: today, kind: 'salida' });
  const exit = todays.find((x) => x.status === 'retirado');
  if (exit) {
    const off = await getStaff(ctx.q, exit.exitBy);
    const pk = await getPerson(ctx.q, exit.pickupBy);
    return { text: '🚪 ' + firstName(st.name) + ' salió por ' + exit.pickupPoint + ' a las ' + fmtClock(ctx, exit.exitAt) + ', retirado(a) por ' + describePickup(exit, pk) + '. Confirmó ' + off.name + ' (' + (off.title || roleName(off.role)) + ').' };
  }
  const appr = todays.find((x) => x.status === 'aprobada');
  const apprTxt = appr ? ' Tiene salida aprobada a las ' + fmtTime(appr.time) + ' por ' + appr.pickupPoint + ', aún no ha salido.' : '';
  const bus = await busStatusFor(ctx, st);
  if (bus && bus.active) {
    const r = bus.r; const mon = await getStaff(ctx.q, r.monitorId);
    if (bus.noBus) return { text: '🚌 Hoy ' + firstName(st.name) + ' no va en el ' + r.name + ' (avisado por la familia).' + (apprTxt || ' Está en el plantel.') };
    if (bus.rec && bus.rec.status === 'abordo') {
      const eta = bus.stop ? bus.pos.etaTo(bus.stop) : bus.pos.minutesLeft;
      return {
        text: '🚌 ' + firstName(st.name) + ' va en el ' + r.name + ' (placa ' + r.plate + '), ' + LEG_NAMES[bus.leg] + '. Abordó a las ' + fmtClock(ctx, bus.rec.ts) + '.\n📍 Próxima parada: ' + bus.pos.nextStop.name + (bus.stop ? (eta > 0 ? '\n🏁 Llega a ' + bus.stop.name + ' en ~' + eta + ' min' : '\n🏁 Está llegando a ' + bus.stop.name) : '') + '\n👩 Monitora: ' + (mon ? mon.name : '—'),
        location: { lat: bus.pos.lat, lng: bus.pos.lng, routeId: r.id, leg: bus.leg, progress: bus.progress, label: r.name + ' · ' + LEG_NAMES[bus.leg] + (bus.simulated ? ' · GPS simulado' : ' · GPS en vivo') },
      };
    }
    if (bus.rec && bus.rec.status === 'bajo') {
      const monBy = await getStaff(ctx.q, bus.rec.by);
      return { text: '✅ ' + firstName(st.name) + ' bajó del ' + r.name + ' en ' + ((r.stops.find((s) => s.id === bus.rec.stopId) || {}).name || 'su parada') + ' a las ' + fmtClock(ctx, bus.rec.ts) + '. Lo confirmó la monitora ' + monBy.name + '.' };
    }
    if (bus.rec && bus.rec.status === 'no_abordo') return { text: '⚠️ La monitora marcó que ' + firstName(st.name) + ' NO abordó el ' + r.name + ' (' + fmtClock(ctx, bus.rec.ts) + ').' + (apprTxt || ' Contacta a recepción al ' + ctx.settings.school.phone + '.') };
    return { text: '⏳ El ' + r.name + ' está en ruta, pero la monitora aún no ha marcado a ' + firstName(st.name) + ' a bordo.' + (apprTxt || ' Si no lo esperabas, llama a recepción al ' + ctx.settings.school.phone + '.') };
  }
  const now = minutesOf(nowHHMM(ctx.now, ctx.tz));
  if (now >= minutesOf(ctx.settings.schoolStart) && now <= minutesOf(ctx.settings.schoolEnd)) {
    const tch = (await listStaff(ctx.q)).find((s) => s.role === 'profesor' && (s.grades || []).includes(st.grade));
    const lv = (await listLevels(ctx.q)).find((l) => l.id === st.levelId);
    return { text: '🏫 ' + firstName(st.name) + ' está en el plantel · ' + st.grade + ' ' + (lv ? lv.name : st.levelId) + (tch ? ' · ' + tch.name : '') + '.' + apprTxt };
  }
  return { text: '🕒 Fuera de horario escolar. No hay registro de salida especial de ' + firstName(st.name) + ' hoy.' + (bus && bus.r ? ' Próximo viaje del ' + bus.r.name + ': ' + nextLegInfo(ctx, bus.r) + '.' : '') };
}
export async function markBoarding(ctx, routeId, leg, studentId, status, byStaffId, stopId) {
  if (!LEG_NAMES[leg]) badRequest('invalid_leg');
  if (!['abordo', 'bajo', 'no_abordo'].includes(status)) badRequest('invalid_status');
  const st = await getStudent(ctx.q, studentId); const r = await getRoute(ctx.q, routeId);
  if (!st || !r) notFound('student_or_route_not_found');
  if (st.routeId !== r.id) conflict('student_not_on_route');
  const trip = await ensureTrip(ctx.q, todayISO(ctx.now, ctx.tz), r.id, leg);
  await upsertBoarding(ctx.q, trip.id, studentId, { status, stopId: stopId || null, by: byStaffId, at: ctx.now });
  const verb = status === 'abordo' ? 'Marcó a bordo' : status === 'bajo' ? 'Marcó que bajó' : 'Marcó NO abordó';
  await logEvent(ctx, verb + ' a ' + st.name + ' · ' + r.name + ' ' + LEG_NAMES[leg], (await getStaff(ctx.q, byStaffId)).name);
  if (status === 'no_abordo') await notifyRole(ctx, 'recepcion', st.name + ' no abordó el ' + r.name + ' (' + LEG_NAMES[leg] + ')');
  return findTrip(ctx.q, trip.date, r.id, leg);
}
export async function setTripStatus(ctx, routeId, leg, status, byStaffId) {
  if (!LEG_NAMES[leg]) badRequest('invalid_leg');
  if (!['programado', 'en_ruta', 'finalizado'].includes(status)) badRequest('invalid_status');
  const r = await getRoute(ctx.q, routeId);
  if (!r) notFound('route_not_found');
  const trip = await ensureTrip(ctx.q, todayISO(ctx.now, ctx.tz), r.id, leg);
  const patch = { status };
  if (status === 'en_ruta') patch.startedAt = ctx.now;
  if (status === 'finalizado') patch.endedAt = ctx.now;
  await patchRow(ctx.q, 'trips', trip.id, patch);
  await logEvent(ctx, (status === 'en_ruta' ? 'Inició' : status === 'finalizado' ? 'Finalizó' : 'Programó') + ' el viaje ' + r.name + ' ' + LEG_NAMES[leg], (await getStaff(ctx.q, byStaffId)).name);
  return findTrip(ctx.q, trip.date, r.id, leg);
}
export async function markNoBus(ctx, studentId, personId, legs) {
  const st = await getStudent(ctx.q, studentId);
  if (!st) notFound('student_not_found');
  const r = st.routeId ? await getRoute(ctx.q, st.routeId) : null;
  if (!r) conflict('no_bus_route');
  const today = todayISO(ctx.now, ctx.tz);
  for (const leg of legs) { const trip = await ensureTrip(ctx.q, today, r.id, leg); await insertOptOut(ctx.q, trip.id, studentId, personId, ctx.now); }
  const by = await getPerson(ctx.q, personId);
  await logEvent(ctx, 'Avisó que ' + st.name + ' hoy no va en el ' + r.name + ' (' + legs.join(', ') + ')', by.name);
  await notifyStaff(ctx, r.monitorId, '🚌 ' + st.name + ' hoy no va en el bus (' + legs.join(', ') + ') · avisó ' + by.name);
  for (const t of st.titulares.filter((x) => x !== personId)) await notifyPerson(ctx, t, 'ℹ️ ' + by.name + ' avisó que ' + firstName(st.name) + ' hoy no va en el ' + r.name + ' (' + legs.join(', ') + ').');
  return { route: r, legs };
}
