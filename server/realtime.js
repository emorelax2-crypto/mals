import { WebSocketServer } from 'ws';
import {
  db, q, now, uid, publicUser, memberIds, insertMessage, hydrateMessage,
} from './db.js';

/** userId -> Set<WebSocket> (у одного пользователя может быть несколько устройств) */
const online = new Map();
/** callId -> состояние звонка в памяти (таймер дозвона) */
const ringing = new Map();

const RING_TIMEOUT_MS = 45_000;

export function isOnline(userId) {
  return online.has(userId);
}

export function onlineIds() {
  return [...online.keys()];
}

export function sendTo(userId, payload) {
  const sockets = online.get(userId);
  if (!sockets) return false;
  const data = JSON.stringify(payload);
  let delivered = false;
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
      delivered = true;
    }
  }
  return delivered;
}

export function broadcastToChat(chatId, payload, exceptUserId = null) {
  for (const id of memberIds(chatId)) {
    if (id !== exceptUserId) sendTo(id, payload);
  }
}

/** Всем, у кого есть общий чат с этим пользователем — обновление статуса «в сети». */
function broadcastPresence(userId, isUp) {
  const peers = db
    .prepare(
      `SELECT DISTINCT m2.user_id AS id FROM chat_members m1
         JOIN chat_members m2 ON m2.chat_id = m1.chat_id
        WHERE m1.user_id = ? AND m2.user_id <> ?`
    )
    .all(userId, userId)
    .map((r) => r.id);
  for (const id of peers) sendTo(id, { t: 'presence', userId, online: isUp, lastSeen: now() });
}

function attach(userId, ws) {
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId).add(ws);
}

function detach(userId, ws) {
  const set = online.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) online.delete(userId);
}

/* ------------------------------- звонки ------------------------------- */

function endCall(callId, status, byUserId = null) {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  if (!call || call.status === 'ended' || call.status === 'declined' || call.status === 'missed') return;

  const timer = ringing.get(callId);
  if (timer) { clearTimeout(timer); ringing.delete(callId); }

  const ts = now();
  db.prepare('UPDATE calls SET status = ?, ended_at = ? WHERE id = ?').run(status, ts, callId);

  const duration = call.answered_at ? Math.round((ts - call.answered_at) / 1000) : 0;
  const msg = insertMessage({
    chatId: call.chat_id,
    senderId: call.caller_id,
    kind: 'call',
    body: '',
    meta: { callId, video: !!call.video, status, duration, callerId: call.caller_id, calleeId: call.callee_id },
  });

  for (const id of [call.caller_id, call.callee_id]) {
    sendTo(id, { t: 'call:ended', callId, status, duration, by: byUserId });
  }
  broadcastToChat(call.chat_id, { t: 'message', message: msg });
}

