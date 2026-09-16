/* ===========================================================
   MALS — клиентская логика: чаты, подарки, кошелёк, профиль.
   =========================================================== */
import { CallManager } from './call.js';

/* ------------------------------ утилиты ------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pad = (n) => String(n).padStart(2, '0');
const timeOf = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function dayLabel(ts) {
  const d = new Date(ts), today = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  const yesterday = new Date(today.getTime() - 864e5);
  if (same(d, today)) return 'Сегодня';
  if (same(d, yesterday)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function listTime(ts) {
  const d = new Date(ts), today = new Date();
  if (d.toDateString() === today.toDateString()) return timeOf(ts);
  if (today - d < 7 * 864e5) return d.toLocaleDateString('ru-RU', { weekday: 'short' });
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

const money = (amount, currency) => {
  try {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: currency.toUpperCase() })
      .format(amount / 100);
  } catch { return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`; }
};

function lastSeenText(user) {
  if (!user?.lastSeen) return 'был(а) давно';
  const diff = Date.now() - user.lastSeen;
  if (diff < 60e3) return 'был(а) только что';
  if (diff < 36e5) return `был(а) ${Math.floor(diff / 60e3)} мин назад`;
  if (diff < 864e5) return `был(а) ${Math.floor(diff / 36e5)} ч назад`;
  return `был(а) ${new Date(user.lastSeen).toLocaleDateString('ru-RU')}`;
}

const avatarHtml = (user, cls = '') => `
  <span class="avatar ${cls} ${state.online.has(user?.id) ? 'avatar--online' : ''}"
        style="--hue:${Number(user?.avatarHue ?? user?.hue ?? 220)}">${esc(user?.avatarEmoji ?? user?.icon ?? '👤')}</span>`;

/* ------------------------------ состояние ------------------------------ */
const state = {
  token: localStorage.getItem('mals.token') || '',
  me: null,
  config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], packs: [], payments: 'demo', currency: 'usd' },
  chats: [],
  chat: null,          // открытый чат { id, kind, title, icon, peer, members }
  messages: [],
  online: new Set(),
  typing: new Map(),   // chatId -> Map(userId -> timeoutId)
  tab: 'chats',
  filter: '',
  gifts: [],
  ws: null,
  wsRetry: 0,
  offline: false,
};

/* ------------------------------ сеть ------------------------------ */
async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Запрос не ушёл — устройство офлайн или сервер недоступен.
    const err = new Error('Нет подключения к сети');
    err.offline = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ------------------------- офлайн-кэш ------------------------- */
/** Последнее известное состояние, чтобы приложение открывалось без сети. */
const cache = {
  get(key, fallback = null) {
    try { return JSON.parse(localStorage.getItem(`mals.cache.${key}`)) ?? fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`mals.cache.${key}`, JSON.stringify(value)); } catch {}
  },
  clear() {
    for (const k of Object.keys(localStorage)) if (k.startsWith('mals.cache.')) localStorage.removeItem(k);
  },
};

