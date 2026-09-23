import { register } from './index.js';
import { handleIncoming } from '../bot/conversation.js';
import { getPerson, listChat } from '../db/repo.js';
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
  /* R3: the admin view now only carries a summary per chat (`listChatSummaries`); this loads the
     full transcript for one phone on demand, when the admin actually picks it in the simulator.
     Same demo-only gate as `whatsapp_inbound`'s "foreign chat" case -- an admin has no chat of their
     own, so every chat it reads here is, by definition, someone else's real WhatsApp history. */
  get_chat: {
    roles: ['admin'],
    bump: false,
    handler: async (ctx, input) => {
      const chatKey = input.chatKey;
      if (!chatKey) badRequest('chat_key_required');
      if (ctx.config.demoMode === false) deny('demo_only');
      if (chatKey !== 'unknown' && !(await getPerson(ctx.q, chatKey))) notFound('chat_key_not_found');
      return { chatKey, messages: await listChat(ctx.q, chatKey) };
    },
  },
});
