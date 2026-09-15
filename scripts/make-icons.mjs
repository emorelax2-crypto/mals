/**
 * Генерирует иконки приложения без внешних зависимостей:
 * рисуем в буфер RGBA (со сглаживанием суперсэмплингом) и кодируем PNG вручную.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'web', 'icons');
mkdirSync(outDir, { recursive: true });

/* --------------------------- кодирование PNG --------------------------- */
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // бит на канал
  ihdr[9] = 6;    // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;  // фильтр None
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ----------------------------- рисование ----------------------------- */
const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Знаковое расстояние до скруглённого прямоугольника. */
function roundedRectSdf(px, py, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(px - cx) - (halfW - r);
  const dy = Math.abs(py - cy) - (halfH - r);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

/** Бумажный самолётик MALS: белый треугольник со «складкой». */
function planeAlpha(px, py, size) {
  const x = px / size, y = py / size;
  // Треугольник с вершинами, повторяющими логотип в шапке.
  const tri = (ax, ay, bx, by, cx, cy) => {
    const s = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const t = (cx - bx) * (y - by) - (cy - by) * (x - bx);
    const u = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
    return (s >= 0 && t >= 0 && u >= 0) || (s <= 0 && t <= 0 && u <= 0);
  };
  const body = tri(0.20, 0.50, 0.80, 0.24, 0.62, 0.78);
  const fold = tri(0.20, 0.50, 0.80, 0.24, 0.47, 0.60);
  const notch = tri(0.47, 0.60, 0.62, 0.78, 0.55, 0.585);
  return body && !notch ? (fold ? 1 : 0.72) : 0;
}

function renderIcon(size, { padding = 0 } = {}) {
  const ss = 3;                     // суперсэмплинг
  const dim = size * ss;
  const rgba = Buffer.alloc(size * size * 4);
  const radius = dim * 0.235;
  const inset = dim * padding;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x * ss + sx + 0.5;
          const py = y * ss + sy + 0.5;

          const d = roundedRectSdf(px, py, dim / 2, dim / 2, dim / 2 - inset, dim / 2 - inset, radius);
          const cover = clamp01(0.5 - d);
          if (cover <= 0) continue;

          // Диагональный градиент blurple → голубой Telegram.
          const t = clamp01((px / dim) * 0.45 + (py / dim) * 0.55);
          let cr = mix(88, 46, t), cg = mix(101, 166, t), cb = mix(242, 255, t);

          const plane = planeAlpha(px - dim * 0.06, py - dim * 0.02, dim);
          if (plane > 0) {
            cr = mix(cr, 255, plane);
            cg = mix(cg, 255, plane);
            cb = mix(cb, 255, plane);
          }
          r += cr * cover; g += cg * cover; b += cb * cover; a += cover;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      const alpha = a / n;
      rgba[i]     = alpha > 0 ? Math.round(r / a) : 0;
      rgba[i + 1] = alpha > 0 ? Math.round(g / a) : 0;
      rgba[i + 2] = alpha > 0 ? Math.round(b / a) : 0;
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { padding: 0.1 }],
  ['apple-touch-icon.png', 180, {}],
  ['favicon-64.png', 64, {}],
];

for (const [name, size, opts] of targets) {
  writeFileSync(join(outDir, name), renderIcon(size, opts));
  console.log(`  ✓ ${name} (${size}×${size})`);
}
console.log('Иконки готовы:', outDir);
