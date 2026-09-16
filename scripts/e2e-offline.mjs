/**
 * Офлайн-сценарий: обрыв сети, перезапуск приложения без связи, письмо
 * в очередь и автоматическая доставка при возвращении сети.
 *
 *   npm run seed && npm start      # в отдельном терминале
 *   npm run test:offline
 */
import { mkdirSync } from 'node:fs';
import { chromium, devices } from 'playwright';
const SHOTS = process.env.SHOTS_DIR || 'test-shots';
mkdirSync(SHOTS, { recursive: true });
const fails = [];
const check = (c, l) => { console.log(c ? `  ✓ ${l}` : `  ✗ ${l}`); if (!c) fails.push(l); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const mk = async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('   [pageerror]', e.message));
  await page.goto(process.env.BASE_URL || 'http://localhost:3000');
  return { ctx, page };
};
const login = async (page, u) => {
  await page.waitForSelector('#screen-auth:not([hidden])');
  await page.fill('input[name=username]', u);
  await page.fill('input[name=password]', '123456');
  await page.click('#auth-submit');
  await page.waitForFunction(() => document.querySelector('#connection-status')?.textContent === 'в сети');
};

const A = await mk(); await login(A.page, 'alice');
const B = await mk(); await login(B.page, 'bob');
await A.page.click('.row:has-text("Боб")');
await A.page.waitForSelector('#screen-chat:not([hidden])');
await A.page.click('#chat-back');
await A.page.waitForTimeout(500);
await A.page.evaluate(() => navigator.serviceWorker.ready);

console.log('• рвём сеть и перезапускаем приложение');
await A.ctx.setOffline(true);
await A.page.reload();
await A.page.waitForTimeout(2500);

const state = await A.page.evaluate(() => ({
  app: !document.querySelector('#screen-app').hidden,
  auth: !document.querySelector('#screen-auth').hidden,
  token: !!localStorage.getItem('mals.token'),
  chats: document.querySelectorAll('.row[data-chat]').length,
  bar: !document.querySelector('#offline-bar').hidden,
  barText: document.querySelector('#offline-text')?.textContent,
}));
check(state.app && !state.auth, 'офлайн-запуск: приложение открылось, а не экран входа');
check(state.token, 'сессия сохранена');
check(state.chats > 0, `список чатов доступен из памяти (${state.chats})`);
check(state.bar, `показана плашка: «${state.barText}»`);
await A.page.screenshot({ path: `${SHOTS}/off-1-start.png` });

console.log('• открываем чат и пишем без сети');
await A.page.click('.row:has-text("Боб")');
await A.page.waitForSelector('#screen-chat:not([hidden])', { timeout: 5000 });
const cached = await A.page.$$('.msg');
check(cached.length > 0, `история чата открылась офлайн (${cached.length} сообщений)`);

const text = 'Это письмо ушло без интернета ' + Date.now();
await A.page.fill('#composer-input', text);
await A.page.click('#composer-send');
await A.page.waitForSelector('.msg__meta .pending', { timeout: 5000 });
const queued = await A.page.evaluate(() => JSON.parse(localStorage.getItem('mals.cache.outbox') || '[]').length);
check(queued === 1, `сообщение встало в очередь отправки (${queued})`);
check(await A.page.isVisible('.msg__meta .pending'), 'в ленте показано с часиками');
const gotIt = await B.page.evaluate((t) => document.body.textContent.includes(t), text);
check(!gotIt, 'собеседник его пока не получил — сети нет');
await A.page.screenshot({ path: `${SHOTS}/off-2-queued.png` });

console.log('• пробуем позвонить без сети');
await A.page.click('#call-audio');
await A.page.waitForSelector('.toast--error', { timeout: 4000 });
check((await A.page.textContent('.toast--error')).includes('без подключения'), 'звонок честно отклонён с объяснением');
check(await A.page.isHidden('#call-overlay'), 'экран звонка не открылся');

console.log('• возвращаем сеть');
await A.ctx.setOffline(false);
await A.page.evaluate(() => window.dispatchEvent(new Event('online')));
await B.page.waitForFunction((t) => document.body.textContent.includes(t), text, { timeout: 15000 })
  .then(() => check(true, 'очередь доставлена собеседнику автоматически'))
  .catch(() => check(false, 'очередь доставлена собеседнику автоматически'));

await A.page.waitForFunction(() => JSON.parse(localStorage.getItem('mals.cache.outbox') || '[]').length === 0, null, { timeout: 10000 })
  .then(() => check(true, 'очередь очищена'))
  .catch(() => check(false, 'очередь очищена'));
await A.page.waitForFunction(() => !document.querySelector('.msg__meta .pending'), null, { timeout: 10000 })
  .then(() => check(true, 'часики сменились на галочку'))
  .catch(() => check(false, 'часики сменились на галочку'));
check(await A.page.isHidden('#offline-bar'), 'плашка «нет сети» убрана');
await A.page.screenshot({ path: `${SHOTS}/off-3-delivered.png` });

console.log(fails.length ? `\nПРОВАЛЕНО: ${fails.length}\n- ${fails.join('\n- ')}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
await browser.close();
process.exit(fails.length ? 1 : 0);
