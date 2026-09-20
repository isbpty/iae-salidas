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

test('parseDate: hoy, mañana, pasado mañana, weekday and dd/mm', () => {
  assert.equal(parseDate(normalize('hoy'), ctx), '2026-09-18');
  assert.equal(parseDate(normalize('mañana'), ctx), '2026-09-19');
  assert.equal(parseDate(normalize('pasado mañana'), ctx), '2026-09-20');
  assert.equal(parseDate(normalize('el lunes'), ctx), '2026-09-21');
  assert.equal(parseDate(normalize('el viernes'), ctx), '2026-09-25', 'same weekday means next week');
  assert.equal(parseDate(normalize('el 3/10'), ctx), '2026-10-03');
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
