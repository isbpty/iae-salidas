import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionToken, verifySession, cookieValue } from './session.js';

test('signed sessions reject tampering and expiry', () => {
  const token = sessionToken('u_s1', 'secret');
  assert.equal(verifySession(token, 'secret').userId, 'u_s1');
  assert.equal(verifySession(token + 'x', 'secret'), null);
  assert.equal(verifySession(token, 'other'), null);
  assert.equal(verifySession(sessionToken('u_s1', 'secret', -1), 'secret'), null);
});

test('cookieValue reads one cookie among many', () => {
  assert.equal(cookieValue('a=1; iae_session=abc.def; b=2', 'iae_session'), 'abc.def');
  assert.equal(cookieValue(undefined, 'iae_session'), null);
});
