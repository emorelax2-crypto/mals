import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { DATA_DIR } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'mals.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  channel      TEXT NOT NULL DEFAULT 'widget',
  external_id  TEXT,
  contact_name TEXT,
  contact_meta TEXT NOT NULL DEFAULT '{}',
  takeover     INTEGER NOT NULL DEFAULT 0,
  unread       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_external ON conversations(channel, external_id);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  attachments     TEXT NOT NULL DEFAULT '[]',
  author          TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS triggers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL DEFAULT '',
  keywords    TEXT NOT NULL DEFAULT '',
  match_type  TEXT NOT NULL DEFAULT 'any',
  note        TEXT NOT NULL DEFAULT '',
  media_id    INTEGER REFERENCES media(id) ON DELETE SET NULL,
  card        TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL DEFAULT 0,
  hits        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL DEFAULT '',
  filename   TEXT NOT NULL,
  url        TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  key        TEXT NOT NULL UNIQUE,
  last_used  INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  day           TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  replies       INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_day ON usage_log(day);
`);

export const now = () => Date.now();

/* ---------- settings ---------- */

export const DEFAULT_SETTINGS = {
  bot_name: 'Алина',
  bot_role: 'ИИ-ассистент магазина',
  avatar_url: '',
  greeting: 'Привет! Я ИИ-ассистент — на связи круглосуточно. Что подсказать?',
  persona: [
    'Ты — ассистент поддержки и продаж.',
    'Пиши коротко, по-человечески, 1–3 предложения, без канцелярита.',
    'Помогай выбрать товар, отвечай на вопросы о доставке, оплате и возврате.',
    'Если не знаешь точного ответа — скажи прямо и предложи позвать живого менеджера.',
  ].join('\n'),
  effort: 'low',
  max_tokens: 1200,
  autoreply: 1,
  disclosure_line: 'Отвечает ИИ-ассистент',
  handoff_text: 'Секунду, зову живого менеджера — он ответит здесь же.',
  widget_title: 'Чат с ассистентом',
  widget_color: '#6d5efc',
  widget_position: 'right',
};

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out = { ...DEFAULT_SETTINGS };
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (stored[key] === undefined) continue;
    out[key] = typeof def === 'number' ? Number(stored[key]) : stored[key];
  }
  return out;
}

export function getSetting(key) {
  const row = getSettingStmt.get(key);
  if (row === undefined) return DEFAULT_SETTINGS[key];
  const def = DEFAULT_SETTINGS[key];
  return typeof def === 'number' ? Number(row.value) : row.value;
}

export function saveSettings(patch) {
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      setSettingStmt.run(key, String(value));
    }
  });
  tx(Object.entries(patch));
  return getSettings();
}

/* ---------- conversations ---------- */

export function findOrCreateConversation({ channel = 'widget', externalId, contactName = '', contactMeta = {} }) {
  const external = externalId || crypto.randomUUID();
  const existing = db
    .prepare('SELECT * FROM conversations WHERE channel = ? AND external_id = ?')
    .get(channel, external);
  if (existing) return existing;

  const id = crypto.randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO conversations(id, channel, external_id, contact_name, contact_meta, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).run(id, channel, external, contactName, JSON.stringify(contactMeta), ts, ts);
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}

export function getConversation(id) {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}

export function touchConversation(id, patch = {}) {
  const fields = ['updated_at = ?'];
  const values = [now()];
  if (patch.unread !== undefined) {
    fields.push('unread = ?');
    values.push(patch.unread);
  }
  if (patch.takeover !== undefined) {
    fields.push('takeover = ?');
    values.push(patch.takeover ? 1 : 0);
  }
  if (patch.contactName !== undefined) {
    fields.push('contact_name = ?');
    values.push(patch.contactName);
  }
  values.push(id);
  db.prepare(`UPDATE conversations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function bumpUnread(id) {
  db.prepare('UPDATE conversations SET unread = unread + 1, updated_at = ? WHERE id = ?').run(now(), id);
}

export function listConversations({ limit = 100, offset = 0, search = '' } = {}) {
  const like = `%${search.toLowerCase()}%`;
  const rows = db
    .prepare(
      `SELECT c.*,
              (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
              (SELECT role    FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_role,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c
       WHERE (? = '' OR LOWER(COALESCE(c.contact_name, '')) LIKE ? OR LOWER(c.external_id) LIKE ?)
       ORDER BY c.updated_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(search.toLowerCase(), like, like, limit, offset);
  return rows.map(decodeConversation);
}

function decodeConversation(row) {
  if (!row) return row;
  return { ...row, contact_meta: safeJson(row.contact_meta, {}) };
}

/* ---------- messages ---------- */

export function addMessage({ conversationId, role, content, attachments = [], author = null }) {
  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO messages(conversation_id, role, content, attachments, author, created_at)
       VALUES(?, ?, ?, ?, ?, ?)`
    )
    .run(conversationId, role, content, JSON.stringify(attachments), author, ts);
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, conversationId);
  return {
    id: info.lastInsertRowid,
    conversation_id: conversationId,
    role,
    content,
    attachments,
    author,
    created_at: ts,
  };
}

