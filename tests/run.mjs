/**
 * Запуск проверок: node tests/run.mjs
 * Поднимает сервер на отдельном порту с временной базой, гоняет тесты, гасит сервер.
 * Ключ Anthropic не нужен — проверяется всё, кроме самого ответа модели.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mals-test-'));

const env = {
  ...process.env,
  PORT: '3222',
  PUBLIC_URL: 'http://localhost:3222',
  ADMIN_PASSWORD: 'test-pass',
  DATA_DIR: dataDir,
  ANTHROPIC_API_KEY: '',
};

const run = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, file)], { env, stdio: 'inherit', cwd: root });
    child.on('exit', resolve);
  });

const waitForServer = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://localhost:3222/healthz');
      if (res.ok) return true;
    } catch { /* сервер ещё поднимается */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

console.log('\n── Очередь ответов ──');
const queueCode = await run('queue.test.mjs');

console.log('── Сервер и API ──');
const server = spawn(process.execPath, [path.join(root, 'src', 'server.js')], { env, stdio: 'ignore', cwd: root });

let e2eCode = 1;
try {
  if (!(await waitForServer())) throw new Error('сервер не поднялся за 10 секунд');
  e2eCode = await run('e2e.test.mjs');
} catch (error) {
  console.error('  ✗', error.message);
} finally {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const failed = queueCode !== 0 || e2eCode !== 0;
console.log(failed ? '❌ Есть упавшие проверки\n' : '✅ Все проверки пройдены\n');
process.exit(failed ? 1 : 0);
