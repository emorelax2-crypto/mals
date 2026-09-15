/**
 * Кладёт браузерные сборки Tailwind, Alpine и Lucide в public/vendor.
 *
 * Оформление страницы грузится с CDN — так быстрее и ничего не весит в репозитории.
 * Эти копии нужны только как запасной путь: если CDN недоступен (корпоративная
 * сеть, блокировка, оффлайн-демо), страница подхватит ту же версию с вашего сервера.
 * Запускается автоматически после npm install.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'public', 'vendor');

const ASSETS = [
  ['@tailwindcss/browser/dist/index.global.js', 'tailwind.js'],
  ['alpinejs/dist/cdn.min.js', 'alpine.js'],
  ['lucide/dist/umd/lucide.min.js', 'lucide.js'],
];

fs.mkdirSync(target, { recursive: true });

let copied = 0;
for (const [from, to] of ASSETS) {
  const source = path.join(root, 'node_modules', from);
  if (!fs.existsSync(source)) {
    console.warn(`[vendor] пропущено: ${from} не найден`);
    continue;
  }
  fs.copyFileSync(source, path.join(target, to));
  copied += 1;
}
console.log(`[vendor] скопировано файлов: ${copied} → public/vendor`);
