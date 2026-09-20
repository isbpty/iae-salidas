import { minutesOf, nowHHMM } from '../domain/time.js';

/* Interface: position(route, ctx) → { leg, progress (0..1), simulated } or null when the bus is not on the road. */
export class SimulatedGps {
  position(route, ctx) {
    if (ctx.settings.simulateBus) return { leg: 'vuelta', progress: Number(ctx.settings.busProgress) || 0, simulated: true };
    const now = minutesOf(nowHHMM(ctx.now, ctx.tz));
    for (const leg of ['ida', 'vuelta']) {
      const w = route.schedule[leg]; const a = minutesOf(w.start); const b = minutesOf(w.end);
      if (now >= a && now <= b) return { leg, progress: (now - a) / (b - a), simulated: false };
    }
    return null;
  }
}
