/**
 * Сквозной тест в настоящем браузере: два пользователя, переписка, подарки,
 * кошелёк и видеозвонок по WebRTC.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   npm run seed && npm start        # в отдельном терминале
 *   npm test
 *
 * Переменные окружения: BASE_URL, SHOTS_DIR, CHROMIUM_PATH.
 */
import { mkdirSync } from 'node:fs';
import { chromium, devices } from 'playwright';

const SHOTS = process.env.SHOTS_DIR || 'test-shots';
mkdirSync(SHOTS, { recursive: true });
const URL = process.env.BASE_URL || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const fails = [];
const check = (cond, label) => { console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}`); if (!cond) fails.push(label); };

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});

const phone = { ...devices['iPhone 13'], isMobile: true, hasTouch: true };
const mk = async (name) => {
  const ctx = await browser.newContext({ ...phone, permissions: ['microphone', 'camera'] });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log(`   [${name} console] ${m.text()}`); });
  page.on('pageerror', (e) => console.log(`   [${name} pageerror] ${e.message}`));
  await page.goto(URL);
  return { ctx, page };
};

const login = async (page, username) => {
  await page.waitForSelector('#screen-auth:not([hidden])');
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', '123456');
  await page.click('#auth-submit');
  await page.waitForSelector('#screen-app:not([hidden])', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#connection-status')?.textContent === 'в сети', { timeout: 10000 });
};

/* ---------- 1. Вход ---------- */
log('вход alice и bob');
const A = await mk('alice');
const B = await mk('bob');
await login(A.page, 'alice');
await login(B.page, 'bob');
check(true, 'обе сессии авторизованы и подключены к WebSocket');
await A.page.screenshot({ path: `${SHOTS}/01-chats.png` });

/* ---------- 2. Список чатов и открытие ---------- */
const openDm = async (page, name) => {
  await page.click(`.row:has-text("${name}")`);
  await page.waitForSelector('#screen-chat:not([hidden])');
};
await openDm(A.page, 'Боб');
await openDm(B.page, 'Алиса');
check(await A.page.textContent('#chat-title') === 'Боб', 'у Алисы открыт чат с Бобом');
check(await B.page.textContent('#chat-status') === 'в сети', 'Боб видит статус «в сети»');
await A.page.screenshot({ path: `${SHOTS}/02-chat.png` });

/* ---------- 3. Сообщение в реальном времени ---------- */
log('сообщение alice → bob');
const text = 'Проверка связи ' + Date.now();
await A.page.fill('#composer-input', text);
await A.page.click('#composer-send');
await B.page.waitForFunction((t) => document.querySelector('#message-list')?.textContent.includes(t), text, { timeout: 8000 });
check(true, 'сообщение доставлено по WebSocket мгновенно');

/* индикатор набора */
await B.page.fill('#composer-input', 'печ');
await A.page.waitForSelector('#typing-line:not([hidden])', { timeout: 6000 });
check(true, 'индикатор «печатает…» работает');
await B.page.fill('#composer-input', '');

/* ---------- 4. Подарок за звёзды ---------- */
log('bob дарит подарок alice');
const balanceBefore = Number(await B.page.textContent('#balance-top'));
const giftsBefore = (await A.page.$$('.giftcard')).length;
await B.page.click('#open-gift');
await B.page.waitForSelector('.sheet .gift-grid');
await B.page.screenshot({ path: `${SHOTS}/03-gifts.png` });
await B.page.click('[data-gift="diamond"]');
await B.page.waitForSelector('#gift-send');
await B.page.fill('#gift-note', 'За отличную работу!');
await B.page.screenshot({ path: `${SHOTS}/04-gift-confirm.png` });
await B.page.click('#gift-send');

// Подарок считается доставленным, когда у получателя появилась новая карточка,
// а у отправителя списались звёзды — оба события приходят по WebSocket.
await A.page.waitForFunction((n) => document.querySelectorAll('.giftcard').length > n, giftsBefore, { timeout: 8000 });
await B.page.waitForFunction(
  (b) => Number(document.querySelector('#balance-top').textContent) === b - 250,
  balanceBefore, { timeout: 8000 });
const balanceAfter = Number(await B.page.textContent('#balance-top'));
check(balanceAfter === balanceBefore - 250, `со счёта списано 250 ⭐ (${balanceBefore} → ${balanceAfter})`);
check(await A.page.textContent('#message-list').then((t) => t.includes('Бриллиант')), 'подарок пришёл получателю в чат');
await A.page.screenshot({ path: `${SHOTS}/05-gift-received.png` });

/* подарок в профиле получателя */
await A.page.click('#chat-back');
await A.page.click('[data-goto="profile"]');
await A.page.waitForSelector('.showcase__item');
const showcase = await A.page.textContent('.showcase');
check(showcase.includes('💎'), 'подарок отображается в витрине профиля');
await A.page.screenshot({ path: `${SHOTS}/06-profile.png` });

/* ---------- 5. Кошелёк ---------- */
log('пополнение кошелька (demo)');
await A.page.click('[data-wallet]');
await A.page.waitForSelector('[data-pack]');
await A.page.screenshot({ path: `${SHOTS}/07-wallet.png` });
const before = Number(await A.page.textContent('#balance-top'));
await A.page.click('[data-pack="pack_500"]');
await A.page.waitForFunction((b) => Number(document.querySelector('#balance-top').textContent) > b, before, { timeout: 8000 });
const after = Number(await A.page.textContent('#balance-top'));
check(after === before + 525, `начислено 525 ⭐ (${before} → ${after})`);

/* ---------- 6. Витрина подарков ---------- */
await A.page.click('[data-goto="gifts"]');
await A.page.waitForSelector('#gift-store .gift-grid');
await A.page.screenshot({ path: `${SHOTS}/08-store.png` });
check((await A.page.$$('#gift-store .gift-cell')).length === 14, 'в каталоге 14 подарков');

/* ---------- 7. Видеозвонок ---------- */
log('видеозвонок alice → bob');
await A.page.click('[data-goto="chats"]');
await openDm(A.page, 'Боб');
await A.page.click('#call-video');
await B.page.waitForSelector('#call-overlay:not([hidden])', { timeout: 8000 });
check(await B.page.isVisible('[data-call="accept"]'), 'Бобу пришёл входящий звонок');
await B.page.screenshot({ path: `${SHOTS}/09-incoming-call.png` });

await B.page.click('[data-call="accept"]');
await A.page.waitForSelector('#call-overlay.is-active', { timeout: 20000 });
await B.page.waitForSelector('#call-overlay.is-active', { timeout: 20000 });
check(true, 'WebRTC-соединение установлено с обеих сторон');

const stats = await A.page.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const v = document.querySelector('#call-remote-video');
  return { w: v.videoWidth, h: v.videoHeight, hasRemote: document.querySelector('#call-overlay').classList.contains('has-remote') };
});
check(stats.w > 0 && stats.h > 0, `входящее видео идёт (${stats.w}×${stats.h})`);
await A.page.screenshot({ path: `${SHOTS}/10-call-active.png` });
await B.page.screenshot({ path: `${SHOTS}/11-call-active-b.png` });

await A.page.click('[data-call="hangup"]');
await B.page.waitForSelector('#call-overlay', { state: 'hidden', timeout: 8000 });
await A.page.waitForFunction(() => document.querySelector('#message-list')?.textContent.includes('видеозвонок'), null, { timeout: 8000 });
check(true, 'звонок завершён, в чат добавлена запись о звонке');
await A.page.screenshot({ path: `${SHOTS}/12-after-call.png` });

/* ---------- 8. PWA ---------- */
const sw = await A.page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  const man = await fetch('/manifest.webmanifest').then((r) => r.json());
  return { sw: !!reg?.active || !!reg?.installing, name: man.name, icons: man.icons.length, display: man.display };
});
check(sw.sw, 'service worker зарегистрирован');
check(sw.display === 'standalone' && sw.icons === 3, `манифест PWA корректен (${sw.name}, ${sw.icons} иконки)`);

console.log(fails.length ? `\nПРОВАЛЕНО: ${fails.length}\n- ${fails.join('\n- ')}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
await browser.close();
process.exit(fails.length ? 1 : 0);
