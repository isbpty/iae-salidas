import test from 'node:test';import assert from 'node:assert/strict';import {WhatsAppBridge} from './whatsapp-bridge.js';
test('simulator mode never starts a real WhatsApp session',async()=>{const b=new WhatsAppBridge({mode:'simulator'});assert.deepEqual(await b.start(),{status:'simulator'});await assert.rejects(()=>b.send('x','y'),/whatsapp_not_connected/)});
