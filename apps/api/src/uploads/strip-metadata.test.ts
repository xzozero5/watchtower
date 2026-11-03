import { describe, expect, it } from 'vitest';

import { stripJpegMetadata, stripMetadata, stripPngMetadata } from './strip-metadata.js';

const segment = (marker: number, payload: number[]): number[] => {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
};

describe('stripJpegMetadata', () => {
  const exif = segment(0xe1, [...Buffer.from('Exif\0\0'), 1, 2, 3, 4]);
  const jfif = segment(0xe0, [...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const icc = segment(0xe2, [...Buffer.from('ICC_PROFILE\0'), 1, 1]);
  const scan = [0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9];

  it('drops EXIF and keeps JFIF, the ICC profile and the picture data', () => {
    const input = Uint8Array.from([0xff, 0xd8, ...jfif, ...exif, ...icc, ...scan]);
    const output = stripJpegMetadata(input);
    expect([...output]).toEqual([0xff, 0xd8, ...jfif, ...icc, ...scan]);
    expect(Buffer.from(output).includes(Buffer.from('Exif'))).toBe(false);
  });

  it('drops XMP/IPTC and comments too, and returns the same bytes when there is nothing to drop', () => {
    const clean = Uint8Array.from([0xff, 0xd8, ...jfif, ...scan]);
    expect(stripJpegMetadata(clean)).toBe(clean);
    const noisy = Uint8Array.from([
      0xff,
      0xd8,
      ...segment(0xed, [1, 2]),
      ...segment(0xfe, [65, 66]),
      ...scan,
    ]);
    expect([...stripJpegMetadata(noisy)]).toEqual([0xff, 0xd8, ...scan]);
  });

  it('returns the input untouched when the structure is broken', () => {
    const broken = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2]);
    expect(stripJpegMetadata(broken)).toBe(broken);
    const notJpeg = Uint8Array.from([1, 2, 3, 4, 5]);
    expect(stripJpegMetadata(notJpeg)).toBe(notJpeg);
  });
});

describe('stripPngMetadata', () => {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: number[]): number[] => [
    0,
    0,
    0,
    data.length,
    ...Buffer.from(type),
    ...data,
    9,
    9,
    9,
    9,
  ];

  it('drops eXIf and text chunks and keeps the rest', () => {
    const ihdr = chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    const idat = chunk('IDAT', [1, 2, 3]);
    const iend = chunk('IEND', []);
    const input = Uint8Array.from([
      ...signature,
      ...ihdr,
      ...chunk('eXIf', [1, 2, 3, 4]),
      ...chunk('tEXt', [65, 0, 66]),
      ...idat,
      ...iend,
    ]);
    expect([...stripPngMetadata(input)]).toEqual([...signature, ...ihdr, ...idat, ...iend]);
  });

  it('passes other kinds through', () => {
    const gif = Uint8Array.from([71, 73, 70, 56, 57, 97, 1]);
    expect(stripMetadata('gif', gif)).toBe(gif);
  });
});