/* ------------------------------ тосты ------------------------------ */
function toast(text, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind ? `toast--${kind}` : ''}`;
  node.innerHTML = text;
  $('#toasts').append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(-10px)';
    setTimeout(() => node.remove(), 260);
  }, 3200);
}

/* ------------------------------ шторки ------------------------------ */
function sheet({ title, body, onMount }) {
  closeSheet();
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `
    <div class="sheet">
      <div class="sheet__grip"></div>
      <div class="sheet__head"><h3>${esc(title)}</h3>
        <button class="icon-btn" data-close><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>
      <div class="sheet__body">${body}</div>
    </div>`;
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('[data-close]')) closeSheet();
  });
  $('#sheet-root').append(backdrop);
  onMount?.($('.sheet', backdrop));
  return backdrop;
}
const closeSheet = () => { $('#sheet-root').innerHTML = ''; };

/* ============================ авторизация ============================ */
let authMode = 'login';

$$('[data-auth-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    authMode = btn.dataset.authTab;
    $$('[data-auth-tab]').forEach((b) => b.classList.toggle('is-active', b === btn));
    $$('[data-only="register"]').forEach((f) => { f.hidden = authMode !== 'register'; });
    $('#auth-submit').textContent = authMode === 'login' ? 'Войти' : 'Создать аккаунт';
    $('#auth-error').hidden = true;
  });
});

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const btn = $('#auth-submit');
  btn.disabled = true;
  $('#auth-error').hidden = true;
  try {
    const data = await api(`/auth/${authMode}`, {
      method: 'POST',
      body: {
        username: form.get('username'),
        password: form.get('password'),
        displayName: form.get('displayName'),
      },
    });
    state.token = data.token;
    localStorage.setItem('mals.token', data.token);
    state.me = data.user;
    await enterApp();
  } catch (err) {
    const box = $('#auth-error');
    box.textContent = err.message;
    box.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST' }); } catch {}
  localStorage.removeItem('mals.token');
  cache.clear();
  state.ws?.close();
  location.reload();
});

/* ============================ WebSocket ============================ */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.wsRetry = 0;
    ws.send(JSON.stringify({ t: 'auth', token: state.token }));
  });

  ws.addEventListener('message', (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    handleSocket(msg);
  });

  ws.addEventListener('close', () => {
    setStatus(navigator.onLine ? 'нет соединения' : 'нет сети');
    if (!navigator.onLine) setOffline(true);
    if (!state.token) return;
    const delay = Math.min(15000, 800 * 2 ** state.wsRetry++);
    setTimeout(connect, delay);
  });
}

const wsSend = (payload) => {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
};

function setStatus(text) {
  const node = $('#connection-status');
  if (node) node.textContent = text;
}

/* ------------------------- состояние сети ------------------------- */
function setOffline(on, reason = '') {
  state.offline = on;
  if (on) state.online.clear();   // без связи мы не знаем, кто в сети
  const bar = $('#offline-bar');
  const pending = cache.get('outbox', []).length;
  bar.hidden = !on;
  if (on) {
    $('#offline-text').textContent = pending
      ? `Нет сети — ${pending} сообщ. отправится автоматически`
      : (reason || 'Нет сети — работаем офлайн');
    setStatus('нет сети');
  }
}

window.addEventListener('offline', () => setOffline(true));
window.addEventListener('online', () => {
  setStatus('подключение…');
  resync();
});

/** Возврат в сеть: обновляем данные, поднимаем сокет, досылаем очередь. */
async function resync() {
  if (!state.token || !state.me) return;
  try {
    state.me = await api('/me');
    cache.set('me', state.me);
    renderBalance();
    renderMeAvatar();
    setOffline(false);
    await flushOutbox();
    await loadChats();
    if (state.chat) await refreshOpenChat();
    if (state.ws?.readyState !== WebSocket.OPEN) connect();
  } catch (err) {
    if (err.offline) setOffline(true);
  }
}

/* ------------------------- очередь отправки ------------------------- */
/** Сообщения, написанные без сети, ждут своей очереди в localStorage. */
function queueMessage(chatId, body) {
  const item = { id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, chatId, body, createdAt: Date.now() };
  cache.set('outbox', [...cache.get('outbox', []), item]);
  return item;
}

async function flushOutbox() {
  const outbox = cache.get('outbox', []);
  if (outbox.length === 0) return;

  const stillWaiting = [];
  let sent = 0;
  let rejected = 0;

  for (const item of outbox) {
    try {
      await api(`/chats/${item.chatId}/messages`, { method: 'POST', body: { body: item.body } });
      sent++;
    } catch (err) {
      if (err.offline) stillWaiting.push(item);   // сеть снова пропала — оставляем в очереди
      else rejected++;                             // чат недоступен или текст отклонён — не копим вечно
    }
  }

  cache.set('outbox', stillWaiting);
  if (sent) toast(`Отправлено сообщений: ${sent}`);
  if (rejected) toast(`Не удалось отправить: ${rejected}`, 'error');
  if (stillWaiting.length) setOffline(true);
}

/** Неотправленные сообщения для чата — показываем их в ленте с часиками. */
const pendingFor = (chatId) =>
  cache.get('outbox', [])
    .filter((m) => m.chatId === chatId)
    .map((m) => ({
      id: m.id, chatId: m.chatId, senderId: state.me.id, kind: 'text',
      body: m.body, meta: {}, createdAt: m.createdAt, pending: true,
    }));

async function handleSocket(msg) {
  if (msg.t?.startsWith('call:')) { await calls.handle(msg); return; }

  switch (msg.t) {
    case 'auth:ok':
      state.online = new Set(msg.online);
      setStatus('в сети');
      setOffline(false);
      renderChats();
      flushOutbox().then(() => { if (state.chat) refreshOpenChat(); });
      break;

    case 'auth:error':
      localStorage.removeItem('mals.token');
      location.reload();
      break;

    case 'presence':
      msg.online ? state.online.add(msg.userId) : state.online.delete(msg.userId);
      renderChats();
      if (state.chat?.peer?.id === msg.userId) renderChatHeader();
      break;

    case 'message':
      onIncomingMessage(msg.message);
      break;

    case 'typing':
      onTyping(msg);
      break;

    case 'chats:refresh':
      loadChats();
      break;

    case 'wallet':
      state.me.balance = msg.balance;
      renderBalance();
      if (msg.credited) toast(`⭐ Зачислено ${msg.credited} звёзд`, 'gift');
      break;

    case 'gift:received': {
      const from = msg.from ? esc(msg.from.displayName) : 'Аноним';
      toast(`<span style="font-size:22px">${esc(msg.gift.emoji)}</span> <span>${from} дарит вам «${esc(msg.gift.name)}»</span>`, 'gift');
      if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
      break;
    }
  }
}

function onIncomingMessage(message) {
  if (state.chat?.id === message.chatId) {
    // Своё сообщение вернулось с сервера — убираем локальную копию с часиками.
    if (message.senderId === state.me.id) {
      state.messages = state.messages.filter((m) => !(m.pending && m.body === message.body));
    }
    state.messages.push(message);
    renderMessages();
    scrollToBottom();
    wsSend({ t: 'read', chatId: message.chatId });
  } else if (message.senderId !== state.me.id) {
    const chat = state.chats.find((c) => c.id === message.chatId);
    if (chat && state.tab !== 'chats') {
      const who = chat.members[0]?.displayName || chat.title;
      toast(`<b>${esc(who)}</b>&nbsp;<span style="color:var(--muted)">${esc(preview(message).slice(0, 40))}</span>`);
    }
  }
  loadChats();
}

function onTyping({ chatId, userId, on }) {
  if (!state.typing.has(chatId)) state.typing.set(chatId, new Map());
  const map = state.typing.get(chatId);
  clearTimeout(map.get(userId));
  if (on) map.set(userId, setTimeout(() => { map.delete(userId); renderTyping(); }, 4000));
  else map.delete(userId);
  renderTyping();
}

/* ============================ вкладки ============================ */
$$('[data-goto]').forEach((btn) => {
  btn.addEventListener('click', () => goTab(btn.dataset.goto));
});

function goTab(tab) {
  state.tab = tab;
  $$('.tab').forEach((s) => { s.hidden = s.dataset.tab !== tab; });
  $$('.tabbar__item').forEach((b) => b.classList.toggle('is-active', b.dataset.goto === tab));
  if (tab === 'gifts') renderGiftStore();
  if (tab === 'profile') renderOwnProfile();
}

/* ============================ список чатов ============================ */
function preview(message) {
  if (!message) return 'Нет сообщений';
  if (message.kind === 'gift') return `${message.meta.emoji} Подарок «${message.meta.name}»`;
  if (message.kind === 'call') {
    const s = message.meta.status;
    return s === 'missed' ? '📞 Пропущенный звонок' : s === 'declined' ? '📞 Звонок отклонён' : '📞 Звонок';
  }
  if (message.kind === 'system') return message.body;
  return message.body;
}

async function loadChats() {
  try {
    const data = await api('/chats');
    state.chats = data.chats;
    state.online = new Set(data.online);
    cache.set('chats', data.chats);
    setOffline(false);
    renderChats();
  } catch (err) {
    if (err.offline) { setOffline(true); renderChats(); return; }
    if (err.status === 401) { localStorage.removeItem('mals.token'); cache.clear(); location.reload(); }
  }
}

function renderChats() {
  const list = $('#chat-list');
  if (!list) return;

  const filter = state.filter.toLowerCase();
  const chats = state.chats.filter((c) => !filter || c.title.toLowerCase().includes(filter));

  const totalUnread = state.chats.reduce((n, c) => n + c.unread, 0);
  $('#tab-unread').hidden = totalUnread === 0;

  if (chats.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <span class="empty__emoji">💬</span>
        <b>${filter ? 'Ничего не найдено' : 'Пока пусто'}</b>
        <p>${filter ? 'Попробуйте другой запрос' : 'Найдите собеседника и начните переписку'}</p>
        ${filter ? '' : '<button class="btn btn--primary" data-new-chat>Новый чат</button>'}
      </div>`;
    return;
  }

  list.innerHTML = chats.map((c) => {
    const peer = c.kind === 'dm' ? c.members[0] : null;
    const isOnline = peer && state.online.has(peer.id);
    const last = c.lastMessage;
    const mine = last && last.senderId === state.me.id;
    return `
      <div class="row" data-chat="${c.id}">
        <span class="avatar ${isOnline ? 'avatar--online' : ''}" style="--hue:${c.hue}">${esc(c.icon)}</span>
        <div class="row__main">
          <div class="row__top">
            <span class="row__name">${esc(c.title)}</span>
            ${last ? `<span class="row__time">${listTime(last.createdAt)}</span>` : ''}
          </div>
          <div class="row__bottom">
            <span class="row__preview">${mine ? '<b>Вы: </b>' : c.kind === 'group' && last?.senderId ? `<b>${esc(nameOf(c, last.senderId))}: </b>` : ''}${esc(preview(last))}</span>
            ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

const nameOf = (chat, userId) =>
  chat.members.find((m) => m.id === userId)?.displayName ?? 'Кто-то';

$('#chat-list').addEventListener('click', (e) => {
  const row = e.target.closest('[data-chat]');
  if (row) openChat(row.dataset.chat);
  if (e.target.closest('[data-new-chat]')) openNewChat();
});

$('#chat-search').addEventListener('input', (e) => {
  state.filter = e.target.value;
  renderChats();
});

$('#new-chat').addEventListener('click', () => openNewChat());
$('#open-wallet').addEventListener('click', openWallet);
$$('[data-open-wallet]').forEach((b) => b.addEventListener('click', openWallet));
$('#open-own-profile').addEventListener('click', () => goTab('profile'));

/* ============================ экран чата ============================ */
async function openChat(chatId) {
  let data;
  try {
    data = await api(`/chats/${chatId}/messages`);
    cache.set(`chat:${chatId}`, data);
    setOffline(false);
  } catch (err) {
    data = cache.get(`chat:${chatId}`);
    if (!data) {
      toast(err.offline ? 'Этот чат ещё не загружен — нужна сеть' : esc(err.message), 'error');
      return;
    }
    setOffline(true);
  }

  const peer = data.chat.kind === 'dm' ? data.members.find((m) => m.id !== state.me.id) : null;
  state.chat = { ...data.chat, members: data.members, peer };
  state.messages = [...data.messages, ...pendingFor(chatId)];

  $('#screen-chat').hidden = false;
  renderChatHeader();
  renderMessages();
  renderTyping();
  scrollToBottom(false);

  api(`/chats/${chatId}/read`, { method: 'POST' }).then(loadChats).catch(() => {});
  wsSend({ t: 'read', chatId });
  history.pushState({ chat: chatId }, '', `#chat/${chatId}`);
}

/** Перечитывает открытый чат с сервера (после возврата в сеть). */
async function refreshOpenChat() {
  if (!state.chat) return;
  try {
    const data = await api(`/chats/${state.chat.id}/messages`);
    cache.set(`chat:${state.chat.id}`, data);
    state.messages = [...data.messages, ...pendingFor(state.chat.id)];
    renderMessages();
    scrollToBottom(false);
  } catch { /* остаёмся на том, что уже показано */ }
}

function closeChat() {
  state.chat = null;
  state.messages = [];
  $('#screen-chat').hidden = true;
  loadChats();
  if (location.hash.startsWith('#chat/')) history.replaceState({}, '', location.pathname);
}

$('#chat-back').addEventListener('click', closeChat);
window.addEventListener('popstate', () => { if (state.chat) closeChat(); });

function renderChatHeader() {
  const chat = state.chat;
  if (!chat) return;

  const avatar = $('#chat-avatar');
  avatar.style.setProperty('--hue', chat.peer?.avatarHue ?? 250);
  avatar.textContent = chat.peer?.avatarEmoji ?? chat.icon ?? '💬';
  avatar.classList.toggle('avatar--online', !!chat.peer && state.online.has(chat.peer.id));

  $('#chat-title').textContent = chat.title;

  const status = $('#chat-status');
  if (chat.kind === 'group') {
    status.textContent = `${chat.members.length} участника(ов)`;
    status.classList.remove('is-online');
  } else {
    const online = chat.peer && state.online.has(chat.peer.id);
    status.textContent = online ? 'в сети' : lastSeenText(chat.peer);
    status.classList.toggle('is-online', !!online);
  }
}

function renderMessages() {
  const list = $('#message-list');
  const chat = state.chat;
  if (!chat) return;

  if (state.messages.length === 0) {
    list.innerHTML = `<div class="empty"><span class="empty__emoji">👋</span>
      <b>Начните разговор</b><p>Отправьте первое сообщение или подарок</p></div>`;
    return;
  }

  let html = '';
  let lastDay = '';
  state.messages.forEach((m, i) => {
    const day = dayLabel(m.createdAt);
    if (day !== lastDay) { html += `<div class="daysep">${day}</div>`; lastDay = day; }

    const prev = state.messages[i - 1];
    const next = state.messages[i + 1];
    const first = !prev || prev.senderId !== m.senderId || prev.kind !== m.kind || m.createdAt - prev.createdAt > 6e5;
    const last = !next || next.senderId !== m.senderId || next.kind !== m.kind;
    html += messageHtml(m, { first, last });
  });
  list.innerHTML = html;
}

function messageHtml(m, { first, last }) {
  const mine = m.senderId === state.me.id;
  const sender = state.chat.members.find((u) => u.id === m.senderId);
  const cls = `msg ${mine ? 'msg--out' : 'msg--in'} ${first ? 'msg--first' : ''} ${last ? 'msg--last' : ''}`;
  const check = !mine ? ''
    : m.pending
      ? '<svg class="pending" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>';
  const meta = `<span class="msg__meta">${timeOf(m.createdAt)}${check}</span>`;

  if (m.kind === 'system') {
    return `<div class="msg msg--system"><div class="msg__bubble">${esc(m.body)}</div></div>`;
  }

  if (m.kind === 'call') {
    const { status, duration, video, callerId } = m.meta;
    const outgoing = callerId === state.me.id;
    const label = status === 'missed' ? (outgoing ? 'Нет ответа' : 'Пропущенный звонок')
      : status === 'declined' ? 'Звонок отклонён'
      : `${outgoing ? 'Исходящий' : 'Входящий'} ${video ? 'видеозвонок' : 'звонок'}`;
    const sub = duration ? `${Math.floor(duration / 60)} мин ${duration % 60} сек` : timeOf(m.createdAt);
    return `
      <div class="msg ${mine ? 'msg--out' : 'msg--in'} msg--first msg--last">
        <div class="callcard ${status === 'missed' ? 'callcard--missed' : ''}">
          <span class="callcard__icon"><svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/></svg></span>
          <span><b>${label}</b><i>${sub}</i></span>
        </div>
      </div>`;
  }

  if (m.kind === 'gift') {
    const g = m.meta;
    const toMe = g.toUserId === state.me.id;
    const who = g.anonymous && !mine ? 'Аноним' : (sender?.displayName ?? 'Кто-то');
    return `
      <div class="${cls}">
        <div class="giftcard tier-${esc(g.tier)}">
          <div class="giftcard__emoji">${esc(g.emoji)}</div>
          <div class="giftcard__name">${esc(g.name)}</div>
          <div class="giftcard__sub">${toMe ? `${esc(who)} дарит вам` : mine ? `Вы подарили ${esc(g.toName)}` : `${esc(who)} дарит ${esc(g.toName)}`}</div>
          <div class="giftcard__price">⭐ ${g.price}</div>
          ${m.body ? `<div class="giftcard__note">«${esc(m.body)}»</div>` : ''}
        </div>
      </div>`;
  }

  const author = !mine && state.chat.kind === 'group' && first
    ? `<span class="msg__author" style="--hue:${sender?.avatarHue ?? 220}">${esc(sender?.displayName ?? 'Кто-то')}</span>` : '';

  return `<div class="${cls}">${author}<div class="msg__bubble">${esc(m.body)}${meta}</div></div>`;
}

function renderTyping() {
  const line = $('#typing-line');
  const map = state.chat ? state.typing.get(state.chat.id) : null;
  const who = map ? [...map.keys()].filter((id) => id !== state.me.id) : [];
  line.hidden = who.length === 0;
  if (who.length) {
    const name = state.chat.members.find((m) => m.id === who[0])?.displayName ?? 'Собеседник';
    $('i', line).textContent = state.chat.kind === 'group' ? `${name} печатает…` : 'печатает…';
  }
}

function scrollToBottom(smooth = true) {
  const list = $('#message-list');
  requestAnimationFrame(() => {
    list.scrollTo({ top: list.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  });
}

/* отправка сообщения */
const input = $('#composer-input');

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}

let typingSent = 0;
input.addEventListener('input', () => {
  autoGrow();
  const nowTs = Date.now();
  if (state.chat && nowTs - typingSent > 2000) {
    typingSent = nowTs;
    wsSend({ t: 'typing', chatId: state.chat.id, on: true });
  }
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 720px)').matches) {
    e.preventDefault();
    sendMessage();
  }
});

