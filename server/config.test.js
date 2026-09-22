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

test('loadConfig: SUPER_KEY, when set, has at least 24 characters; DEMO_MODE is on unless "false"', () => {
  assert.throws(() => loadConfig({ ...good, SUPER_KEY: 'clave-corta' }), /SUPER_KEY/);
  assert.equal(loadConfig({ ...good, SUPER_KEY: 'x'.repeat(24) }).superKey, 'x'.repeat(24));
  assert.equal(loadConfig(good).superKey, '', 'empty keeps /super closed');
  assert.equal(loadConfig(good).demoMode, true);
  assert.equal(loadConfig({ ...good, DEMO_MODE: 'false' }).demoMode, false);
  assert.equal(loadConfig({ ...good, DEMO_MODE: 'true' }).demoMode, true);
});
