import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

import {
  db, q, now, uid, publicUser, hashPassword, verifyPassword, findOrCreateDm,
  memberIds, insertMessage, hydrateMessage, chatsForUser, STAR_PACKS, CURRENCY,
} from './db.js';
import { attachRealtime, sendTo, broadcastToChat, isOnline, onlineIds } from './realtime.js';
import { isLive, createCheckoutSession, verifyWebhookSignature } from './payments.js';

/* Локальный .env без внешних зависимостей. */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/* Вебхук Stripe должен получить нетронутое тело — до json-парсера. */
app.post('/api/stripe/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const raw = req.body.toString('utf8');
  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!verifyWebhookSignature(raw, req.get('stripe-signature'), secret)) {
    return res.status(400).send('bad signature');
  }
  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).send('bad json'); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const paymentId = session.client_reference_id || session.metadata?.paymentId;
    creditPayment(paymentId, session.id);
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '256kb' }));

/* ----------------------------- утилиты ----------------------------- */

const bad = (res, code, message) => res.status(code).json({ error: message });

function tokenFrom(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : req.query.token || '';
}

function auth(req, res, next) {
  const session = q.sessionByToken.get(tokenFrom(req));
  const user = session && q.userById.get(session.user_id);
  if (!user) return bad(res, 401, 'Нужна авторизация');
  req.user = user;
  next();
}

const withPresence = (u) => u && { ...u, online: isOnline(u.id) };

/** Зачисляет звёзды по оплаченному платежу ровно один раз. */
function creditPayment(paymentId, externalId = null) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId || '');
  if (!payment || payment.status === 'paid') return null;

  db.prepare('UPDATE payments SET status = ?, paid_at = ?, external_id = ? WHERE id = ?')
    .run('paid', now(), externalId, payment.id);
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(payment.stars, payment.user_id);

  const balance = q.userById.get(payment.user_id).balance;
  sendTo(payment.user_id, { t: 'wallet', balance, credited: payment.stars });
  return balance;
}

/* ------------------------------ конфиг ------------------------------ */

app.get('/api/config', (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.json({
    currency: CURRENCY,
    payments: isLive() ? 'stripe' : 'demo',
    packs: STAR_PACKS,
    iceServers,
  });
});

/* ---------------------------- авторизация ---------------------------- */

