import { WebSocket } from 'ws';
import assert from 'node:assert';

const BASE = 'http://localhost:3222';
let cookie = '';
let passed = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, body, isForm) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}) };
  let payload;
  if (isForm) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

  const res = await fetch(BASE + path, { method, headers, body: payload });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

function check(name, condition, detail = '') {
  assert.ok(condition, `${name} ${detail}`);
  passed++;
  console.log('  ✓', name);
}

/* ---------- страницы ---------- */
{
  const health = await req('GET', '/healthz');
  check('сервер живой', health.data.ok === true);

  const landing = await req('GET', '/');
  check('лендинг отдаётся', typeof landing.data === 'string' && landing.data.includes('Mals Chat'));

  const widget = await req('GET', '/widget.js');
  check('widget.js отдаётся', typeof widget.data === 'string' && widget.data.includes('mals-launcher'));

  const admin = await req('GET', '/admin');
  check('админка отдаётся', typeof admin.data === 'string' && admin.data.includes('alpinejs'));
}

/* ---------- защита админки ---------- */
{
  const guarded = await req('GET', '/admin/api/settings');
  check('без входа админ-API закрыт', guarded.status === 401);

  const bad = await req('POST', '/admin/api/login', { password: 'wrong' });
  check('неверный пароль отклонён', bad.status === 401);

  const ok = await req('POST', '/admin/api/login', { password: 'test-pass' });
  check('вход по паролю работает', ok.status === 200 && ok.data.ok === true);

  const settings = await req('GET', '/admin/api/settings');
  check('настройки читаются после входа', settings.status === 200 && !!settings.data.settings.bot_name);
  check('встроенные правила отдаются в панель', settings.data.groundRules.includes('ИИ-ассистент'));
  check('модель — claude-opus-5', settings.data.model === 'claude-opus-5');
}

/* ---------- настройки ---------- */
{
  const saved = await req('PUT', '/admin/api/settings', { bot_name: 'Лена', persona: 'Продаём кроссовки.', effort: 'low' });
  check('настройки сохраняются', saved.data.settings.bot_name === 'Лена');

  const injected = await req('PUT', '/admin/api/settings', { some_evil_key: 'x', bot_role: 'консультант' });
  check('лишние поля не записываются', injected.data.settings.some_evil_key === undefined);
  check('разрешённые поля записываются', injected.data.settings.bot_role === 'консультант');
}

/* ---------- фото ---------- */
let mediaId = null;
{
  // однопиксельный PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'shoe.png');
  form.append('title', 'Кроссовки');
  const uploaded = await req('POST', '/admin/api/media', form, true);
  check('фото загружается', uploaded.status === 200 && uploaded.data.media.url.startsWith('/uploads/'));
  mediaId = uploaded.data.media.id;

  const fetched = await fetch(BASE + uploaded.data.media.url);
  check('загруженное фото доступно по ссылке', fetched.status === 200);

  const badForm = new FormData();
  badForm.append('file', new Blob([Buffer.from('#!/bin/sh')], { type: 'application/x-sh' }), 'hack.sh');
  const rejected = await req('POST', '/admin/api/media', badForm, true);
  check('не-картинка отклоняется', rejected.status === 400);
}

/* ---------- ключевые слова ---------- */
{
  const created = await req('POST', '/admin/api/triggers', {
    title: 'Цена кроссовок',
    keywords: 'цена, сколько стоит, почём',
    match_type: 'any',
    note: 'Кроссовки Runner Pro — 4900 ₽, доставка 2–5 дней.',
    media_id: mediaId,
    card: { name: 'Runner Pro', price: '4 900 ₽', url: 'https://example.com/runner', buttonText: 'Купить' },
    enabled: true,
    priority: 10,
  });
  check('правило создаётся', created.status === 200 && created.data.trigger.id > 0);

  const empty = await req('POST', '/admin/api/triggers', { keywords: '   ' });
  check('правило без слов отклоняется', empty.status === 400);

  const list = await req('GET', '/admin/api/triggers');
  check('правило в списке с картинкой', list.data.triggers[0].media_url?.startsWith('/uploads/'));
}

/* ---------- сопоставление ключевых слов ---------- */
{
  const { matchTriggers, triggersToAttachments, triggersToBriefing } = await import('../src/triggers.js');

  check('слово найдено в живой фразе', matchTriggers('Слушай, а сколько стоит эта пара?').length === 1);
  check('регистр и знаки не мешают', matchTriggers('ЦЕНА???').length === 1);
  check('ё нормализуется', matchTriggers('почём кроссы').length === 1);
  check('посторонняя фраза не срабатывает', matchTriggers('какая сегодня погода').length === 0);

  const matched = matchTriggers('цена?');
  const attachments = triggersToAttachments(matched, 'http://localhost:3222');
  check('к ответу прикладывается фото', attachments.some((a) => a.type === 'image' && a.url.startsWith('http')));
  check('к ответу прикладывается карточка', attachments.some((a) => a.type === 'card' && a.price === '4 900 ₽'));

  const briefing = triggersToBriefing(matched, 'http://localhost:3222');
  check('справка для модели содержит факты', briefing.includes('4900') && briefing.includes('Runner Pro'));
}

