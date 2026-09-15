import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Платёжный слой.
 *
 *  • Если задан STRIPE_SECRET_KEY — деньги принимаются по-настоящему через Stripe Checkout,
 *    а зачисление звёзд происходит только после подтверждения вебхуком.
 *  • Если ключа нет — включается DEMO-режим: пополнение проходит мгновенно и без денег,
 *    чтобы приложение можно было щупать локально. Интерфейс это честно подписывает.
 */
export const stripeKey = () => process.env.STRIPE_SECRET_KEY || '';
export const isLive = () => stripeKey().startsWith('sk_');

function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripeRequest(path, body) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formEncode(body).toString(),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || `Stripe ${res.status}`);
  return json;
}

/** Создаёт Checkout-сессию Stripe и возвращает ссылку на оплату. */
export async function createCheckoutSession({ pack, user, paymentId, publicUrl }) {
  return stripeRequest('checkout/sessions', {
    mode: 'payment',
    success_url: `${publicUrl}/?payment=success&id=${paymentId}`,
    cancel_url: `${publicUrl}/?payment=cancel&id=${paymentId}`,
    client_reference_id: paymentId,
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': pack.currency,
    'line_items[0][price_data][unit_amount]': pack.amount,
    'line_items[0][price_data][product_data][name]': `${pack.total} звёзд MALS`,
    'line_items[0][price_data][product_data][description]':
      pack.bonus > 0 ? `${pack.stars} + ${pack.bonus} бонусных звёзд` : 'Звёзды для подарков в MALS',
    metadata: { paymentId, userId: user.id, stars: pack.total },
  });
}

/** Проверяет подпись вебхука Stripe (schema: `t=timestamp,v1=signature`). */
export function verifyWebhookSignature(rawBody, signatureHeader, secret, toleranceSec = 300) {
  if (!secret || !signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i), p.slice(i + 1)];
    })
  );
  const timestamp = Number(parts.t);
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > toleranceSec) return false;

  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest();
  for (const candidate of signatureHeader.split(',').filter((p) => p.startsWith('v1='))) {
    const sig = Buffer.from(candidate.slice(3), 'hex');
    if (sig.length === expected.length && timingSafeEqual(sig, expected)) return true;
  }
  return false;
}

export function formatMoney(amountMinor, currency) {
  const value = amountMinor / 100;
  try {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: currency.toUpperCase() }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency.toUpperCase()}`;
  }
}