$('#composer-send').addEventListener('click', sendMessage);

async function sendMessage() {
  const body = input.value.trim();
  if (!body || !state.chat) return;
  const chatId = state.chat.id;
  input.value = '';
  autoGrow();
  wsSend({ t: 'typing', chatId, on: false });

  try {
    await api(`/chats/${chatId}/messages`, { method: 'POST', body: { body } });
  } catch (err) {
    if (!err.offline) { toast(esc(err.message), 'error'); input.value = body; return; }

    // Сети нет: кладём в очередь и сразу показываем в ленте с часиками.
    const item = queueMessage(chatId, body);
    state.messages.push({
      id: item.id, chatId, senderId: state.me.id, kind: 'text',
      body, meta: {}, createdAt: item.createdAt, pending: true,
    });
    renderMessages();
    scrollToBottom();
    setOffline(true);
  }
}

/* ============================ звонки ============================ */
const calls = new CallManager({
  send: wsSend,
  iceServers: state.config.iceServers,
  onState: ({ type, text }) => {
    if (type === 'error') toast(esc(text), 'error');
    else if (type === 'ended') toast(esc(text));
  },
});

$('#call-audio').addEventListener('click', () => startCall(false));
$('#call-video').addEventListener('click', () => startCall(true));

function startCall(video) {
  if (!state.chat) return;
  if (!navigator.onLine || state.ws?.readyState !== WebSocket.OPEN) {
    toast('Звонок невозможен без подключения к сети', 'error');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Звонки требуют HTTPS или localhost', 'error');
    return;
  }
  calls.start({ id: state.chat.id, peer: state.chat.peer }, video);
}

