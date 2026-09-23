import webpush from 'web-push';

/* Interface: send(subscription, payload) → resolves when the push service accepted the message, or throws an
   error with `statusCode` (404/410 = that subscription is gone for good). `subscription` is the browser's
   PushSubscription.toJSON(): { endpoint, keys: { p256dh, auth } }. */

/* Real sender: VAPID + Web Push encryption through the `web-push` package. */
export class WebPushSender {
  constructor({ vapidPublicKey, vapidPrivateKey, vapidSubject }) {
    /* Throws on malformed keys: createPushSender turns that into "push off" instead of a crash. */
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  }
  send(subscription, payload) {
    return webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 600, timeout: 5000 });
  }
}

/* The sender the server uses, or null (push off) when the keys are missing or unusable. */
export function createPushSender(config) {
  if (!config.vapidPublicKey || !config.vapidPrivateKey || !config.vapidSubject) return null;
  try { return new WebPushSender(config); }
  catch (e) { console.error('push: claves VAPID no válidas, avisos apagados:', e.message); return null; }
}

/* Test double: records what would be sent, never touches the network. `fail(status, endpoint)` makes that
   endpoint (or every one, without endpoint) answer with that HTTP status; `hang()` holds every send until `release()`. */
export class MemoryPush {
  constructor() { this.sent = []; this.failures = new Map(); this.held = null; }
  fail(statusCode, endpoint = '*') { this.failures.set(endpoint, statusCode); }
  hang() { let release; this.held = { promise: new Promise((r) => { release = r; }), release: () => release() }; }
  release() { if (this.held) { this.held.release(); this.held = null; } }
  async send(subscription, payload) {
    if (this.held) await this.held.promise;
    const status = this.failures.get(subscription.endpoint) || this.failures.get('*');
    if (status) { const e = new Error('Received unexpected response code ' + status); e.statusCode = status; throw e; }
    this.sent.push({ subscription, payload });
    return { statusCode: 201 };
  }
}
