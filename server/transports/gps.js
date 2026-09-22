import { minutesOf, nowHHMM } from '../domain/time.js';

/* Interface: position(route, ctx) → { leg, progress (0..1), rate (progress per ms), simulated } or null when the bus
   is not on the road. `rate` lets the client move the bus smoothly between two polls. */
const DEMO_CYCLE_MS = 10 * 60 * 1000; // in demo mode the bus completes the route every 10 minutes and starts again

export class SimulatedGps {
  position(route, ctx) {
    if (ctx.settings.simulateBus) {
      const base = Number(ctx.settings.busProgress) || 0;
      const progress = (base + (ctx.now.getTime() % DEMO_CYCLE_MS) / DEMO_CYCLE_MS) % 1;
      return { leg: 'vuelta', progress, rate: 1 / DEMO_CYCLE_MS, simulated: true };
    }
    const now = minutesOf(nowHHMM(ctx.now, ctx.tz));
    for (const leg of ['ida', 'vuelta']) {
      const w = route.schedule[leg]; const a = minutesOf(w.start); const b = minutesOf(w.end);
      if (now >= a && now <= b) return { leg, progress: (now - a) / (b - a), rate: 1 / ((b - a) * 60000), simulated: false };
    }
    return null;
  }
}