$('#call-actions').addEventListener('click', (e) => {
  const action = e.target.closest('[data-call]')?.dataset.call;
  if (!action) return;
  ({
    accept: () => calls.accept(),
    decline: () => calls.decline(),
    hangup: () => calls.hangup(),
    mute: () => calls.toggleMute(),
    camera: () => calls.toggleCamera(),
    flip: () => calls.flipCamera(),
  })[action]?.();
});

/* ============================ подарки ============================ */
async function loadGifts() {
  try {
    const data = await api('/gifts');
    state.gifts = data.gifts;
    state.me.balance = data.balance;
    state.config.packs = data.packs;
    state.config.payments = data.payments;
    cache.set('gifts', { gifts: data.gifts, packs: data.packs, payments: data.payments });
    setOffline(false);
    renderBalance();
    return data;
  } catch (err) {
    const cached = cache.get('gifts');
    if (!err.offline || !cached) throw err;
    // Каталог показываем из кэша, но подарить без сети нельзя — об этом скажет кнопка.
    state.gifts = cached.gifts;
    state.config.packs = cached.packs;
    state.config.payments = cached.payments;
    setOffline(true);
    return { ...cached, balance: state.me?.balance ?? 0, offline: true };
  }
}

function giftCellHtml(g, balance) {
  return `
    <button class="gift-cell tier-${esc(g.tier)} ${balance < g.price ? 'is-locked' : ''}" data-gift="${esc(g.id)}">
      <div class="gift-cell__emoji">${esc(g.emoji)}</div>
      <div class="gift-cell__name">${esc(g.name)}</div>
      <div class="gift-cell__price">⭐ ${g.price}</div>
    </button>`;
}

