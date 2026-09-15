/**
 * Очередь ответов.
 *
 * Два разных ограничения:
 *  1. Глобальный семафор — сколько запросов к модели летит одновременно
 *     (config.maxConcurrentReplies, по умолчанию 50). Диалогов может быть
 *     сколько угодно, лишние ждут в очереди несколько сотен миллисекунд.
 *  2. Замок на диалог — внутри одного диалога ответы генерируются строго
 *     по очереди, иначе два сообщения подряд дадут два ответа вперемешку.
 */
export class ReplyQueue {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.running = 0;
    this.waiting = [];
    this.chains = new Map(); // conversationId -> Promise
  }

  get pending() {
    return this.waiting.length;
  }

  get inFlight() {
    return this.running;
  }

  /** Ставит задачу в очередь диалога: внутри диалога — строго последовательно. */
  run(conversationId, task) {
    const previous = this.chains.get(conversationId) || Promise.resolve();
    const next = previous
      .catch(() => {}) // падение предыдущей задачи не должно рвать цепочку
      .then(() => this.#acquireAndRun(task));

    this.chains.set(conversationId, next);
    next.catch(() => {}).finally(() => {
      if (this.chains.get(conversationId) === next) this.chains.delete(conversationId);
    });
    return next;
  }

  #acquireAndRun(task) {
    return new Promise((resolve, reject) => {
      const start = async () => {
        this.running += 1;
        try {
          resolve(await task());
        } catch (err) {
          reject(err);
        } finally {
          this.running -= 1;
          const nextStart = this.waiting.shift();
          if (nextStart) nextStart();
        }
      };

      if (this.running < this.limit) start();
      else this.waiting.push(start);
    });
  }
}
