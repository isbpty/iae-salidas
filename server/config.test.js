import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

const good = { SESSION_SECRET: 'x'.repeat(32), PILOT_PIN: '4321' };

test('loadConfig requires a long SESSION_SECRET', () => {
  assert.throws(() => loadConfig({ ...good, SESSION_SECRET: 'short' }), /SESSION_SECRET/);
  assert.throws(() => loadConfig({ PILOT_PIN: '1' }), /SESSION_SECRET/);
});

test('loadConfig requires PILOT_PIN', () => {
  assert.throws(() => loadConfig({ SESSION_SECRET: good.SESSION_SECRET }), /PILOT_PIN/);
});

test('loadConfig falls back to PGlite locally but requires DATABASE_URL on Vercel', () => {
  assert.equal(loadConfig(good).sharedPin, false, 'shared PIN is off unless asked for');
  assert.equal(loadConfig({ ...good, PILOT_PIN_SHARED: 'true' }).sharedPin, true);
  const local = loadConfig(good);
  assert.equal(local.databaseUrl, null);
  assert.equal(local.dataDir, 'data/pglite');
  assert.equal(local.serverless, false);
  assert.throws(() => loadConfig({ ...good, VERCEL: '1' }), /DATABASE_URL/);
  const vercel = loadConfig({ ...good, VERCEL: '1', DATABASE_URL: 'postgres://u:p@h/db' });
  assert.equal(vercel.serverless, true);
  assert.equal(vercel.secure, true);
});
