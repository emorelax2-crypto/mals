import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

export const config = {
  port: Number(process.env.PORT || 3000),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  maxConcurrentReplies: Number(process.env.MAX_CONCURRENT_REPLIES || 50),
  historyLimit: Number(process.env.HISTORY_LIMIT || 24),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 8 * 1024 * 1024),
};

export function assertConfig() {
  const problems = [];
  if (!config.anthropicApiKey) problems.push('ANTHROPIC_API_KEY не задан — ассистент не сможет отвечать.');
  if (!config.adminPassword) problems.push('ADMIN_PASSWORD не задан — вход в админку заблокирован.');
  return problems;
}
