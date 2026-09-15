import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.DATA_DIR || join(root, 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, 'mals.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  avatar_emoji  TEXT NOT NULL DEFAULT '🙂',
  avatar_hue    INTEGER NOT NULL DEFAULT 220,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  balance       INTEGER NOT NULL DEFAULT 0,      -- баланс в звёздах
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                      -- 'dm' | 'group'
  title      TEXT NOT NULL DEFAULT '',
  icon       TEXT NOT NULL DEFAULT '💬',
  hue        INTEGER NOT NULL DEFAULT 250,
  owner_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id   TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  last_read INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL DEFAULT 'text',       -- 'text' | 'gift' | 'call' | 'system'
  body       TEXT NOT NULL DEFAULT '',
  meta       TEXT NOT NULL DEFAULT '{}',
  reply_to   TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS gifts (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  emoji     TEXT NOT NULL,
  price     INTEGER NOT NULL,                    -- цена в звёздах
  tier      TEXT NOT NULL,                       -- common | rare | epic | legendary
  sort      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_gifts (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  gift_id     TEXT NOT NULL REFERENCES gifts(id),
  note        TEXT NOT NULL DEFAULT '',
  anonymous   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_gifts_owner ON user_gifts(owner_id, created_at);

CREATE TABLE IF NOT EXISTS payments (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id     TEXT NOT NULL,
  stars       INTEGER NOT NULL,
  amount      INTEGER NOT NULL,                  -- в минимальных единицах валюты
  currency    TEXT NOT NULL,
  provider    TEXT NOT NULL,                     -- 'stripe' | 'demo'
  status      TEXT NOT NULL,                     -- 'pending' | 'paid' | 'failed'
  external_id TEXT,
  created_at  INTEGER NOT NULL,
  paid_at     INTEGER
);

CREATE TABLE IF NOT EXISTS calls (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  caller_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video        INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,                    -- ringing | active | ended | declined | missed
  started_at   INTEGER NOT NULL,
  answered_at  INTEGER,
  ended_at     INTEGER
);
`);

export const now = () => Date.now();
export const uid = () => randomUUID();

/* ---------- пароли ---------- */
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
export function verifyPassword(password, hash, salt) {
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/* ---------- каталог подарков ---------- */
const GIFT_CATALOG = [
  { id: 'heart',     name: 'Сердечко',        emoji: '💝', price: 15,   tier: 'common' },
  { id: 'teddy',     name: 'Мишка',           emoji: '🧸', price: 15,   tier: 'common' },
  { id: 'rose',      name: 'Роза',            emoji: '🌹', price: 25,   tier: 'common' },
  { id: 'cake',      name: 'Торт',            emoji: '🎂', price: 50,   tier: 'common' },
  { id: 'champagne', name: 'Шампанское',      emoji: '🍾', price: 50,   tier: 'rare' },
  { id: 'rocket',    name: 'Ракета',          emoji: '🚀', price: 100,  tier: 'rare' },
  { id: 'trophy',    name: 'Кубок',           emoji: '🏆', price: 100,  tier: 'rare' },
  { id: 'guitar',    name: 'Гитара',          emoji: '🎸', price: 150,  tier: 'rare' },
  { id: 'diamond',   name: 'Бриллиант',       emoji: '💎', price: 250,  tier: 'epic' },
  { id: 'crown',     name: 'Корона',          emoji: '👑', price: 400,  tier: 'epic' },
  { id: 'dragon',    name: 'Дракон',          emoji: '🐉', price: 750,  tier: 'epic' },
  { id: 'ferrari',   name: 'Суперкар',        emoji: '🏎️', price: 1500, tier: 'legendary' },
  { id: 'yacht',     name: 'Яхта',            emoji: '🛥️', price: 3000, tier: 'legendary' },
  { id: 'galaxy',    name: 'Галактика',       emoji: '🌌', price: 5000, tier: 'legendary' },
];

const upsertGift = db.prepare(
  `INSERT INTO gifts (id, name, emoji, price, tier, sort) VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET name = excluded.name, emoji = excluded.emoji,
     price = excluded.price, tier = excluded.tier, sort = excluded.sort`
);
GIFT_CATALOG.forEach((g, i) => upsertGift.run(g.id, g.name, g.emoji, g.price, g.tier, i));

/* ---------- витрина пакетов звёзд ---------- */
export const CURRENCY = (process.env.CURRENCY || 'usd').toLowerCase();

export const STAR_PACKS = [
  { id: 'pack_100',  stars: 100,  amount: 199,   bonus: 0 },
  { id: 'pack_500',  stars: 500,  amount: 899,   bonus: 25 },
  { id: 'pack_1000', stars: 1000, amount: 1699,  bonus: 100 },
  { id: 'pack_2500', stars: 2500, amount: 3999,  bonus: 350 },
].map((p) => ({ ...p, currency: CURRENCY, total: p.stars + p.bonus }));

/* ---------- выборки ---------- */
export const publicUser = (u) =>
  u && {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    bio: u.bio,
    avatarEmoji: u.avatar_emoji,
    avatarHue: u.avatar_hue,
    lastSeen: u.last_seen,
  };

export const q = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByUsername: db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)'),
  sessionByToken: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  giftsAll: db.prepare('SELECT * FROM gifts ORDER BY sort'),
  giftById: db.prepare('SELECT * FROM gifts WHERE id = ?'),
  membersOf: db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?'),
  isMember: db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?'),
};

/** Личный чат между двумя пользователями: находит существующий или создаёт новый. */
export function findOrCreateDm(a, b) {
  const row = db
    .prepare(
      `SELECT c.id FROM chats c
         JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
         JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
        WHERE c.kind = 'dm' LIMIT 1`
    )
    .get(a, b);
  if (row) return row.id;

  const id = uid();
  const ts = now();
  db.prepare('INSERT INTO chats (id, kind, title, icon, hue, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'dm', '', '💬', 250, a, ts);
  const addMember = db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)');
  addMember.run(id, a, ts);
  addMember.run(id, b, ts);
  return id;
}

export function memberIds(chatId) {
  return q.membersOf.all(chatId).map((r) => r.user_id);
}

export function insertMessage({ chatId, senderId, kind = 'text', body = '', meta = {}, replyTo = null }) {
  const id = uid();
  const ts = now();
  db.prepare(
    'INSERT INTO messages (id, chat_id, sender_id, kind, body, meta, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, chatId, senderId, kind, body, JSON.stringify(meta), replyTo, ts);
  return hydrateMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
}

export function hydrateMessage(row) {
  if (!row) return null;
  let meta = {};
  try { meta = JSON.parse(row.meta); } catch { meta = {}; }
  return {
    id: row.id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    kind: row.kind,
    body: row.body,
    meta,
    replyTo: row.reply_to,
    createdAt: row.created_at,
  };
}

/** Список чатов пользователя со свёрнутым превью последнего сообщения. */
export function chatsForUser(userId) {
  const rows = db
    .prepare(
      `SELECT c.* FROM chats c
         JOIN chat_members m ON m.chat_id = c.id
        WHERE m.user_id = ?`
    )
    .all(userId);

  return rows
    .map((c) => {
      const last = db
        .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(c.id);
      const lastRead = db.prepare('SELECT last_read FROM chat_members WHERE chat_id = ? AND user_id = ?')
        .get(c.id, userId)?.last_read ?? 0;
      const unread = db
        .prepare('SELECT count(*) AS n FROM messages WHERE chat_id = ? AND created_at > ? AND sender_id <> ?')
        .get(c.id, lastRead, userId).n;

      const others = memberIds(c.id)
        .filter((id) => id !== userId)
        .map((id) => publicUser(q.userById.get(id)))
        .filter(Boolean);

      return {
        id: c.id,
        kind: c.kind,
        title: c.kind === 'dm' ? others[0]?.displayName ?? 'Удалённый аккаунт' : c.title,
        icon: c.kind === 'dm' ? others[0]?.avatarEmoji ?? '👤' : c.icon,
        hue: c.kind === 'dm' ? others[0]?.avatarHue ?? 250 : c.hue,
        ownerId: c.owner_id,
        members: others,
        memberCount: memberIds(c.id).length,
        lastMessage: hydrateMessage(last),
        unread,
        updatedAt: last?.created_at ?? c.created_at,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