app.post('/api/auth/register', (req, res) => {
  const username = String(req.body.username || '').trim().replace(/^@/, '');
  const displayName = String(req.body.displayName || '').trim() || username;
  const password = String(req.body.password || '');

  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
    return bad(res, 400, 'Имя пользователя: 3–20 символов, латиница, цифры и _');
  if (password.length < 6) return bad(res, 400, 'Пароль не короче 6 символов');
  if (q.userByUsername.get(username)) return bad(res, 409, 'Такое имя уже занято');

  const { hash, salt } = hashPassword(password);
  const id = uid();
  const emojis = ['🦊', '🐼', '🐨', '🦁', '🐸', '🐙', '🦉', '🐺', '🦄', '🐯', '🐵', '🐻'];
  db.prepare(
    `INSERT INTO users (id, username, display_name, avatar_emoji, avatar_hue, password_hash, password_salt, balance, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, username, displayName,
    emojis[Math.floor(Math.random() * emojis.length)],
    Math.floor(Math.random() * 360),
    hash, salt,
    25,                       // приветственные звёзды, чтобы сразу попробовать подарки
    now(), now()
  );

  res.json(createSession(id));
});

app.post('/api/auth/login', (req, res) => {
  const user = q.userByUsername.get(String(req.body.username || '').trim().replace(/^@/, ''));
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash, user.password_salt))
    return bad(res, 401, 'Неверное имя пользователя или пароль');
  res.json(createSession(user.id));
});

function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, now());
  const user = q.userById.get(userId);
  return { token, user: { ...publicUser(user), balance: user.balance } };
}

app.post('/api/auth/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenFrom(req));
  res.json({ ok: true });
});

/* ------------------------------ профиль ------------------------------ */

app.get('/api/me', auth, (req, res) => {
  res.json({ ...publicUser(req.user), balance: req.user.balance });
});

app.patch('/api/me', auth, (req, res) => {
  const { displayName, bio, avatarEmoji, avatarHue } = req.body;
  db.prepare(
    `UPDATE users SET display_name = ?, bio = ?, avatar_emoji = ?, avatar_hue = ? WHERE id = ?`
  ).run(
    String(displayName ?? req.user.display_name).trim().slice(0, 40) || req.user.display_name,
    String(bio ?? req.user.bio).slice(0, 160),
    String(avatarEmoji ?? req.user.avatar_emoji).slice(0, 8),
    Number.isFinite(+avatarHue) ? Math.abs(Math.round(+avatarHue)) % 360 : req.user.avatar_hue,
    req.user.id
  );
  const user = q.userById.get(req.user.id);
  res.json({ ...publicUser(user), balance: user.balance });
});

app.get('/api/users', auth, (req, res) => {
  const term = `%${String(req.query.q || '').trim()}%`;
  const rows = db
    .prepare(
      `SELECT * FROM users WHERE id <> ? AND (username LIKE ? OR display_name LIKE ?)
        ORDER BY last_seen DESC LIMIT 30`
    )
    .all(req.user.id, term, term);
  res.json(rows.map((u) => withPresence(publicUser(u))));
});

app.get('/api/users/:id', auth, (req, res) => {
  const user = q.userById.get(req.params.id);
  if (!user) return bad(res, 404, 'Пользователь не найден');

  const gifts = db
    .prepare(
      `SELECT ug.*, g.name, g.emoji, g.price, g.tier FROM user_gifts ug
         JOIN gifts g ON g.id = ug.gift_id
        WHERE ug.owner_id = ? ORDER BY g.price DESC, ug.created_at DESC LIMIT 60`
    )
    .all(user.id)
    .map((row) => ({
      id: row.id,
      name: row.name,
      emoji: row.emoji,
      price: row.price,
      tier: row.tier,
      note: row.note,
      createdAt: row.created_at,
      from: row.anonymous ? null : publicUser(q.userById.get(row.from_id)),
    }));

  res.json({
    ...withPresence(publicUser(user)),
    gifts,
    giftValue: gifts.reduce((sum, g) => sum + g.price, 0),
  });
});

/* -------------------------------- чаты -------------------------------- */

app.get('/api/chats', auth, (req, res) => {
  const chats = chatsForUser(req.user.id).map((c) => ({
    ...c,
    members: c.members.map(withPresence),
  }));
  res.json({ chats, online: onlineIds() });
});

app.post('/api/chats/dm', auth, (req, res) => {
  const other = q.userById.get(String(req.body.userId || ''));
  if (!other) return bad(res, 404, 'Пользователь не найден');
  if (other.id === req.user.id) return bad(res, 400, 'Нельзя написать самому себе');
  const chatId = findOrCreateDm(req.user.id, other.id);
  sendTo(other.id, { t: 'chats:refresh' });
  res.json({ chatId });
});

app.post('/api/chats/group', auth, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 60);
  if (!title) return bad(res, 400, 'Нужно название группы');

  const ids = [...new Set([req.user.id, ...(req.body.memberIds || []).map(String)])]
    .filter((id) => q.userById.get(id));

  const chatId = uid();
  const ts = now();
  db.prepare('INSERT INTO chats (id, kind, title, icon, hue, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(chatId, 'group', title, String(req.body.icon || '💬').slice(0, 8), Math.floor(Math.random() * 360), req.user.id, ts);

  const addMember = db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)');
  for (const id of ids) addMember.run(chatId, id, ts);

  insertMessage({
    chatId, senderId: req.user.id, kind: 'system',
    body: `${req.user.display_name} создал(а) группу «${title}»`,
  });
  for (const id of ids) if (id !== req.user.id) sendTo(id, { t: 'chats:refresh' });

  res.json({ chatId });
});

app.get('/api/chats/:id/messages', auth, (req, res) => {
  const chatId = req.params.id;
  if (!q.isMember.get(chatId, req.user.id)) return bad(res, 403, 'Нет доступа к чату');

  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = db
    .prepare('SELECT * FROM messages WHERE chat_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 60')
    .all(chatId, before)
    .map(hydrateMessage)
    .reverse();

  const members = memberIds(chatId).map((id) => withPresence(publicUser(q.userById.get(id)))).filter(Boolean);
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);

  res.json({
    messages: rows,
    members,
    chat: {
      id: chat.id,
      kind: chat.kind,
      title: chat.kind === 'dm'
        ? members.find((m) => m.id !== req.user.id)?.displayName ?? 'Чат'
        : chat.title,
      icon: chat.icon,
      ownerId: chat.owner_id,
    },
  });
});

app.post('/api/chats/:id/messages', auth, (req, res) => {
  const chatId = req.params.id;
  if (!q.isMember.get(chatId, req.user.id)) return bad(res, 403, 'Нет доступа к чату');

  const body = String(req.body.body || '').trim().slice(0, 4000);
  if (!body) return bad(res, 400, 'Пустое сообщение');

  const message = insertMessage({
    chatId, senderId: req.user.id, kind: 'text', body,
    replyTo: req.body.replyTo ? String(req.body.replyTo) : null,
  });
  broadcastToChat(chatId, { t: 'message', message });
  res.json({ message });
});

app.post('/api/chats/:id/read', auth, (req, res) => {
  if (!q.isMember.get(req.params.id, req.user.id)) return bad(res, 403, 'Нет доступа к чату');
  db.prepare('UPDATE chat_members SET last_read = ? WHERE chat_id = ? AND user_id = ?')
    .run(now(), req.params.id, req.user.id);
  res.json({ ok: true });
});

/* ------------------------------ подарки ------------------------------ */

app.get('/api/gifts', auth, (req, res) => {
  res.json({
    gifts: q.giftsAll.all().map((g) => ({
      id: g.id, name: g.name, emoji: g.emoji, price: g.price, tier: g.tier,
    })),
    balance: req.user.balance,
    packs: STAR_PACKS,
    payments: isLive() ? 'stripe' : 'demo',
  });
});

app.post('/api/gifts/send', auth, (req, res) => {
  const gift = q.giftById.get(String(req.body.giftId || ''));
  if (!gift) return bad(res, 404, 'Подарок не найден');

  const recipient = q.userById.get(String(req.body.toUserId || ''));
  if (!recipient) return bad(res, 404, 'Получатель не найден');
  if (recipient.id === req.user.id) return bad(res, 400, 'Подарок себе не отправить');

  const sender = q.userById.get(req.user.id);
  if (sender.balance < gift.price)
    return bad(res, 402, `Не хватает ${gift.price - sender.balance} ⭐ — пополните кошелёк`);

  const note = String(req.body.note || '').trim().slice(0, 200);
  const anonymous = req.body.anonymous ? 1 : 0;
  const chatId = String(req.body.chatId || '') || findOrCreateDm(sender.id, recipient.id);
  const ts = now();

  // Списание, выдача подарка и сообщение в чат — одной транзакцией.
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?')
      .run(gift.price, sender.id, gift.price);
    db.prepare(
      'INSERT INTO user_gifts (id, owner_id, from_id, gift_id, note, anonymous, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(uid(), recipient.id, sender.id, gift.id, note, anonymous, ts);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return bad(res, 500, 'Не удалось отправить подарок');
  }

  const message = insertMessage({
    chatId, senderId: sender.id, kind: 'gift', body: note,
    meta: {
      giftId: gift.id, name: gift.name, emoji: gift.emoji, price: gift.price, tier: gift.tier,
      toUserId: recipient.id, toName: recipient.display_name, anonymous: !!anonymous,
    },
  });

  const balance = q.userById.get(sender.id).balance;
  broadcastToChat(chatId, { t: 'message', message });
  sendTo(sender.id, { t: 'wallet', balance });
  sendTo(recipient.id, {
    t: 'gift:received',
    gift: { name: gift.name, emoji: gift.emoji, price: gift.price, tier: gift.tier },
    from: anonymous ? null : publicUser(sender),
    chatId,
  });

  res.json({ ok: true, balance, message });
});

/* ------------------------------ кошелёк ------------------------------ */

app.get('/api/wallet', auth, (req, res) => {
  const history = db
    .prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(req.user.id)
    .map((p) => ({
      id: p.id, stars: p.stars, amount: p.amount, currency: p.currency,
      status: p.status, provider: p.provider, createdAt: p.created_at,
    }));
  res.json({ balance: req.user.balance, packs: STAR_PACKS, payments: isLive() ? 'stripe' : 'demo', history });
});

app.post('/api/wallet/topup', auth, async (req, res) => {
  const pack = STAR_PACKS.find((p) => p.id === String(req.body.packId || ''));
  if (!pack) return bad(res, 404, 'Такого пакета нет');

  const paymentId = uid();
  const provider = isLive() ? 'stripe' : 'demo';
  db.prepare(
    `INSERT INTO payments (id, user_id, pack_id, stars, amount, currency, provider, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(paymentId, req.user.id, pack.id, pack.total, pack.amount, pack.currency, provider, 'pending', now());

  if (provider === 'demo') {
    const balance = creditPayment(paymentId, 'demo');
    return res.json({ mode: 'demo', balance, stars: pack.total, paymentId });
  }

  try {
    const session = await createCheckoutSession({ pack, user: req.user, paymentId, publicUrl: PUBLIC_URL });
    db.prepare('UPDATE payments SET external_id = ? WHERE id = ?').run(session.id, paymentId);
    res.json({ mode: 'stripe', url: session.url, paymentId });
  } catch (err) {
    db.prepare('UPDATE payments SET status = ? WHERE id = ?').run('failed', paymentId);
    bad(res, 502, `Платёжный провайдер недоступен: ${err.message}`);
  }
});

app.get('/api/wallet/payment/:id', auth, (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!payment) return bad(res, 404, 'Платёж не найден');
  res.json({ status: payment.status, stars: payment.stars, balance: q.userById.get(req.user.id).balance });
});

/* ------------------------------ статика ------------------------------ */

const webDir = join(root, 'web');
app.use(express.static(webDir, {
  etag: true,
  setHeaders(res, path) {
    if (path.endsWith('sw.js') || path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.get(/^\/(?!api|ws).*/, (req, res) => res.sendFile(join(webDir, 'index.html')));

app.use((err, req, res, next) => {
  console.error('[mals]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

const server = createServer(app);
attachRealtime(server);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  MALS работает: http://localhost:${PORT}`);
  console.log(`  Платежи: ${isLive() ? 'Stripe (боевой режим)' : 'DEMO (без списания денег)'}`);
  console.log(`  Валюта: ${CURRENCY.toUpperCase()}\n`);
});

export { app, server };
