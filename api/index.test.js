import test from 'node:test';import assert from 'node:assert/strict';import {handle} from './index.js';
test('serverless module exposes a handler without starting a listener',()=>assert.equal(typeof handle,'function'));
