import { register } from './index.js';
import { handleIncoming } from '../bot/conversation.js';
import { getPerson } from '../db/repo.js';
import { deny, notFound, badRequest } from '../domain/errors.js';

register({
  whatsapp_inbound: {
    roles: ['parent', 'admin'],
    handler: async (ctx, input) => {
      const text = String(input.text || '').trim().slice(0, 500);
      if (!text) badRequest('text_required');
      let chatKey = ctx.person ? ctx.person.id : null;
      if (input.chatKey) {
        if (ctx.user.role !== 'admin' && input.chatKey !== chatKey) deny('forbidden_chat_key');
        /* Writing on somebody else's chat (the simulator's phone) would let an admin answer "Sí, confirmo"
           for a titular: demo mode only. */
        if (input.chatKey !== chatKey && ctx.config.demoMode === false) deny('demo_only');
        if (input.chatKey !== 'unknown' && !(await getPerson(ctx.q, input.chatKey))) notFound('chat_key_not_found');
        chatKey = input.chatKey;
      }
      if (!chatKey) badRequest('chat_key_required');
      await handleIncoming({ ...ctx, channel: 'whatsapp' }, chatKey, text);
      return { chatKey };
    },
  },
});
