import { config } from './config.js';
import {
  addMessage,
  bumpUnread,
  getConversation,
  getMessages,
  getSettings,
  touchConversation,
} from './db.js';
import { generateReply } from './ai.js';
import { matchTriggers, registerHits, triggersToAttachments, triggersToBriefing } from './triggers.js';
import { ReplyQueue } from './queue.js';

export const queue = new ReplyQueue(config.maxConcurrentReplies);

/**
 * Принимает сообщение клиента и, если автоответ включён, ставит в очередь ответ ИИ.
 *
 * @returns {{userMessage: object, reply: Promise<object|null>}}
 *   reply резолвится сообщением ассистента, либо null — если отвечает живой оператор.
 */
export function handleIncomingMessage({ hub, conversationId, text, contactName }) {
  const conversation = getConversation(conversationId);
  if (!conversation) throw new Error('Диалог не найден');

  if (contactName && contactName !== conversation.contact_name) {
    touchConversation(conversationId, { contactName: String(contactName).slice(0, 120) });
  }

  const userMessage = addMessage({ conversationId, role: 'user', content: text });
  bumpUnread(conversationId);
  hub.broadcastMessage(conversationId, userMessage);
  hub.toAdmins({ type: 'queue', ...queueStats() });

  const settings = getSettings();
  if (conversation.takeover || !settings.autoreply) {
    return { userMessage, reply: Promise.resolve(null) };
  }

  const reply = queue
    .run(conversationId, () => produceReply({ hub, conversationId, text, settings }))
    .catch((error) => {
      const failure = {
        type: 'reply_failed',
        conversationId,
        error: error.message,
        code: error.code || 'unknown',
      };
      hub.toAdmins(failure);
      hub.toConversation(conversationId, {
        type: 'error',
        error: 'Не получилось ответить прямо сейчас. Менеджер увидит сообщение и ответит здесь же.',
      });
      throw error;
    })
    .finally(() => hub.toAdmins({ type: 'queue', ...queueStats() }));

  return { userMessage, reply };
}

async function produceReply({ hub, conversationId, text, settings }) {
  // Диалог мог уйти оператору, пока сообщение ждало очереди.
  const fresh = getConversation(conversationId);
  if (!fresh || fresh.takeover) return null;

  hub.toConversation(conversationId, { type: 'typing', value: true });
  hub.toAdmins({ type: 'typing', conversationId, value: true });

  try {
    const triggers = matchTriggers(text);
    const briefing = triggersToBriefing(triggers, config.publicUrl);
    const attachments = triggersToAttachments(triggers, config.publicUrl);

    const history = getMessages(conversationId, config.historyLimit * 2);
    const { text: replyText } = await generateReply({ history, briefing, settings });

    if (triggers.length) registerHits(triggers);

    const message = addMessage({
      conversationId,
      role: 'assistant',
      content: replyText,
      attachments,
      author: settings.bot_name,
    });
    hub.broadcastMessage(conversationId, message);
    return message;
  } finally {
    hub.toConversation(conversationId, { type: 'typing', value: false });
    hub.toAdmins({ type: 'typing', conversationId, value: false });
  }
}

/** Сообщение живого оператора из админки. */
export function sendOperatorMessage({ hub, conversationId, text, author = 'Менеджер' }) {
  const message = addMessage({ conversationId, role: 'operator', content: text, author });
  hub.broadcastMessage(conversationId, message);
  return message;
}

export function queueStats() {
  return {
    inFlight: queue.inFlight,
    pending: queue.pending,
    limit: queue.limit,
  };
}
