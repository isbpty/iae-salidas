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

test('loadConfig: a SUPER_KEY under 24 characters closes /super without crashing; DEMO_MODE is on unless "false"', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const short = loadConfig({ ...good, SUPER_KEY: 'clave-corta' });
  assert.equal(short.superKey, '', 'the short key is never usable');
  assert.equal(short.superKeyError, 'super_key_too_short');
  assert.equal(warn.mock.callCount(), 1);
  const long = loadConfig({ ...good, SUPER_KEY: 'x'.repeat(24) });
  assert.equal(long.superKey, 'x'.repeat(24)); assert.equal(long.superKeyError, null);
  assert.equal(loadConfig(good).superKey, '', 'empty keeps /super closed');
  assert.equal(loadConfig(good).superKeyError, null);
  assert.equal(loadConfig(good).demoMode, true);
  assert.equal(loadConfig({ ...good, DEMO_MODE: 'false' }).demoMode, false);
  assert.equal(loadConfig({ ...good, DEMO_MODE: 'true' }).demoMode, true);
});