async function renderGiftStore() {
  const root = $('#gift-store');
  root.innerHTML = '<div class="empty"><span class="spinner" style="margin:0 auto"></span></div>';

  let data;
  try {
    data = await loadGifts();
  } catch (err) {
    root.innerHTML = `<div class="empty"><span class="empty__emoji">📴</span>
      <b>${esc(err.message)}</b><p>Каталог откроется, когда появится связь</p></div>`;
    return;
  }

  root.innerHTML = `
    <div class="section">
      ${data.offline ? '<div class="notice"><span>📴</span><span>Нет сети: каталог показан из памяти телефона. Отправка подарков и пополнение заработают, когда связь вернётся.</span></div>' : ''}
      <div class="notice">
        <span>⭐</span>
        <span>${data.payments === 'stripe'
          ? 'Оплата картой через Stripe. Купленные звёзды сразу зачисляются на баланс.'
          : 'Сейчас включён DEMO-режим оплаты: звёзды начисляются мгновенно и деньги не списываются. Добавьте ключ Stripe в <code>.env</code>, чтобы включить реальные платежи.'}</span>
      </div>
      <button class="pack" data-open-wallet-inline>
        <span class="pack__icon">💳</span>
        <span class="pack__main"><span class="pack__stars">Пополнить кошелёк</span><br>
          <span class="pack__bonus">Баланс: ${data.balance} ⭐</span></span>
        <span class="pack__price">→</span>
      </button>

      <div class="section__title"><span>Каталог подарков</span><span>${state.gifts.length} шт.</span></div>
      <div class="gift-grid">${state.gifts.map((g) => giftCellHtml(g, data.balance)).join('')}</div>
    </div>`;

  root.onclick = async (e) => {
    if (e.target.closest('[data-open-wallet-inline]')) return openWallet();
    const id = e.target.closest('[data-gift]')?.dataset.gift;
    if (id) pickRecipient(state.gifts.find((g) => g.id === id));
  };
}

/** Выбор получателя для подарка из вкладки «Подарки». */
async function pickRecipient(gift) {
  const users = await api('/users?q=');
  sheet({
    title: `Кому дарим ${gift.emoji} ${gift.name}?`,
    body: users.length
      ? users.map((u) => `
        <div class="row" data-user="${u.id}">
          ${avatarHtml(u)}
          <div class="row__main">
            <div class="row__top"><span class="row__name">${esc(u.displayName)}</span></div>
            <div class="row__bottom"><span class="row__preview">@${esc(u.username)}</span></div>
          </div>
        </div>`).join('')
      : '<div class="empty"><span class="empty__emoji">🙈</span><p>Других пользователей пока нет</p></div>',
    onMount(node) {
      node.addEventListener('click', (e) => {
        const id = e.target.closest('[data-user]')?.dataset.user;
        if (id) openGiftConfirm(gift, users.find((u) => u.id === id));
      });
    },
  });
}

/** Шторка с каталогом внутри чата. */
$('#open-gift').addEventListener('click', async () => {
  let data;
  try { data = await loadGifts(); }
  catch (err) { return toast(esc(err.message), 'error'); }

  const peer = state.chat?.peer ?? state.chat?.members.find((m) => m.id !== state.me.id);
  if (!peer) return toast('Некому дарить в этом чате', 'error');

  sheet({
    title: `Подарок для ${peer.displayName}`,
    body: `
      <div class="notice"><span>⭐</span><span>Ваш баланс: <b>${data.balance}</b>. Подарок появится в чате и в профиле получателя.</span></div>
      <div class="gift-grid">${state.gifts.map((g) => giftCellHtml(g, data.balance)).join('')}</div>`,
    onMount(node) {
      node.addEventListener('click', (e) => {
        const id = e.target.closest('[data-gift]')?.dataset.gift;
        if (id) openGiftConfirm(state.gifts.find((g) => g.id === id), peer);
      });
    },
  });
});

function openGiftConfirm(gift, recipient) {
  sheet({
    title: 'Отправить подарок',
    body: `
      <div class="giftcard tier-${esc(gift.tier)}" style="margin:0 auto 18px">
        <div class="giftcard__emoji">${esc(gift.emoji)}</div>
        <div class="giftcard__name">${esc(gift.name)}</div>
        <div class="giftcard__sub">для ${esc(recipient.displayName)}</div>
        <div class="giftcard__price">⭐ ${gift.price}</div>
      </div>
      <label class="field">
        <span class="field__label">Сообщение к подарку</span>
        <div class="field__wrap"><input id="gift-note" class="field__input" maxlength="200" placeholder="С днём рождения!"></div>
      </label>
      <label class="card__row" style="border-radius:14px;background:var(--surface-2);margin-bottom:14px">
        <b>Отправить анонимно</b>
        <input type="checkbox" id="gift-anon" style="width:20px;height:20px;accent-color:var(--accent)">
      </label>
      <p class="form-error" id="gift-error" hidden></p>
      <button class="btn btn--primary btn--lg" id="gift-send">Подарить за ${gift.price} ⭐</button>
      <p style="text-align:center;color:var(--dim);font-size:12px;margin-top:10px">Баланс после покупки: ${Math.max(0, state.me.balance - gift.price)} ⭐</p>`,
    onMount(node) {
      $('#gift-send', node).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const res = await api('/gifts/send', {
            method: 'POST',
            body: {
              giftId: gift.id,
              toUserId: recipient.id,
              chatId: state.chat?.id && state.chat.kind === 'dm' ? state.chat.id : undefined,
              note: $('#gift-note', node).value,
              anonymous: $('#gift-anon', node).checked,
            },
          });
          state.me.balance = res.balance;
          renderBalance();
          closeSheet();
          toast(`${gift.emoji} Подарок отправлен!`, 'gift');
          if (state.chat?.id === res.message.chatId) {
            state.messages.push(res.message);
            renderMessages();
            scrollToBottom();
          } else {
            openChat(res.message.chatId);
          }
          loadChats();
        } catch (err) {
          const box = $('#gift-error', node);
          box.textContent = err.message;
          box.hidden = false;
          btn.disabled = false;
          if (String(err.message).includes('Не хватает')) {
            setTimeout(() => { closeSheet(); openWallet(); }, 900);
          }
        }
      });
    },
  });
}

