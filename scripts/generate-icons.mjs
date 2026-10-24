import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Minimal dependency-free PNG writer for the PWA icons. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const body = Buffer.concat([name, data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function png(width, height, paint) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y, width, height);
      const i = (y * width + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = a;
    }
  }
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const insideRoundRect = (x, y, left, top, right, bottom, radius) => {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
};

function icon(size, maskable) {
  const scale = size / 512;
  const padding = maskable ? 0 : size * 0.09;
  const card = maskable ? size * 0.2 : size * 0.14;
  const cardTop = maskable ? size * 0.2 : size * 0.15;
  const cardRight = size - card;
  const cardBottom = size - (maskable ? size * 0.2 : size * 0.15);
  return png(size, size, (x, y) => {
    // Diagonal brand gradient.
    const t = (x / size) * 0.65 + (y / size) * 0.35;
    const bg = mix([12, 34, 74], [21, 101, 192], t);
    if (!maskable && !insideRoundRect(x, y, padding, padding, size - padding, size - padding, size * 0.16)) {
      return [0, 0, 0, 0];
    }
    if (maskable && !insideRoundRect(x, y, 0, 0, size - 1, size - 1, 0)) return [...bg, 255];
    if (x < card || x > cardRight || y < cardTop || y > cardBottom) return [...bg, 255];

    // Faint grid lines on the card.
    const grid = Math.round(12 * scale);
    if ((x - card) % grid === 0 || (y - cardTop) % grid === 0) return [236, 241, 249, 255];

    // Three ascending bars in a warm yellow, with rounded tops.
    const barWidth = size * 0.105;
    const gap = size * 0.055;
    const base = size * 0.72;
    const start = size * 0.29;
    const heights = [0.2, 0.31, 0.43].map((h) => size * h);
    for (let i = 0; i < 3; i++) {
      const left = start + i * (barWidth + gap);
      const top = base - heights[i];
      if (x >= left && x <= left + barWidth && y >= top && y <= base) {
        const r = barWidth / 2;
        const cx = left + r;
        const cy = top + r;
        if (y < top + r && (x - cx) ** 2 + (y - cy) ** 2 > r * r) return [236, 241, 249, 255];
        const shade = mix([248, 206, 40], [255, 229, 120], (base - y) / (base - top));
        return [...shade, 255];
      }
    }

    // Baseline.
    if (y >= base && y <= base + size * 0.014 && x >= size * 0.24 && x <= size * 0.76)
      return [236, 241, 249, 255];

    // Small accent dot (the "insight").
    const dx = x - size * 0.68;
    const dy = y - size * 0.3;
    if (dx * dx + dy * dy <= (size * 0.032) ** 2) return [126, 217, 255, 255];
    return [236, 241, 249, 255];
  });
}

const outDir = join(process.cwd(), "public", "icons");
mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), icon(size, false));
  writeFileSync(join(outDir, `maskable-${size}.png`), icon(size, true));
}
writeFileSync(join(outDir, "apple-touch-icon.png"), icon(180, true));
console.log("Wrote PWA icons to public/icons");
