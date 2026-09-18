import test from 'node:test';
import assert from 'node:assert/strict';
import { camel } from './rows.js';

test('camel converts snake_case keys and Date values', () => {
  const at = new Date('2026-09-18T15:30:00Z');
  assert.deepEqual(camel({ student_id: 'e1', created_at: at, bus_legs: ['ida'] }), { studentId: 'e1', createdAt: at.getTime(), busLegs: ['ida'] });
  assert.equal(camel(null), null);
});
