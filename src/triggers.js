import { listTriggers, bumpTriggerHits } from './db.js';

const normalize = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Ищет правила, подходящие под сообщение клиента.
 * match_type: 'any' — сработает любое из слов, 'all' — нужны все слова.
 */
export function matchTriggers(text) {
  const haystack = normalize(text);
  if (!haystack) return [];

  const matched = [];
  for (const trigger of listTriggers({ onlyEnabled: true })) {
    const words = trigger.keywords
      .split(/[,\n]/)
      .map(normalize)
      .filter(Boolean);
    if (!words.length) continue;

    const hit = (word) => haystack.includes(word);
    const ok = trigger.match_type === 'all' ? words.every(hit) : words.some(hit);
    if (ok) matched.push(trigger);
  }

  matched.sort((a, b) => b.priority - a.priority || a.id - b.id);
  return matched.slice(0, 3); // больше трёх карточек за раз — это уже спам
}

export function registerHits(triggers) {
  bumpTriggerHits(triggers.map((t) => t.id));
}

/** Текстовая справка для модели: что известно про запрос клиента. */
export function triggersToBriefing(triggers, publicUrl) {
  if (!triggers.length) return '';
  const blocks = triggers.map((t) => {
    const lines = [`Правило «${t.title || t.keywords}»:`];
    if (t.note) lines.push(t.note);
    const card = t.card || {};
    if (card.name) lines.push(`Товар: ${card.name}`);
    if (card.price) lines.push(`Цена: ${card.price}`);
    if (card.description) lines.push(`Описание: ${card.description}`);
    if (card.url) lines.push(`Ссылка: ${card.url}`);
    if (t.media_url) lines.push(`К ответу уже прикреплено фото «${t.media_title || 'фото'}» — не описывай его текстом, просто упомяни, что прислал(а).`);
    return lines.join('\n');
  });

  return [
    'Справка по текущему сообщению клиента (от системы, клиент её не видит).',
    'Используй факты ниже, если они в тему. Не выдумывай того, чего здесь нет.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

/** Вложения, которые уйдут клиенту вместе с ответом. */
export function triggersToAttachments(triggers, publicUrl) {
  const attachments = [];
  for (const t of triggers) {
    if (t.media_url) {
      attachments.push({
        type: 'image',
        url: absolute(t.media_url, publicUrl),
        title: t.media_title || '',
      });
    }
    const card = t.card || {};
    if (card.name || card.price || card.url) {
      attachments.push({
        type: 'card',
        name: card.name || '',
        price: card.price || '',
        description: card.description || '',
        url: card.url || '',
        buttonText: card.buttonText || 'Открыть',
      });
    }
  }
  return attachments;
}

function absolute(url, publicUrl) {
  if (!url) return url;
  return /^https?:\/\//i.test(url) ? url : `${publicUrl}${url}`;
}
