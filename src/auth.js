import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'mals_session';
const TTL_MS = 7 * 24 * 3600 * 1000;

const sign = (payload) =>
  crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');

export function issueToken() {
  const payload = String(Date.now() + TTL_MS);
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  return Number(payload) > Date.now();
}

export function checkPassword(input) {
  if (!config.adminPassword) return false;
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(config.adminPassword);
  // Длины сравниваем отдельно: timingSafeEqual падает на разных размерах.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function readCookie(req, name = COOKIE) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL_MS / 1000}`
  );
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export const isAuthed = (req) => verifyToken(readCookie(req));

export function requireAdmin(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'Требуется вход в админку' });
}
