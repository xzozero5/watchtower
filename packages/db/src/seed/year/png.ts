import { deflateSync } from 'node:zlib';

import { Rng } from './prng.js';

/**
 * Small deterministic PNG "screenshots" for the seeded attachments: a window with a title bar, an
 * error banner and grey text bars. No external image is used and nothing in them is real.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

type Rgb = readonly [number, number, number];

export const PNG_WIDTH = 480;
export const PNG_HEIGHT = 270;

export function makeScreenshotPng(variant: number): Buffer {
  const rng = new Rng(`png-${String(variant)}`);
  const w = PNG_WIDTH;
  const h = PNG_HEIGHT;
  const pixels = new Uint8Array(w * h * 3);
  const fill = (x0: number, y0: number, x1: number, y1: number, color: Rgb): void => {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x += 1) {
        const at = (y * w + x) * 3;
        pixels[at] = color[0];
        pixels[at + 1] = color[1];
        pixels[at + 2] = color[2];
      }
    }
  };
  const accent: Rgb = rng.pick<Rgb>([
    [39, 99, 190],
    [30, 120, 90],
    [110, 70, 170],
    [200, 110, 30],
  ]);
  const error: Rgb = rng.pick<Rgb>([
    [214, 48, 49],
    [192, 57, 43],
    [231, 76, 60],
  ]);
  fill(0, 0, w, h, [236, 239, 243]);
  fill(20, 16, w - 20, h - 16, [255, 255, 255]);
  fill(20, 16, w - 20, 44, accent);
  for (let i = 0; i < 3; i += 1) fill(30 + i * 16, 25, 40 + i * 16, 35, [255, 255, 255]);
  fill(36, 60, w - 36, 100, error);
  fill(46, 72, 46 + rng.int(120, 260), 80, [255, 255, 255]);
  fill(46, 86, 46 + rng.int(60, 180), 92, [255, 220, 220]);
  for (let row = 0; row < 7; row += 1) {
    const y = 116 + row * 18;
    fill(36, y, 36 + rng.int(100, 380), y + 8, [200, 205, 212]);
  }
  fill(w - 120, h - 52, w - 36, h - 30, accent);

  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * stride] = 0;
    Buffer.from(pixels.buffer, y * w * 3, w * 3).copy(raw, y * stride + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
