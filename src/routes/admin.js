import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { config, UPLOAD_DIR } from '../config.js';
import {
  addMedia,
  createApiKey,
  deleteApiKey,
  deleteMedia,
  deleteTrigger,
  getConversation,
  getMedia,
  getMessages,
  getSettings,
  listApiKeys,
  listConversations,
  listMedia,
  listTriggers,
  saveSettings,
  saveTrigger,
  stats,
  touchConversation,
} from '../db.js';
import { GROUND_RULES, MODEL, buildSystemPrompt, generateReply } from '../ai.js';
import { queueStats, sendOperatorMessage } from '../chat.js';
import { matchTriggers, triggersToAttachments, triggersToBriefing } from '../triggers.js';
import {
  checkPassword,
  clearSessionCookie,
  isAuthed,
  issueToken,
  requireAdmin,
  setSessionCookie,
} from '../auth.js';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().slice(0, 10);
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) return cb(null, true);
    cb(new Error('Можно загружать только картинки: JPEG, PNG, WebP или GIF'));
  },
});

export function adminRoutes(hub) {
  const router = express.Router();

  /* ---------- вход ---------- */

  router.post('/login', (req, res) => {
    if (!config.adminPassword)
      return res.status(500).json({ error: 'ADMIN_PASSWORD не задан в .env — вход невозможен' });
    if (!checkPassword(req.body?.password))
      return res.status(401).json({ error: 'Неверный пароль' });

    setSessionCookie(res, issueToken());
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => res.json({ authed: isAuthed(req) }));

  router.use(requireAdmin);

  /* ---------- настройки ---------- */

  router.get('/settings', (req, res) =>
    res.json({
      settings: getSettings(),
      groundRules: GROUND_RULES,
      model: MODEL,
      systemPromptPreview: buildSystemPrompt(),
      publicUrl: config.publicUrl,
    })
  );

  router.put('/settings', (req, res) => res.json({ settings: saveSettings(req.body || {}) }));

  /* ---------- диалоги ---------- */

  router.get('/conversations', (req, res) =>
    res.json({
      conversations: listConversations({
        search: String(req.query.search || ''),
        limit: Math.min(Number(req.query.limit) || 100, 300),
      }),
    })
  );

  router.get('/conversations/:id', (req, res) => {
    const conversation = getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Диалог не найден' });
    touchConversation(conversation.id, { unread: 0 });
    res.json({ conversation, messages: getMessages(conversation.id, 300) });
  });

  router.post('/conversations/:id/reply', (req, res) => {
    const conversation = getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Диалог не найден' });

    const text = String(req.body?.text || '').trim().slice(0, 4000);
    if (!text) return res.status(400).json({ error: 'Пустое сообщение' });

    const message = sendOperatorMessage({ hub, conversationId: conversation.id, text });
    res.json({ message });
  });

  router.post('/conversations/:id/takeover', (req, res) => {
    const conversation = getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Диалог не найден' });

    const value = Boolean(req.body?.value);
    touchConversation(conversation.id, { takeover: value });
    hub.toAdmins({ type: 'takeover', conversationId: conversation.id, value });
    res.json({ ok: true, takeover: value });
  });

  /* ---------- ключевые слова ---------- */

  router.get('/triggers', (req, res) => res.json({ triggers: listTriggers() }));

  router.post('/triggers', (req, res) => {
    const body = req.body || {};
    if (!String(body.keywords || '').trim())
      return res.status(400).json({ error: 'Укажите хотя бы одно ключевое слово' });

    const trigger = saveTrigger({
      id: body.id || null,
      title: String(body.title || '').slice(0, 120),
      keywords: String(body.keywords).slice(0, 1000),
      match_type: body.match_type === 'all' ? 'all' : 'any',
      note: String(body.note || '').slice(0, 4000),
      media_id: body.media_id ? Number(body.media_id) : null,
      card: {
        name: String(body.card?.name || '').slice(0, 200),
        price: String(body.card?.price || '').slice(0, 80),
        description: String(body.card?.description || '').slice(0, 600),
        url: String(body.card?.url || '').slice(0, 500),
        buttonText: String(body.card?.buttonText || '').slice(0, 60),
      },
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
      priority: Number(body.priority) || 0,
    });
    res.json({ trigger });
  });

  router.delete('/triggers/:id', (req, res) => {
    deleteTrigger(Number(req.params.id));
    res.json({ ok: true });
  });

  /* ---------- медиа ---------- */

  router.get('/media', (req, res) => res.json({ media: listMedia() }));

  router.post('/media', (req, res) => {
    upload.single('file')(req, res, (error) => {
      if (error) return res.status(400).json({ error: error.message });
      if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

      const item = addMedia({
        title: String(req.body?.title || req.file.originalname || '').slice(0, 200),
        filename: req.file.filename,
        url: `/uploads/${req.file.filename}`,
        mime: req.file.mimetype,
        size: req.file.size,
      });
      res.json({ media: item });
    });
  });

  router.delete('/media/:id', (req, res) => {
    const item = getMedia(Number(req.params.id));
    if (item) {
      fs.rm(path.join(UPLOAD_DIR, item.filename), { force: true }, () => {});
      deleteMedia(item.id);
    }
    res.json({ ok: true });
  });

  /* ---------- API-ключи ---------- */

  router.get('/keys', (req, res) => res.json({ keys: listApiKeys() }));

  router.post('/keys', (req, res) => res.json({ key: createApiKey(String(req.body?.name || '')) }));

  router.delete('/keys/:id', (req, res) => {
    deleteApiKey(Number(req.params.id));
    res.json({ ok: true });
  });

  /* ---------- статистика ---------- */

  router.get('/stats', (req, res) =>
    res.json({ stats: stats(), queue: queueStats(), online: hub.onlineWidgets })
  );

  /* ---------- песочница ---------- */

  /** Проверить ответ ассистента, не трогая реальные диалоги. */
  router.post('/preview', async (req, res) => {
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Пустое сообщение' });

    const triggers = matchTriggers(text);
    try {
      const { text: reply } = await generateReply({
        history: [...history, { role: 'user', content: text }],
        briefing: triggersToBriefing(triggers, config.publicUrl),
      });
      res.json({
        reply,
        attachments: triggersToAttachments(triggers, config.publicUrl),
        matchedTriggers: triggers.map((t) => t.title || t.keywords),
      });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message, code: error.code });
    }
  });

  return router;
}
