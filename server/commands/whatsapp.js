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
        if (input.chatKey !== 'unknown' && !(await getPerson(ctx.q, input.chatKey))) notFound('chat_key_not_found');
        chatKey = input.chatKey;
      }
      if (!chatKey) badRequest('chat_key_required');
      await handleIncoming({ ...ctx, channel: 'whatsapp' }, chatKey, text);
      return { chatKey };
    },
  },
});
