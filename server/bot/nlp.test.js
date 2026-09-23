import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, parseTime, parseDate, matchKid, extractPickupHint, detectIntent } from './nlp.js';

const ctx = { now: new Date('2026-09-18T15:30:00Z'), tz: 'America/Panama' }; // Friday 18 Sep 2026
const kids = [{ id: 'e1', name: 'Joseph Rodríguez', emoji: '👦' }, { id: 'e2', name: 'Sofía Rodríguez', emoji: '👧' }];

test('parseTime understands the prototype formats', () => {
  assert.equal(parseTime(normalize('a las 3:30 pm')), '15:30');
  assert.equal(parseTime(normalize('a las 11')), '11:00');
  assert.equal(parseTime(normalize('a las 2')), '14:00', 'no am/pm and ≤ 6 means afternoon');
  assert.equal(parseTime(normalize('1545')), '15:45');
  assert.equal(parseTime(normalize('12 am')), '00:00');
  assert.equal(parseTime(normalize('sin hora')), null);
});

test('parseTime (L14): "y media"/"y cuarto", mediodía, and a year is never read as the time', () => {
  assert.equal(parseTime(normalize('a las 3 y media')), '15:30', 'no am/pm, ≤6 means afternoon, same as plain "a las 3"');
  assert.equal(parseTime(normalize('a las 3 y cuarto')), '15:15');
  assert.equal(parseTime(normalize('a las 11 y media')), '11:30');
  assert.equal(parseTime(normalize('al mediodía')), '12:00');
  assert.equal(parseTime(normalize('mediodía')), '12:00');
  assert.equal(parseTime(normalize('el 25/09/2026 a las 2 pm')), '14:00', 'the 2026 year is not swallowed as 20:26');
});

test('parseDate: hoy, mañana, pasado mañana, weekday and dd/mm', () => {
  assert.equal(parseDate(normalize('hoy'), ctx), '2026-09-18');
  assert.equal(parseDate(normalize('mañana'), ctx), '2026-09-19');
  assert.equal(parseDate(normalize('pasado mañana'), ctx), '2026-09-20');
  assert.equal(parseDate(normalize('el lunes'), ctx), '2026-09-21');
  assert.equal(parseDate(normalize('el viernes'), ctx), '2026-09-25', 'same weekday means next week');
  assert.equal(parseDate(normalize('el 3/10'), ctx), '2026-10-03');
});

test('parseDate (L14): year in dates, dd/mm validated with next-year rollover, and "en/hoy la mañana" is not "mañana" (tomorrow)', () => {
  assert.equal(parseDate(normalize('el 25/09/2026 a las 2 pm'), ctx), '2026-09-25', 'an explicit year is trusted as-is');
  assert.equal(parseDate(normalize('el 15/30'), ctx), '2026-09-18', 'month 30 is invalid -- falls back to today instead of "2026-30-15"');
  assert.equal(parseDate(normalize('el 5/1'), ctx), '2027-01-05', 'Jan 5 2026 already passed -- rolls to next year');
  assert.equal(parseDate(normalize('hoy en la mañana'), ctx), '2026-09-18', '"en la mañana" is a time of day, not "mañana" (tomorrow)');
  assert.equal(parseDate(normalize('en la mañana'), ctx), '2026-09-18');
  assert.equal(parseDate(normalize('a las 8 de la mañana'), ctx), '2026-09-18');
  assert.equal(parseDate(normalize('mañana en la mañana'), ctx), '2026-09-19', 'the bare "mañana" (tomorrow) is untouched');
});

test('matchKid by name, by gender word or by being the only child', () => {
  assert.equal(matchKid(normalize('retirar a Joseph'), kids), 'e1');
  assert.equal(matchKid(normalize('mi hija'), kids), 'e2');
  assert.equal(matchKid(normalize('mi hijo'), kids), 'e1');
  assert.equal(matchKid(normalize('retirar temprano'), kids), null);
  assert.equal(matchKid(normalize('retirar temprano'), [kids[0]]), 'e1');
});

test('extractPickupHint and detectIntent', () => {
  assert.equal(extractPickupHint(normalize('A Joseph lo retira la abuela a las 2 pm')), 'abuela');
  assert.equal(extractPickupHint(normalize('Hoy retira a Joseph Laura Gómez a las 2 pm')), 'laura gomez');
  assert.equal(extractPickupHint(normalize('lo retiro yo')), 'yo');
  assert.equal(extractPickupHint(normalize('necesito retirar a joseph hoy a las 3 pm')), null);
  assert.equal(detectIntent(normalize('Hola')), 'saludo');
  assert.equal(detectIntent(normalize('Estado')), 'estado');
  assert.equal(detectIntent(normalize('Sofía hoy no va en el bus')), 'nobus');
  assert.equal(detectIntent(normalize('¿Dónde está Joseph?')), 'donde');
  assert.equal(detectIntent(normalize('Necesito retirar a Joseph hoy a las 3:30 pm')), 'salida');
  assert.equal(detectIntent(normalize('Emily no irá mañana, tiene cita médica')), 'excusa');
  assert.equal(detectIntent(normalize('cancelar')), 'cancelar');
  assert.equal(detectIntent(normalize('xyz')), 'desconocido');
});

test('extractPickupHint (L14): "al mediodía" is a time, never read as the name of who picks up', () => {
  assert.equal(extractPickupHint(normalize('Necesito retirar a Joseph al mediodía')), null);
});

test('detectIntent (L14): "busca"/"recoge" are salida, and falta/ausencia + permiso is excusa, not salida', () => {
  assert.equal(detectIntent(normalize('Hoy la busca su tía Marta')), 'salida');
  assert.equal(detectIntent(normalize('Joseph lo recoge su tío hoy')), 'salida');
  assert.equal(detectIntent(normalize('Joseph faltará mañana, pido permiso')), 'excusa');
});
