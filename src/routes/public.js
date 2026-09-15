import express from 'express';
import { config } from '../config.js';
import {
  addMessage,
  findOrCreateConversation,
  getConversation,
  getMessages,
  getSettings,
  useApiKey,
} from '../db.js';
import { handleIncomingMessage } from '../chat.js';

export function publicRoutes(hub) {
  const router = express.Router();

  /** Настройки внешнего вида для виджета — без чувствительных полей. */
  router.get('/widget-config', (req, res) => {
    const s = getSettings();
    res.json({
      botName: s.bot_name,
      botRole: s.bot_role,
      avatarUrl: s.avatar_url,
      greeting: s.greeting,
      disclosure: s.disclosure_line,
      title: s.widget_title,
      color: s.widget_color,
      position: s.widget_position,
    });
  });

  /** Открыть (или продолжить) диалог из виджета. */
  router.post('/conversations', (req, res) => {
    const { visitorId, contactName, channel = 'widget', meta = {} } = req.body || {};
    const conversation = findOrCreateConversation({
      channel: String(channel).slice(0, 40),
      externalId: visitorId ? String(visitorId).slice(0, 120) : undefined,
      contactName: contactName ? String(contactName).slice(0, 120) : '',
      contactMeta: meta,
    });
    res.json({
      conversationId: conversation.id,
      messages: getMessages(conversation.id, 100),
    });
  });

  router.get('/conversations/:id/messages', (req, res) => {
    const conversation = getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Диалог не найден' });
    res.json({ messages: getMessages(conversation.id, 200) });
  });

  /**
   * Синхронная отправка сообщения. Виджет обычно ходит по WebSocket,
   * но этот маршрут работает как запасной путь и как простой REST для тестов.
   */
  router.post('/conversations/:id/messages', async (req, res) => {
    const conversation = getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Диалог не найден' });

    const text = String(req.body?.text || '').trim().slice(0, 4000);
    if (!text) return res.status(400).json({ error: 'Пустое сообщение' });

    const { userMessage, reply } = handleIncomingMessage({
      hub,
      conversationId: conversation.id,
      text,
      contactName: req.body?.contactName,
    });

    try {
      const assistantMessage = await reply;
      res.json({ message: userMessage, reply: assistantMessage });
    } catch (error) {
      res.status(error.status || 502).json({
        message: userMessage,
        error: error.message,
        code: error.code || 'reply_failed',
      });
    }
  });

  /* ------------------------------------------------------------------ *
   *  Внешний API: сюда стучится ваше приложение или чужой чат-сервис.   *
   *  Авторизация — заголовок X-API-Key (ключи создаются в админке).     *
   * ------------------------------------------------------------------ */
  const v1 = express.Router();

  v1.use((req, res, next) => {
    const key = req.get('X-API-Key') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!useApiKey(key)) return res.status(401).json({ error: 'Неверный или отсутствующий API-ключ' });
    next();
  });

  /**
   * POST /api/v1/chat
   * { "channel": "telegram", "contact_id": "12345", "contact_name": "Иван", "text": "Привет" }
   * -> { "reply": "...", "attachments": [...], "conversation_id": "..." }
   */
  v1.post('/chat', async (req, res) => {
    const { channel = 'api', contact_id: contactId, contact_name: contactName = '', text, meta = {} } =
      req.body || {};

    const body = String(text || '').trim().slice(0, 4000);
    if (!body) return res.status(400).json({ error: 'Поле text обязательно' });
    if (!contactId) return res.status(400).json({ error: 'Поле contact_id обязательно' });

    const conversation = findOrCreateConversation({
      channel: String(channel).slice(0, 40),
      externalId: String(contactId).slice(0, 120),
      contactName: String(contactName).slice(0, 120),
      contactMeta: meta,
    });

    const { reply } = handleIncomingMessage({
      hub,
      conversationId: conversation.id,
      text: body,
      contactName,
    });

    try {
      const message = await reply;
      if (!message) {
        return res.json({
          conversation_id: conversation.id,
          reply: null,
          status: 'handled_by_operator',
          note: 'Диалог переведён на живого менеджера или автоответ выключен.',
        });
      }
      res.json({
        conversation_id: conversation.id,
        reply: message.content,
        attachments: message.attachments,
        status: 'ok',
      });
    } catch (error) {
      res.status(error.status || 502).json({
        conversation_id: conversation.id,
        error: error.message,
        code: error.code || 'reply_failed',
      });
    }
  });

  /** Подтянуть историю диалога по внешнему id. */
  v1.get('/conversations/:channel/:contactId', (req, res) => {
    const conversation = findOrCreateConversation({
      channel: req.params.channel,
      externalId: req.params.contactId,
    });
    res.json({
      conversation_id: conversation.id,
      messages: getMessages(conversation.id, 200).map((m) => ({
        role: m.role,
        content: m.content,
        attachments: m.attachments,
        created_at: m.created_at,
      })),
    });
  });

  /** Записать реплику, не запрашивая ответ (например, эхо из внешней системы). */
  v1.post('/messages', (req, res) => {
    const { channel = 'api', contact_id: contactId, role = 'operator', text } = req.body || {};
    if (!contactId || !text) return res.status(400).json({ error: 'Нужны contact_id и text' });
    if (!['operator', 'user', 'assistant'].includes(role))
      return res.status(400).json({ error: 'role: operator | user | assistant' });

    const conversation = findOrCreateConversation({ channel, externalId: String(contactId) });
    const message = addMessage({
      conversationId: conversation.id,
      role,
      content: String(text).slice(0, 4000),
    });
    hub.broadcastMessage(conversation.id, message);
    res.json({ conversation_id: conversation.id, message });
  });

  router.use('/v1', v1);
  return router;
}

export function widgetSnippet() {
  return `<script src="${config.publicUrl}/widget.js" async></script>`;
}
