import { ReplyQueue } from '../src/queue.js';
import assert from 'node:assert';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Глобальный предел одновременных вызовов
{
  const q = new ReplyQueue(50);
  let peak = 0, active = 0, done = 0;
  const tasks = [];
  for (let i = 0; i < 200; i++) {
    tasks.push(q.run('conv-' + i, async () => {
      active++; peak = Math.max(peak, active);
      await sleep(20);
      active--; done++;
      return i;
    }));
  }
  await Promise.all(tasks);
  assert.strictEqual(done, 200, 'все 200 задач должны завершиться');
  assert.ok(peak <= 50, `пик параллелизма ${peak} не должен превышать 50`);
  assert.ok(peak >= 40, `пик ${peak} слишком низкий — очередь не загружает лимит`);
  console.log(`  ✓ 200 диалогов, пик одновременных вызовов = ${peak} (лимит 50)`);
}

// 2. Внутри одного диалога — строго по очереди
{
  const q = new ReplyQueue(50);
  const order = [];
  let concurrentInConv = 0, overlap = false;
  const tasks = [];
  for (let i = 0; i < 10; i++) {
    tasks.push(q.run('same-conv', async () => {
      if (concurrentInConv > 0) overlap = true;
      concurrentInConv++;
      await sleep(5);
      order.push(i);
      concurrentInConv--;
    }));
  }
  await Promise.all(tasks);
  assert.strictEqual(overlap, false, 'внутри диалога не должно быть параллельных ответов');
  assert.deepStrictEqual(order, [0,1,2,3,4,5,6,7,8,9], 'порядок сообщений в диалоге должен сохраняться');
  console.log('  ✓ внутри одного диалога ответы идут строго по порядку');
}

// 3. Падение одной задачи не рвёт цепочку диалога
{
  const q = new ReplyQueue(5);
  const results = [];
  const a = q.run('c1', async () => { throw new Error('bang'); }).catch((e) => results.push('err:' + e.message));
  const b = q.run('c1', async () => { results.push('ok'); });
  await Promise.all([a, b]);
  assert.deepStrictEqual(results, ['err:bang', 'ok'], 'вторая задача должна выполниться после упавшей');
  console.log('  ✓ ошибка одного ответа не блокирует следующий');
}

// 4. Слоты освобождаются после ошибок
{
  const q = new ReplyQueue(2);
  const tasks = [];
  for (let i = 0; i < 20; i++) {
    tasks.push(q.run('c' + i, async () => { await sleep(2); throw new Error('x'); }).catch(() => 'handled'));
  }
  const settled = await Promise.all(tasks);
  assert.strictEqual(settled.filter((r) => r === 'handled').length, 20);
  assert.strictEqual(q.inFlight, 0, 'после завершения не должно остаться занятых слотов');
  assert.strictEqual(q.pending, 0, 'очередь должна опустеть');
  console.log('  ✓ слоты освобождаются даже когда все вызовы падают');
}

console.log('\nОчередь: все проверки пройдены\n');