/* ---------- API-ключи и внешний API ---------- */
let apiKey = null;
{
  const created = await req('POST', '/admin/api/keys', { name: 'Telegram-бот' });
  apiKey = created.data.key.key;
  check('API-ключ создаётся', apiKey.startsWith('mals_'));

  const noKey = await fetch(BASE + '/api/v1/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_id: 'x', text: 'привет' }),
  });
  check('внешний API без ключа закрыт', noKey.status === 401);

  const wrongKey = await fetch(BASE + '/api/v1/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'mals_fake' },
    body: JSON.stringify({ contact_id: 'x', text: 'привет' }),
  });
  check('чужой ключ не работает', wrongKey.status === 401);

  const call = await fetch(BASE + '/api/v1/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ channel: 'telegram', contact_id: 'user-42', contact_name: 'Иван', text: 'сколько стоит?' }),
  });
  const callBody = await call.json();
  // Ключа Anthropic в тестовом окружении нет — ждём понятную ошибку, а не падение сервера
  check('сообщение принято и диалог создан', !!callBody.conversation_id);
  check('без ключа модели приходит внятная ошибка', call.status === 502 && callBody.code === 'no_api_key', JSON.stringify(callBody));

  const history = await fetch(BASE + '/api/v1/conversations/telegram/user-42', { headers: { 'X-API-Key': apiKey } });
  const historyBody = await history.json();
  check('история диалога доступна по внешнему id', historyBody.messages.some((m) => m.content === 'сколько стоит?'));
}

/* ---------- инбокс и перехват ---------- */
{
  const list = await req('GET', '/admin/api/conversations');
  const conversation = list.data.conversations.find((c) => c.channel === 'telegram');
  check('диалог виден в инбоксе', !!conversation);
  check('имя контакта сохранилось', conversation.contact_name === 'Иван');

  const opened = await req('GET', '/admin/api/conversations/' + conversation.id);
  check('переписка открывается', opened.data.messages.length >= 1);

  const reread = await req('GET', '/admin/api/conversations');
  check('счётчик непрочитанных сбрасывается при открытии',
        reread.data.conversations.find((c) => c.id === conversation.id).unread === 0);

  const takeover = await req('POST', `/admin/api/conversations/${conversation.id}/takeover`, { value: true });
  check('перехват диалога включается', takeover.data.takeover === true);

  const reply = await req('POST', `/admin/api/conversations/${conversation.id}/reply`, { text: 'Здравствуйте, это менеджер Пётр.' });
  check('менеджер пишет в диалог', reply.data.message.role === 'operator');

  // При перехвате ИИ молчит — даже без ключа Anthropic ответ 200, а не ошибка
  const afterTakeover = await fetch(BASE + '/api/v1/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ channel: 'telegram', contact_id: 'user-42', text: 'ещё вопрос' }),
  });
  const afterBody = await afterTakeover.json();
  check('при перехвате ИИ не отвечает', afterTakeover.status === 200 && afterBody.status === 'handled_by_operator');
}

/* ---------- виджет по WebSocket ---------- */
{
  const conversation = await req('POST', '/api/conversations', { visitorId: 'visitor-1' });
  check('виджет открывает диалог', !!conversation.data.conversationId);

  const events = [];
  const ws = new WebSocket('ws://localhost:3222/ws/widget?visitor=visitor-1');
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws timeout')), 3000);
  });
  ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  await sleep(300);
  check('после подключения приходит ready', events[0]?.type === 'ready');

  ws.send(JSON.stringify({ type: 'message', text: 'Привет, есть 42 размер?' }));
  await sleep(800);
  check('сообщение клиента возвращается в чат', events.some((e) => e.type === 'message' && e.message.content.includes('42 размер')));
  check('индикатор печати приходит', events.some((e) => e.type === 'typing' && e.value === true));
  check('ошибка генерации показывается клиенту понятным текстом',
        events.some((e) => e.type === 'error' && /менеджер/i.test(e.error)));
  ws.close();
}

/* ---------- WebSocket админки закрыт для чужих ---------- */
{
  const ws = new WebSocket('ws://localhost:3222/ws/admin');
  const code = await new Promise((resolve) => {
    ws.on('close', (c) => resolve(c));
    ws.on('error', () => resolve('error'));
    setTimeout(() => resolve('timeout'), 3000);
  });
  check('админский сокет без куки отвергается', code === 4401, String(code));
}

/* ---------- статистика ---------- */
{
  const stats = await req('GET', '/admin/api/stats');
  check('статистика считается', stats.data.stats.conversations >= 2);
  check('лимит очереди виден в панели', stats.data.queue.limit === 50);
}

console.log(`\nВсе ${passed} проверок пройдены\n`);
