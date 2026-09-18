import { insertChat, countPendingOut } from '../db/repo.js';

/* Interface every WhatsApp transport implements: send(ctx, chatKey, { text, buttons, location, typing }).
   The simulator writes into chat_messages; the web chat renders them. A real provider would call its API here. */
export class SimulatorTransport {
  async send(ctx, chatKey, message) {
    let pendingUntil = null;
    if (message.typing) {
      const pending = await countPendingOut(ctx.q, chatKey, ctx.now);
      pendingUntil = new Date(ctx.now.getTime() + 700 + 400 * pending);
    }
    await insertChat(ctx.q, { chatKey, direction: 'out', text: message.text, buttons: message.buttons || null, location: message.location || null, pendingUntil }, ctx.now);
  }
}
