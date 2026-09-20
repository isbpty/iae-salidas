export const pad = (n) => String(n).padStart(2, '0');
const formatters = new Map();
function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  }
  return formatters.get(tz);
}
export function partsIn(now, tz) {
  const p = {};
  for (const part of formatter(tz).formatToParts(now)) p[part.type] = part.value;
  const h = Number(p.hour) % 24;
  return { y: +p.year, m: +p.month, d: +p.day, h, mi: +p.minute, date: `${p.year}-${p.month}-${p.day}`, time: `${pad(h)}:${p.minute}` };
}
export const todayISO = (now, tz) => partsIn(now, tz).date;
export const nowHHMM = (now, tz) => partsIn(now, tz).time;
export function shiftISO(now, tz, days) {
  const p = partsIn(now, tz);
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export function minutesOf(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
export function addMinutes(hhmm, n) {
  const t = ((minutesOf(hhmm) + n) % 1440 + 1440) % 1440;
  return pad(Math.floor(t / 60)) + ':' + pad(t % 60);
}
function offsetMinutes(ms, tz) {
  const p = partsIn(new Date(ms), tz);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - ms) / 60000);
}
export function localToMs(dateISO, hhmm, tz) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  return guess - offsetMinutes(guess, tz) * 60000;
}
export function weekdayOf(dateISO) { return new Date(dateISO + 'T00:00:00Z').getUTCDay(); }
