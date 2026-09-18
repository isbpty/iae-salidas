import test from 'node:test';
import assert from 'node:assert/strict';
import { todayISO, nowHHMM, shiftISO, minutesOf, addMinutes, localToMs, partsIn } from './time.js';

const TZ = 'America/Panama'; // UTC-5, no DST
const now = new Date('2026-09-18T15:30:00Z'); // 10:30 in Panama

test('todayISO and nowHHMM use the school time zone', () => {
  assert.equal(todayISO(now, TZ), '2026-09-18');
  assert.equal(nowHHMM(now, TZ), '10:30');
  assert.equal(todayISO(new Date('2026-09-19T03:00:00Z'), TZ), '2026-09-18'); // still the 18th in Panama
});

test('partsIn never returns hour 24', () => {
  assert.equal(partsIn(new Date('2026-09-18T05:00:00Z'), TZ).time, '00:00');
});

test('shiftISO moves whole days', () => {
  assert.equal(shiftISO(now, TZ, 1), '2026-09-19');
  assert.equal(shiftISO(now, TZ, -1), '2026-09-17');
});

test('minutesOf and addMinutes wrap around midnight', () => {
  assert.equal(minutesOf('07:20'), 440);
  assert.equal(addMinutes('23:50', 20), '00:10');
  assert.equal(addMinutes('00:10', -20), '23:50');
});

test('localToMs converts a wall-clock time in the school zone to an instant', () => {
  assert.equal(localToMs('2026-09-18', '10:30', TZ), now.getTime());
});
