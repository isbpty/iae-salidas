import { pad, todayISO, shiftISO, weekdayOf, isValidDate } from '../domain/time.js';
import { firstName } from '../domain/text.js';

export const REL_WORDS = {
  abuela: 'abuela', abuelo: 'abuelo', tia: 'tía', tio: 'tío', mama: 'mamá', madre: 'mamá', papa: 'papá', padre: 'papá',
  hermano: 'hermano', hermana: 'hermana', nana: 'nana', ninera: 'niñera', chofer: 'chofer', vecina: 'vecina', vecino: 'vecino', prima: 'prima', primo: 'primo',
};
export function normalize(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim(); }

export function parseTime(n) {
  let m, h, mm = 0, ap = '';
  n = n.replace(/de la manana/g, 'am').replace(/de la tarde|de la noche/g, 'pm').replace(/(\d)\s*(pm|am)/g, '$1 $2');
  if (/\bmediodia\b/.test(n)) return '12:00';
  /* The 3-4 digit branch below used to grab a bare year out of a dd/mm/yyyy date ("25/09/2026" -> h=20
     mm=26, L14): a run of digits directly touching a "/" is a year, never a bare HHmm time, so it's
     excluded here with a lookbehind/lookahead instead of being matched as one. */
  if ((m = n.match(/\b(\d{1,2})[:.h](\d{2})\s*(am|pm|a\.m\.?|p\.m\.?)?/))) { h = +m[1]; mm = +m[2]; ap = m[3] || ''; }
  else if ((m = n.match(/(?<![\d/])\b(\d{3,4})\s*(am|pm|a\.m\.?|p\.m\.?)?\b(?!\/)/))) { const d = m[1]; h = +d.slice(0, d.length - 2); mm = +d.slice(-2); ap = m[2] || ''; }
  /* "a las 3 y media" / "a las 3 y cuarto": the half/quarter modifier sets the minutes that the plain
     "a las X" form otherwise drops on the floor (L14: "a las 3 y media" used to land on 15:00). */
  else if ((m = n.match(/\b(?:a las|a la|las|la|hora)\s+(\d{1,2})(?:\s+y\s+(media|cuarto))?\b\s*(am|pm|a\.m\.?|p\.m\.?)?/))) { h = +m[1]; mm = m[2] === 'media' ? 30 : m[2] === 'cuarto' ? 15 : 0; ap = m[3] || ''; }
  else if ((m = n.match(/\b(\d{1,2})\s*(am|pm|a\.m\.?|p\.m\.?)\b/))) { h = +m[1]; ap = m[2]; }
  else return null;
  if (isNaN(h) || h > 23 || mm > 59) return null;
  if (/p/.test(ap) && h < 12) h += 12;
  if (/a/.test(ap) && h === 12) h = 0;
  if (!ap && h <= 6) h += 12; // sin am/pm: se asume tarde
  return pad(h) + ':' + pad(mm);
}
export function parseDate(n, ctx) {
  /* "mañana" means both "tomorrow" and "(in the) morning" in Spanish. "hoy en la mañana"/"de la
     mañana" is always the time-of-day sense, never "tomorrow" -- strip it (keeping a bare "hoy" when
     present) before the \bmanana\b check below, or "hoy en la mañana" used to resolve to tomorrow
     (L14). */
  const t = n.replace(/\b(?:hoy\s+)?(?:en|de)\s+la\s+manana\b/g, (mm) => (/^hoy/.test(mm) ? 'hoy' : ''));
  const today = todayISO(ctx.now, ctx.tz);
  if (/pasado manana/.test(t)) return shiftISO(ctx.now, ctx.tz, 2);
  if (/\bmanana\b/.test(t)) return shiftISO(ctx.now, ctx.tz, 1);
  const m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/);
  if (m) {
    const d = +m[1], mo = +m[2];
    /* Validate day/month before building a date: "el 15/30" used to produce the nonsense string
       "2026-30-15" (L14) instead of being rejected. An explicit year is trusted as-is; a bare dd/mm
       rolls to next year when that day already passed this year ("el 5/1" in September means next
       January, not the one that already happened). */
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      let year = m[3] ? +m[3] : +today.slice(0, 4);
      let iso = year + '-' + pad(mo) + '-' + pad(d);
      if (!m[3] && isValidDate(iso) && iso < today) { year += 1; iso = year + '-' + pad(mo) + '-' + pad(d); }
      if (isValidDate(iso)) return iso;
    }
  }
  const days = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  for (let i = 0; i < 7; i++) {
    if (new RegExp('\\bel ' + days[i] + '\\b').test(t)) {
      let diff = (i - weekdayOf(today) + 7) % 7;
      if (diff === 0) diff = 7;
      return shiftISO(ctx.now, ctx.tz, diff);
    }
  }
  return today;
}
export function matchKid(n, kids) {
  const found = kids.filter((k) => new RegExp('\\b' + normalize(firstName(k.name)) + '\\b').test(n));
  if (found.length === 1) return found[0].id;
  if (found.length > 1) return null;
  if (/\bmi hija\b/.test(n)) { const f = kids.filter((k) => k.emoji === '👧' || k.emoji === '👩‍🎓'); if (f.length === 1) return f[0].id; }
  if (/\bmi hijo\b/.test(n)) { const f = kids.filter((k) => k.emoji === '👦' || k.emoji === '🧒'); if (f.length === 1) return f[0].id; }
  if (kids.length === 1) return kids[0].id;
  return null;
}
export function extractPickupHint(n) {
  if (/\b(lo|la|los|las)?\s?(retiro|recojo|busco|paso)\s+yo\b|\byo\s+(lo|la)\s+(retiro|recojo|busco)\b/.test(n)) return 'yo';
  // "al mediodía" used to be read as the name of who picks up (L14): "al" and "mediodia" are time
  // words, never a person, so they never count as a captured hint.
  const stop = ['hoy', 'manana', 'a', 'al', 'las', 'la', 'el', 'temprano', 'de', 'en', 'por', 'y', 'que', 'mi', 'su', 'mediodia'];
  // Deviation from the brief: added `\b` after the optional article/possessive group. Without it, the
  // "la" alternative matches the first two letters of a following capitalized name like "Laura", so
  // "Hoy retira a Joseph Laura Gómez a las 2 pm" captured "ura gomez" instead of "laura gomez" (verified
  // against the brief's own nlp.test.js). The `\b` forces that group to only consume a standalone word.
  const re = /(?:lo|la|los|las)?\s?(?:va a retirar|van a retirar|retira|retirara|recoge|recogera|busca|buscara|pasa a buscar|va a buscar|va a recoger|retirar[aá]?)\s+(?:a\s+\w+\s+)?(?:su|mi|la|el|los|las|nuestra|nuestro)?\b\s*([a-z]+(?:\s[a-z]+)?)/g;
  let m;
  while ((m = re.exec(n))) {
    const w = m[1].trim();
    const first = w.split(' ')[0];
    if (stop.includes(first) || /^\d/.test(first)) continue;
    const parts = w.split(' ');
    return parts.length > 1 && (stop.includes(parts[1]) || /^\d/.test(parts[1])) ? first : w;
  }
  const rel = Object.keys(REL_WORDS).find((r) => new RegExp('\\b(su|la|el|mi)\\s+' + r + '\\b').test(n));
  return rel || null;
}
export function detectIntent(n) {
  if (/^(hola|buenas|buenos dias|buenas tardes|menu|ayuda|hi)\b/.test(n)) return 'saludo';
  if (/\b(estado|mis solicitudes|estatus|status)\b/.test(n)) return 'estado';
  if (/\bcancelar\b/.test(n)) return 'cancelar';
  if (/no (va|ira|viaja|se va|toma|tomara|usa|usara|sube|subira)( a ir)?( hoy| manana)?( en| al| el)?( el)? bus|sin bus|no bus/.test(n)) return 'nobus';
  if (/donde (esta|estan|anda|va|queda)|\bdonde\b|ubicaci|en que bus|en el bus|ya (llego|salio|paso|bajo)|localiza|rastre|posicion|gps/.test(n)) return 'donde';
  // "falta"/"ausencia" wins over a stray "permiso" ("faltará mañana, pido permiso" is an excusa, not a
  // salida, L14): checked before the salida test so it always takes priority over it.
  if (/falt|ausen/.test(n)) return 'excusa';
  if (/retir|salir|salida|recog|busc|sacar|temprano|permiso/.test(n)) return 'salida';
  if (/no (va|ira|asistira|vendra|podra|puede)|falt|ausen|excusa|enferm|cita|tardanza|llegara tarde|llega tarde|reposo|fiebre|justific/.test(n)) return 'excusa';
  return 'desconocido';
}
