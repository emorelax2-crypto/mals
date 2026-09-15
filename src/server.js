import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { PUBLIC_DIR, assertConfig, config } from './config.js';
import { findOrCreateConversation, getMessages } from './db.js';
import { handleIncomingMessage } from './chat.js';
import { Hub, attachWebsocket } from './realtime.js';
import { isAuthed } from './auth.js';
import { publicRoutes } from './routes/public.js';
import { adminRoutes } from './routes/admin.js';

const app = express();
const hub = new Hub();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Виджет встраивается на чужие домены, поэтому публичный API открыт по CORS.
// Админка ходит с того же origin и защищена HttpOnly-кукой.
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api', publicRoutes(hub));
app.use('/admin/api', adminRoutes(hub));

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html')));

app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: 'index.html' }));

app.use((error, req, res, next) => {
  console.error('[http]', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

const server = http.createServer(app);

attachWebsocket(server, {
  hub,
  isAdmin: isAuthed,
  onWidgetOpen: (url) => {
    const conversationId = url.searchParams.get('conversation');
    const visitorId = url.searchParams.get('visitor');
    const conversation = findOrCreateConversation({
      channel: 'widget',
      externalId: conversationId || visitorId || undefined,
    });
    return { ...conversation, messages: getMessages(conversation.id, 100) };
  },
  onWidgetMessage: (conversationId, text, contactName) => {
    const { reply } = handleIncomingMessage({ hub, conversationId, text, contactName });
    // Ответ уйдёт через WebSocket сам; здесь только гасим unhandled rejection.
    reply.catch(() => {});
  },
});

server.listen(config.port, () => {
  const problems = assertConfig();
  console.log(`\n  Mals Chat запущен: ${config.publicUrl}`);
  console.log(`  Админка:          ${config.publicUrl}/admin`);
  console.log(`  Модель:           claude-opus-5`);
  console.log(`  Параллельно:      до ${config.maxConcurrentReplies} ответов одновременно`);
  if (problems.length) {
    console.log('\n  Нужно настроить .env:');
    for (const problem of problems) console.log(`   • ${problem}`);
  }
  console.log('');
});

const shutdown = () => {
  console.log('\nОстанавливаюсь…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