export function getMessages(conversationId, limit = 200) {
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
    .all(conversationId, limit);
  return rows.reverse().map((r) => ({ ...r, attachments: safeJson(r.attachments, []) }));
}

/* ---------- triggers ---------- */

export function listTriggers({ onlyEnabled = false } = {}) {
  const rows = db
    .prepare(
      `SELECT t.*, m.url AS media_url, m.title AS media_title
       FROM triggers t LEFT JOIN media m ON m.id = t.media_id
       ${onlyEnabled ? 'WHERE t.enabled = 1' : ''}
       ORDER BY t.priority DESC, t.id ASC`
    )
    .all();
  return rows.map((r) => ({ ...r, card: safeJson(r.card, {}) }));
}

export function saveTrigger(t) {
  const card = JSON.stringify(t.card || {});
  if (t.id) {
    db.prepare(
      `UPDATE triggers SET title=?, keywords=?, match_type=?, note=?, media_id=?, card=?, enabled=?, priority=?
       WHERE id=?`
    ).run(t.title, t.keywords, t.match_type, t.note, t.media_id || null, card, t.enabled ? 1 : 0, t.priority || 0, t.id);
    return db.prepare('SELECT * FROM triggers WHERE id = ?').get(t.id);
  }
  const info = db
    .prepare(
      `INSERT INTO triggers(title, keywords, match_type, note, media_id, card, enabled, priority, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(t.title, t.keywords, t.match_type, t.note, t.media_id || null, card, t.enabled ? 1 : 0, t.priority || 0, now());
  return db.prepare('SELECT * FROM triggers WHERE id = ?').get(info.lastInsertRowid);
}

export function deleteTrigger(id) {
  db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
}

export function bumpTriggerHits(ids) {
  if (!ids.length) return;
  const stmt = db.prepare('UPDATE triggers SET hits = hits + 1 WHERE id = ?');
  const tx = db.transaction((list) => list.forEach((id) => stmt.run(id)));
  tx(ids);
}

/* ---------- media ---------- */

export function addMedia({ title, filename, url, mime, size }) {
  const info = db
    .prepare('INSERT INTO media(title, filename, url, mime, size, created_at) VALUES(?, ?, ?, ?, ?, ?)')
    .run(title, filename, url, mime, size, now());
  return db.prepare('SELECT * FROM media WHERE id = ?').get(info.lastInsertRowid);
}

export const listMedia = () => db.prepare('SELECT * FROM media ORDER BY id DESC').all();
export const getMedia = (id) => db.prepare('SELECT * FROM media WHERE id = ?').get(id);
export const deleteMedia = (id) => db.prepare('DELETE FROM media WHERE id = ?').run(id);

/* ---------- api keys ---------- */

export function createApiKey(name) {
  const key = 'mals_' + crypto.randomBytes(24).toString('hex');
  const info = db
    .prepare('INSERT INTO api_keys(name, key, created_at) VALUES(?, ?, ?)')
    .run(name || 'Без названия', key, now());
  return db.prepare('SELECT * FROM api_keys WHERE id = ?').get(info.lastInsertRowid);
}

export const listApiKeys = () => db.prepare('SELECT * FROM api_keys ORDER BY id DESC').all();
export const deleteApiKey = (id) => db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);

export function useApiKey(key) {
  const row = db.prepare('SELECT * FROM api_keys WHERE key = ?').get(key);
  if (!row) return null;
  db.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?').run(now(), row.id);
  return row;
}

/* ---------- usage ---------- */

export function logUsage({ inputTokens = 0, outputTokens = 0, cachedTokens = 0, reply = 0, error = 0 }) {
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO usage_log(day, input_tokens, output_tokens, cached_tokens, replies, errors)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       input_tokens  = input_tokens  + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cached_tokens = cached_tokens + excluded.cached_tokens,
       replies       = replies       + excluded.replies,
       errors        = errors        + excluded.errors`
  ).run(day, inputTokens, outputTokens, cachedTokens, reply, error);
}

export function stats() {
  const day = new Date().toISOString().slice(0, 10);
  const today = db.prepare('SELECT * FROM usage_log WHERE day = ?').get(day) || {
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    replies: 0,
    errors: 0,
  };
  const dayAgo = now() - 24 * 3600 * 1000;
  return {
    today,
    conversations: db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n,
    activeToday: db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE updated_at > ?').get(dayAgo).n,
    messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
    unread: db.prepare('SELECT COALESCE(SUM(unread), 0) AS n FROM conversations').get().n,
    takeovers: db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE takeover = 1').get().n,
  };
}

export function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