function startCall(user, { chatId, video }) {
  if (!q.isMember.get(chatId, user.id)) return;

  const others = memberIds(chatId).filter((id) => id !== user.id);
  if (others.length === 0) return;

  const active = db
    .prepare(`SELECT * FROM calls WHERE chat_id = ? AND status IN ('ringing','active')`)
    .get(chatId);
  if (active) {
    sendTo(user.id, { t: 'call:busy', chatId, reason: 'В этом чате уже идёт звонок' });
    return;
  }

  const callId = uid();
  const ts = now();
  // Для группы «вызываемым» временно считается первый участник; перезапишем по факту ответа.
  db.prepare(
    'INSERT INTO calls (id, chat_id, caller_id, callee_id, video, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(callId, chatId, user.id, others[0], video ? 1 : 0, 'ringing', ts);

  sendTo(user.id, { t: 'call:outgoing', callId, chatId, video: !!video, peers: others.map((id) => publicUser(q.userById.get(id))) });

  const from = publicUser(q.userById.get(user.id));
  for (const id of others) {
    sendTo(id, { t: 'call:incoming', callId, chatId, video: !!video, from });
  }

  ringing.set(callId, setTimeout(() => endCall(callId, 'missed'), RING_TIMEOUT_MS));
}

function acceptCall(user, { callId }) {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  if (!call || call.status !== 'ringing') return;
  if (!q.isMember.get(call.chat_id, user.id) || user.id === call.caller_id) return;

  const timer = ringing.get(callId);
  if (timer) { clearTimeout(timer); ringing.delete(callId); }

  db.prepare('UPDATE calls SET status = ?, callee_id = ?, answered_at = ? WHERE id = ?')
    .run('active', user.id, now(), callId);

  // Инициатор создаёт offer — он «вежливый» инициатор WebRTC-переговоров.
  sendTo(call.caller_id, { t: 'call:accepted', callId, by: publicUser(q.userById.get(user.id)), initiator: true });
  sendTo(user.id, { t: 'call:accepted', callId, by: publicUser(q.userById.get(call.caller_id)), initiator: false });

  // Остальным участникам группы гасим экран входящего.
  for (const id of memberIds(call.chat_id)) {
    if (id !== call.caller_id && id !== user.id) sendTo(id, { t: 'call:taken', callId });
  }
}

function relaySignal(user, { callId, signal }) {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  if (!call) return;
  const peer = user.id === call.caller_id ? call.callee_id : call.caller_id;
  if (user.id !== call.caller_id && user.id !== call.callee_id) return;
  sendTo(peer, { t: 'call:signal', callId, signal, from: user.id });
}

/* ------------------------------- сервер ------------------------------- */

export function attachRealtime(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.user = null;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      /* авторизация всегда первым сообщением */
      if (msg.t === 'auth') {
        const session = q.sessionByToken.get(msg.token || '');
        const user = session && q.userById.get(session.user_id);
        if (!user) { ws.send(JSON.stringify({ t: 'auth:error' })); ws.close(); return; }

        ws.user = { id: user.id, username: user.username };
        attach(user.id, ws);
        db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), user.id);
        ws.send(JSON.stringify({ t: 'auth:ok', userId: user.id, online: onlineIds() }));
        broadcastPresence(user.id, true);
        return;
      }

      if (!ws.user) return;
      const user = ws.user;

      switch (msg.t) {
        case 'ping':
          ws.send(JSON.stringify({ t: 'pong' }));
          break;

        case 'typing': {
          if (!q.isMember.get(msg.chatId, user.id)) break;
          broadcastToChat(msg.chatId, { t: 'typing', chatId: msg.chatId, userId: user.id, on: !!msg.on }, user.id);
          break;
        }

        case 'read': {
          if (!q.isMember.get(msg.chatId, user.id)) break;
          db.prepare('UPDATE chat_members SET last_read = ? WHERE chat_id = ? AND user_id = ?')
            .run(now(), msg.chatId, user.id);
          broadcastToChat(msg.chatId, { t: 'read', chatId: msg.chatId, userId: user.id, at: now() }, user.id);
          break;
        }

        case 'call:start':   startCall(user, msg); break;
        case 'call:accept':  acceptCall(user, msg); break;
        case 'call:decline': endCall(msg.callId, 'declined', user.id); break;
        case 'call:end':     endCall(msg.callId, 'ended', user.id); break;
        case 'call:signal':  relaySignal(user, msg); break;
      }
    });

    ws.on('close', () => {
      if (!ws.user) return;
      const { id } = ws.user;
      detach(id, ws);
      if (!online.has(id)) {
        db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), id);
        broadcastPresence(id, false);
        // Завершаем звонки, в которых пользователь был одной из сторон.
        const stuck = db
          .prepare(`SELECT id FROM calls WHERE (caller_id = ? OR callee_id = ?) AND status IN ('ringing','active')`)
          .all(id, id);
        for (const c of stuck) endCall(c.id, 'ended', id);
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

export { hydrateMessage };