/* ============================ кошелёк ============================ */
async function openWallet() {
  let data;
  try {
    data = await api('/wallet');
  } catch (err) {
    return toast(err.offline ? 'Пополнение недоступно без сети' : esc(err.message), 'error');
  }
  state.me.balance = data.balance;
  cache.set('me', state.me);
  renderBalance();

  sheet({
    title: 'Кошелёк',
    body: `
      <div style="text-align:center;padding:6px 0 18px">
        <div style="font-size:42px;font-weight:800;color:var(--star)">${data.balance} ⭐</div>
        <div style="color:var(--muted);font-size:13px">звёзд на балансе</div>
      </div>
      ${data.payments === 'demo'
        ? '<div class="notice"><span>🧪</span><span><b>DEMO-режим.</b> Пополнение проходит мгновенно и <b>без списания денег</b>. Для реальных платежей добавьте <code>STRIPE_SECRET_KEY</code> в <code>.env</code>.</span></div>'
        : '<div class="notice" style="background:rgba(46,166,255,.1);border-color:rgba(46,166,255,.25);color:#9ed6ff"><span>🔒</span><span>Оплата картой через Stripe Checkout. Данные карты обрабатывает Stripe.</span></div>'}
      <div class="section__title"><span>Пакеты звёзд</span></div>
      ${data.packs.map((p) => `
        <button class="pack" data-pack="${esc(p.id)}">
          <span class="pack__icon">${p.stars >= 2500 ? '💎' : p.stars >= 1000 ? '🌟' : p.stars >= 500 ? '✨' : '⭐'}</span>
          <span class="pack__main">
            <span class="pack__stars">${p.total} звёзд</span>
            ${p.bonus ? `<br><span class="pack__bonus">+${p.bonus} бонусом</span>` : ''}
          </span>
          <span class="pack__price">${money(p.amount, p.currency)}</span>
        </button>`).join('')}
      ${data.history.length ? `
        <div class="section__title"><span>История</span></div>
        <div class="card">${data.history.map((h) => `
          <div class="card__row">
            <b>${h.stars} ⭐</b>
            <span>${money(h.amount, h.currency)} · ${h.status === 'paid' ? 'оплачено' : h.status === 'pending' ? 'ожидает' : 'ошибка'}</span>
          </div>`).join('')}</div>` : ''}`,
    onMount(node) {
      node.addEventListener('click', async (e) => {
        const packId = e.target.closest('[data-pack]')?.dataset.pack;
        if (!packId) return;
        const btn = e.target.closest('[data-pack]');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span><span class="pack__main">Создаём платёж…</span>';
        try {
          const res = await api('/wallet/topup', { method: 'POST', body: { packId } });
          if (res.mode === 'stripe') {
            location.href = res.url;
          } else {
            state.me.balance = res.balance;
            renderBalance();
            closeSheet();
            toast(`⭐ Зачислено ${res.stars} звёзд (demo)`, 'gift');
          }
        } catch (err) {
          toast(esc(err.message), 'error');
          closeSheet();
        }
      });
    },
  });
}

function renderBalance() {
  const value = state.me?.balance ?? 0;
  $('#balance-top').textContent = value;
  $$('.balance-any').forEach((n) => { n.textContent = value; });
}

/** Аватар пользователя в шапке списка чатов. */
function renderMeAvatar() {
  const node = $('#open-own-profile');
  if (!node || !state.me) return;
  node.style.setProperty('--hue', state.me.avatarHue ?? 220);
  node.textContent = state.me.avatarEmoji ?? '🙂';
}

/* ============================ профиль ============================ */
async function renderOwnProfile() {
  let me, balance;
  try {
    me = await api(`/users/${state.me.id}`);
    const wallet = await api('/wallet');
    balance = wallet.balance;
    state.me.balance = balance;
    cache.set('profile', me);
    cache.set('me', state.me);
    setOffline(false);
  } catch (err) {
    me = cache.get('profile');
    balance = state.me?.balance ?? 0;
    if (!me) {
      $('#profile-body').innerHTML = `<div class="empty"><span class="empty__emoji">📴</span>
        <b>${esc(err.message)}</b><p>Профиль откроется, когда появится связь</p></div>`;
      return;
    }
    setOffline(true);
  }
  const wallet = { balance };
  renderBalance();

  $('#profile-body').innerHTML = `
    <div class="profile__head">
      ${avatarHtml({ ...me, id: null })}
      <h3 class="profile__name">${esc(me.displayName)}</h3>
      <p class="profile__username">@${esc(me.username)}</p>
      ${me.bio ? `<p class="profile__bio">${esc(me.bio)}</p>` : ''}
      <div class="profile__actions">
        <button class="btn btn--ghost" data-edit>Изменить профиль</button>
        <button class="btn btn--primary" data-wallet>⭐ ${wallet.balance}</button>
      </div>
    </div>
    <div class="section">
      <div class="section__title"><span>Мои подарки</span><span>${me.gifts.length} · ${me.giftValue} ⭐</span></div>
      ${me.gifts.length
        ? `<div class="showcase">${me.gifts.map((g) => `
            <div class="showcase__item tier-${esc(g.tier)}" title="${esc(g.name)}${g.from ? ` от ${esc(g.from.displayName)}` : ''}">
              ${esc(g.emoji)}<small>${g.price}</small>
            </div>`).join('')}</div>`
        : '<div class="empty" style="padding:26px"><span class="empty__emoji">🎁</span><p>Подарков пока нет</p></div>'}
      <div class="section__title"><span>Приложение</span></div>
      <div class="card">
        <div class="card__row"><b>Установить на телефон</b><span data-install>Как?</span></div>
        <div class="card__row"><b>Платежи</b><span>${state.config.payments === 'stripe' ? 'Stripe' : 'Demo'}</span></div>
        <div class="card__row"><b>Версия</b><span>1.0.0</span></div>
      </div>
    </div>`;

  $('#profile-body').onclick = (e) => {
    if (e.target.closest('[data-edit]')) openEditProfile(me);
    if (e.target.closest('[data-wallet]')) openWallet();
    if (e.target.closest('[data-install]')) showInstallHelp();
  };
}

