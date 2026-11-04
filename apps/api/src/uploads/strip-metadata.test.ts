import { describe, expect, it } from 'vitest';

import {
  MetadataStripError,
  stripGifMetadata,
  stripJpegMetadata,
  stripMetadata,
  stripPngMetadata,
  stripWebpMetadata,
} from './strip-metadata.js';

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

  it('refuses (fails closed) when the structure is broken', () => {
    const broken = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2]);
    expect(() => stripJpegMetadata(broken)).toThrow(MetadataStripError);
    expect(() => stripJpegMetadata(Uint8Array.from([1, 2, 3, 4, 5]))).toThrow(MetadataStripError);
    // No start of scan at all.
    expect(() => stripJpegMetadata(Uint8Array.from([0xff, 0xd8, ...jfif]))).toThrow(
      MetadataStripError,
    );
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
  const ihdr = chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const idat = chunk('IDAT', [1, 2, 3]);
  const iend = chunk('IEND', []);

  it('drops eXIf and text chunks and keeps the rest', () => {
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

  it('cuts off bytes after IEND and refuses a PNG without IEND or with a cut chunk', () => {
    const trailing = Uint8Array.from([...signature, ...ihdr, ...idat, ...iend, 7, 7, 7]);
    expect([...stripPngMetadata(trailing)]).toEqual([...signature, ...ihdr, ...idat, ...iend]);
    expect(() => stripPngMetadata(Uint8Array.from([...signature, ...ihdr, ...idat]))).toThrow(
      MetadataStripError,
    );
    expect(() =>
      stripPngMetadata(Uint8Array.from([...signature, ...ihdr, 0, 0, 9, 9, 73, 68, 65, 84, 1])),
    ).toThrow(MetadataStripError);
  });
});

describe('stripWebpMetadata', () => {
  const fourcc = (text: string): number[] => [...Buffer.from(text, 'latin1')];
  const u32 = (value: number): number[] => [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  ];
  const chunk = (type: string, data: number[]): number[] => [
    ...fourcc(type),
    ...u32(data.length),
    ...data,
    ...(data.length % 2 === 1 ? [0] : []),
  ];
  const riff = (chunks: number[][]): Uint8Array => {
    const payload = chunks.flat();
    return Uint8Array.from([
      ...fourcc('RIFF'),
      ...u32(4 + payload.length),
      ...fourcc('WEBP'),
      ...payload,
    ]);
  };
  const vp8x = (flags: number) => chunk('VP8X', [flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const picture = chunk('VP8L', [1, 2, 3]);
  const exif = chunk('EXIF', [...fourcc('Exif'), 0, 0, 5]);
  const xmp = chunk('XMP ', fourcc('<x:xmpmeta/>'));
  const icc = chunk('ICCP', [9, 9]);

  it('drops EXIF and XMP, clears their flags and rewrites the RIFF size', () => {
    const input = riff([vp8x(0x2c), icc, picture, exif, xmp]);
    const output = stripWebpMetadata(input);
    expect([...output]).toEqual([...riff([vp8x(0x20), icc, picture])]);
    expect(Buffer.from(output).includes(Buffer.from('Exif'))).toBe(false);
    expect(Buffer.from(output).includes(Buffer.from('xmpmeta'))).toBe(false);
    expect(new DataView(output.buffer).getUint32(4, true)).toBe(output.length - 8);
  });

  it('returns the same bytes when there is nothing to drop', () => {
    const clean = riff([vp8x(0x10), picture]);
    expect(stripWebpMetadata(clean)).toBe(clean);
    const simple = riff([picture]);
    expect(stripWebpMetadata(simple)).toBe(simple);
  });

  it('refuses a broken or truncated file', () => {
    const good = riff([picture, exif]);
    expect(() => stripWebpMetadata(good.subarray(0, good.length - 3))).toThrow(MetadataStripError);
    const lying = Uint8Array.from(good);
    lying[16] = 0xff; // chunk size far past the end
    expect(() => stripWebpMetadata(lying)).toThrow(MetadataStripError);
    expect(() => stripWebpMetadata(Uint8Array.from([1, 2, 3]))).toThrow(MetadataStripError);
  });
});

describe('stripGifMetadata', () => {
  const header = [...Buffer.from('GIF89a'), 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
  const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0];
  const comment = [0x21, 0xfe, 5, ...Buffer.from('GPS:1'), 0];
  const netscape = [0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0];
  const xmp = [0x21, 0xff, 11, ...Buffer.from('XMP DataXMP'), 4, 60, 120, 62, 62, 0];
  const graphicControl = [0x21, 0xf9, 4, 0, 0, 0, 0, 0];
  const trailer = [0x3b];

  it('drops comments and XMP but keeps the loop extension, timing and frames', () => {
    const input = Uint8Array.from([
      ...header,
      ...netscape,
      ...comment,
      ...graphicControl,
      ...frame,
      ...xmp,
      ...trailer,
    ]);
    const output = stripGifMetadata(input);
    expect([...output]).toEqual([...header, ...netscape, ...graphicControl, ...frame, ...trailer]);
    expect(Buffer.from(output).includes(Buffer.from('GPS'))).toBe(false);
    expect(Buffer.from(output).includes(Buffer.from('XMP'))).toBe(false);
  });

  it('returns the same bytes when there is nothing to drop, and cuts off bytes after the trailer', () => {
    const clean = Uint8Array.from([...header, ...graphicControl, ...frame, ...trailer]);
    expect(stripGifMetadata(clean)).toBe(clean);
    const tail = Uint8Array.from([...clean, 9, 9, 9]);
    expect([...stripGifMetadata(tail)]).toEqual([...clean]);
  });

  it('refuses a GIF without a trailer or with a cut block', () => {
    expect(() =>
      stripGifMetadata(Uint8Array.from([...header, ...graphicControl, ...frame])),
    ).toThrow(MetadataStripError);
    expect(() => stripGifMetadata(Uint8Array.from([...header, ...comment.slice(0, 5)]))).toThrow(
      MetadataStripError,
    );
    expect(() => stripGifMetadata(Uint8Array.from([...header, 0x99, 0x3b]))).toThrow(
      MetadataStripError,
    );
  });
});

describe('stripMetadata', () => {
  it('passes other kinds through and routes the image kinds to their parser', () => {
    const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(stripMetadata('pdf', pdf)).toBe(pdf);
    expect(stripMetadata('text', pdf)).toBe(pdf);
    for (const kind of ['jpeg', 'png', 'gif', 'webp']) {
      expect(() => stripMetadata(kind, Uint8Array.from([1, 2, 3]))).toThrow(MetadataStripError);
    }
  });
});