function openEditProfile(me) {
  const emojis = ['🦊', '🐼', '🐨', '🦁', '🐸', '🐙', '🦉', '🐺', '🦄', '🐯', '🐵', '🐻', '🐷', '🐧', '🦋', '🌸'];
  sheet({
    title: 'Профиль',
    body: `
      <label class="field"><span class="field__label">Имя</span>
        <div class="field__wrap"><input id="p-name" class="field__input" value="${esc(me.displayName)}" maxlength="40"></div></label>
      <label class="field"><span class="field__label">О себе</span>
        <div class="field__wrap"><input id="p-bio" class="field__input" value="${esc(me.bio)}" maxlength="160" placeholder="Пара слов о вас"></div></label>
      <span class="field__label" style="padding-left:4px">Аватар</span>
      <div class="gift-grid" style="grid-template-columns:repeat(8,1fr);gap:6px;margin-bottom:16px">
        ${emojis.map((em) => `<button class="gift-cell" data-emoji="${em}"
          style="--tier-a:hsl(${Math.random() * 360} 60% 45%);--tier-b:#24262e;padding:8px 0">
          <div class="gift-cell__emoji" style="font-size:24px">${em}</div></button>`).join('')}
      </div>
      <button class="btn btn--primary btn--lg" id="p-save">Сохранить</button>`,
    onMount(node) {
      let emoji = me.avatarEmoji;
      let hue = me.avatarHue;
      node.addEventListener('click', (e) => {
        const picked = e.target.closest('[data-emoji]');
        if (picked) {
          emoji = picked.dataset.emoji;
          hue = Math.floor(Math.random() * 360);
          $$('[data-emoji]', node).forEach((b) => { b.style.outline = ''; });
          picked.style.outline = '2px solid var(--accent)';
        }
      });
      $('#p-save', node).addEventListener('click', async () => {
        await api('/me', {
          method: 'PATCH',
          body: { displayName: $('#p-name', node).value, bio: $('#p-bio', node).value, avatarEmoji: emoji, avatarHue: hue },
        });
        closeSheet();
        state.me = { ...state.me, displayName: $('#p-name', node).value, avatarEmoji: emoji, avatarHue: hue };
        renderMeAvatar();
        renderOwnProfile();
        loadChats();
        toast('Профиль обновлён');
      });
    },
  });
}

/** Профиль собеседника из шапки чата. */
$('#chat-peer').addEventListener('click', async () => {
  if (!state.chat) return;
  if (state.chat.kind === 'group') {
    return sheet({
      title: state.chat.title,
      body: state.chat.members.map((m) => `
        <div class="row">${avatarHtml(m)}
          <div class="row__main"><div class="row__top"><span class="row__name">${esc(m.displayName)}</span></div>
          <div class="row__bottom"><span class="row__preview">@${esc(m.username)}</span></div></div>
        </div>`).join(''),
    });
  }
  openUserProfile(state.chat.peer.id);
});

async function openUserProfile(userId) {
  const user = await api(`/users/${userId}`);
  sheet({
    title: 'Профиль',
    body: `
      <div class="profile__head" style="padding-top:0">
        ${avatarHtml(user)}
        <h3 class="profile__name">${esc(user.displayName)}</h3>
        <p class="profile__username">@${esc(user.username)} · ${user.online ? '<span style="color:var(--success)">в сети</span>' : esc(lastSeenText(user))}</p>
        ${user.bio ? `<p class="profile__bio">${esc(user.bio)}</p>` : ''}
        <div class="profile__actions">
          <button class="btn btn--primary" data-gift-to>🎁 Подарить</button>
          <button class="btn btn--ghost" data-write>Написать</button>
        </div>
      </div>
      <div class="section__title"><span>Подарки</span><span>${user.gifts.length} · ${user.giftValue} ⭐</span></div>
      ${user.gifts.length
        ? `<div class="showcase">${user.gifts.map((g) => `
            <div class="showcase__item tier-${esc(g.tier)}">${esc(g.emoji)}<small>${g.price}</small></div>`).join('')}</div>`
        : '<div class="empty" style="padding:20px"><p>Подарков пока нет — станьте первым</p></div>'}`,
    onMount(node) {
      node.addEventListener('click', async (e) => {
        if (e.target.closest('[data-write]')) {
          const { chatId } = await api('/chats/dm', { method: 'POST', body: { userId: user.id } });
          closeSheet();
          openChat(chatId);
        }
        if (e.target.closest('[data-gift-to]')) {
          await loadGifts();
          sheet({
            title: `Подарок для ${user.displayName}`,
            body: `<div class="gift-grid">${state.gifts.map((g) => giftCellHtml(g, state.me.balance)).join('')}</div>`,
            onMount(inner) {
              inner.addEventListener('click', (ev) => {
                const id = ev.target.closest('[data-gift]')?.dataset.gift;
                if (id) openGiftConfirm(state.gifts.find((g) => g.id === id), user);
              });
            },
          });
        }
      });
    },
  });
}

/* ============================ новый чат ============================ */
function openNewChat() {
  sheet({
    title: 'Новый чат',
    body: `
      <div class="searchbar" style="padding:0 0 12px">
        <input id="user-search" class="searchbar__input" placeholder="Поиск по имени или @username" autocapitalize="none">
      </div>
      <button class="pack" id="make-group"><span class="pack__icon">👥</span>
        <span class="pack__main"><span class="pack__stars">Создать группу</span></span><span class="pack__price">→</span></button>
      <div class="section__title"><span>Пользователи</span></div>
      <div id="user-results"><div class="empty"><span class="spinner" style="margin:0 auto"></span></div></div>`,
    onMount(node) {
      const results = $('#user-results', node);

      const search = async (term = '') => {
        let users;
        try {
          users = await api(`/users?q=${encodeURIComponent(term)}`);
        } catch (err) {
          results.innerHTML = `<div class="empty"><span class="empty__emoji">📴</span>
            <b>${esc(err.message)}</b><p>Поиск людей работает только при связи с сервером</p></div>`;
          return;
        }
        results.innerHTML = users.length ? users.map((u) => `
          <div class="row" data-user="${u.id}">
            ${avatarHtml(u)}
            <div class="row__main">
              <div class="row__top"><span class="row__name">${esc(u.displayName)}</span></div>
              <div class="row__bottom"><span class="row__preview">@${esc(u.username)} · ${u.online ? 'в сети' : esc(lastSeenText(u))}</span></div>
            </div>
          </div>`).join('')
          : '<div class="empty"><span class="empty__emoji">🔍</span><p>Никого не нашлось</p></div>';
      };
      search();

      let debounce;
      $('#user-search', node).addEventListener('input', (e) => {
        clearTimeout(debounce);
        debounce = setTimeout(() => search(e.target.value), 250);
      });

      results.addEventListener('click', async (e) => {
        const id = e.target.closest('[data-user]')?.dataset.user;
        if (!id) return;
        const { chatId } = await api('/chats/dm', { method: 'POST', body: { userId: id } });
        closeSheet();
        await loadChats();
        openChat(chatId);
      });

      $('#make-group', node).addEventListener('click', openGroupCreator);
    },
  });
}

async function openGroupCreator() {
  const users = await api('/users?q=');
  const picked = new Set();
  sheet({
    title: 'Новая группа',
    body: `
      <label class="field"><span class="field__label">Название</span>
        <div class="field__wrap"><input id="g-title" class="field__input" placeholder="Например, Друзья" maxlength="60"></div></label>
      <div class="section__title"><span>Участники</span><span id="g-count">0</span></div>
      ${users.map((u) => `
        <div class="row" data-user="${u.id}">
          ${avatarHtml(u)}
          <div class="row__main"><div class="row__top"><span class="row__name">${esc(u.displayName)}</span></div>
            <div class="row__bottom"><span class="row__preview">@${esc(u.username)}</span></div></div>
          <input type="checkbox" style="width:20px;height:20px;accent-color:var(--accent);pointer-events:none">
        </div>`).join('')}
      <button class="btn btn--primary btn--lg" id="g-create" style="margin-top:14px">Создать группу</button>`,
    onMount(node) {
      node.addEventListener('click', (e) => {
        const row = e.target.closest('[data-user]');
        if (!row) return;
        const id = row.dataset.user;
        picked.has(id) ? picked.delete(id) : picked.add(id);
        $('input', row).checked = picked.has(id);
        $('#g-count', node).textContent = picked.size;
      });
      $('#g-create', node).addEventListener('click', async () => {
        const title = $('#g-title', node).value.trim();
        if (!title) return toast('Введите название группы', 'error');
        try {
          const { chatId } = await api('/chats/group', { method: 'POST', body: { title, memberIds: [...picked] } });
          closeSheet();
          await loadChats();
          openChat(chatId);
        } catch (err) { toast(esc(err.message), 'error'); }
      });
    },
  });
}

/* ============================ установка PWA ============================ */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

function showInstallHelp() {
  if (installPrompt) { installPrompt.prompt(); installPrompt = null; return; }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  sheet({
    title: 'Установка на телефон',
    body: `
      <div class="notice"><span>📱</span><span>MALS — это PWA: приложение ставится прямо из браузера, без App Store и Google Play.</span></div>
      <div class="card">
        <div class="card__row"><b>${ios ? 'iPhone / iPad (Safari)' : 'Android (Chrome)'}</b></div>
        ${ios
          ? `<div class="card__row"><span>1. Нажмите «Поделиться» ⬆️ в нижней панели Safari</span></div>
             <div class="card__row"><span>2. Выберите «На экран “Домой”»</span></div>
             <div class="card__row"><span>3. Подтвердите — иконка MALS появится на рабочем столе</span></div>`
          : `<div class="card__row"><span>1. Откройте меню ⋮ в Chrome</span></div>
             <div class="card__row"><span>2. Выберите «Установить приложение»</span></div>
             <div class="card__row"><span>3. Подтвердите — MALS появится среди приложений</span></div>`}
      </div>
      <p style="color:var(--dim);font-size:12px;margin-top:14px">
        Для звонков нужен HTTPS (или localhost) — браузер иначе не даст доступ к микрофону и камере.</p>`,
  });
}

/* ============================ запуск ============================ */
async function enterApp() {
  $('#screen-auth').hidden = true;
  $('#screen-app').hidden = false;

  // Сначала поднимаем последнее известное состояние — приложение открывается мгновенно и без сети.
  const cachedMe = cache.get('me');
  const cachedChats = cache.get('chats');
  const cachedConfig = cache.get('config');
  if (cachedConfig) state.config = { ...state.config, ...cachedConfig };
  if (cachedMe) {
    state.me = cachedMe;
    state.chats = cachedChats || [];
    renderBalance();
    renderMeAvatar();
    renderChats();
  }
  goTab('chats');

  try {
    const config = await api('/config');
    state.config = { ...state.config, ...config };
    cache.set('config', config);
    calls.iceServers = state.config.iceServers;

    state.me = await api('/me');
    cache.set('me', state.me);
    renderBalance();
    renderMeAvatar();

    await loadChats();
    connect();
    setOffline(false);
    await flushOutbox();
    handlePaymentReturn();
  } catch (err) {
    // Без сети остаёмся в приложении на кэше; при 401 токен протух — уходим на вход.
    if (!err.offline) throw err;
    if (!state.me) throw err;
    setOffline(true);
    calls.iceServers = state.config.iceServers;
  }
}

/** Возврат со страницы оплаты Stripe: дожидаемся вебхука и показываем результат. */
async function handlePaymentReturn() {
  const params = new URLSearchParams(location.search);
  const status = params.get('payment');
  const id = params.get('id');
  if (!status) return;
  history.replaceState({}, '', location.pathname);

  if (status === 'cancel') return toast('Оплата отменена');
  if (!id) return;

  toast('Проверяем оплату…');
  for (let i = 0; i < 10; i++) {
    try {
      const res = await api(`/wallet/payment/${id}`);
      if (res.status === 'paid') {
        state.me.balance = res.balance;
        renderBalance();
        return toast(`⭐ Зачислено ${res.stars} звёзд`, 'gift');
      }
    } catch { break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  toast('Платёж ещё обрабатывается — звёзды придут автоматически');
}

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  if (!state.token) {
    $('#screen-auth').hidden = false;
    return;
  }
  try {
    await enterApp();
  } catch (err) {
    if (err.offline) {
      // Сети нет и кэша тоже — показываем оболочку с честной причиной.
      $('#screen-app').hidden = true;
      $('#screen-auth').hidden = false;
      setOffline(true, 'Нет сети — войти можно будет при подключении');
      return;
    }
    localStorage.removeItem('mals.token');
    cache.clear();
    state.token = '';
    $('#screen-app').hidden = true;
    $('#screen-auth').hidden = false;
  }
}

/* высота вьюпорта на мобильных (адресная строка «съедает» 100vh) */
const fixViewport = () => {
  document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
};
window.addEventListener('resize', fixViewport);
fixViewport();

boot();
