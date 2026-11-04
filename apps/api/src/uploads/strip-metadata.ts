/**
 * Removes the metadata a photo or a screenshot carries before the file is stored: EXIF (camera model,
 * GPS position, time), XMP, comments, thumbnails and anything else that is not the picture. Pure
 * functions over bytes, no dependency.
 *
 * Each format is an allow-list (T-171a C-5): what is named below stays, everything else is dropped, so a
 * segment or chunk type nobody thought of cannot carry data through.
 *
 * - JPEG: APP0 (JFIF), APP2 only when it is an `ICC_PROFILE`, APP14 (Adobe colour transform) and the
 *   segments that make the picture (frame, tables, scan). Every other APPn, COM and reserved segment is
 *   dropped. Everything after the end-of-image marker is cut off.
 * - PNG: the critical chunks, the colour chunks (`gAMA`, `cHRM`, `sRGB`, `iCCP`, `cICP`, `sBIT`),
 *   `pHYs`, `tRNS`, `bKGD`, `hIST` and the animation chunks (`acTL`, `fcTL`, `fdAT`). Text, `eXIf`,
 *   `tIME` and unknown chunks are dropped, and so are bytes after `IEND`.
 * - WebP (RIFF): `VP8`, `VP8L`, `VP8X`, `ALPH`, `ANIM`, `ANMF`, `ICCP`. Inside an `ANMF` frame only
 *   `ALPH`, `VP8` and `VP8L` stay. The RIFF size is rewritten and the EXIF / XMP flags of `VP8X` cleared.
 * - GIF: graphic control and plain text extensions, the ICC colour profile application, and the loop
 *   count of `NETSCAPE2.0` / `ANIMEXTS1.0` (only that sub-block). Comments and every other application
 *   extension are dropped, and so are bytes after the trailer.
 *
 * Fail closed (T-171 C-5): when the structure of a JPEG, PNG, GIF or WebP cannot be parsed, the
 * file could be hiding metadata the parser never saw, so `MetadataStripError` is thrown and the upload
 * is refused instead of being stored as it is. Bytes with nothing to drop come back as the same array.
 * Other kinds (PDF, text) are not touched. `[UNVERIFIED]` a PDF can carry metadata too.
 */

export class MetadataStripError extends Error {
  readonly kind: string;

  constructor(kind: string) {
    super(`cannot remove metadata from a ${kind} file: structure not understood`);
    this.name = 'MetadataStripError';
    this.kind = kind;
  }
}

const PNG_KEEP = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'gAMA',
  'cHRM',
  'sRGB',
  'iCCP',
  'cICP',
  'sBIT',
  'pHYs',
  'tRNS',
  'bKGD',
  'hIST',
  'acTL',
  'fcTL',
  'fdAT',
]);
const PNG_SIGNATURE_LENGTH = 8;
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
const WEBP_FRAME_KEEP = new Set(['VP8 ', 'VP8L', 'ALPH']);
const GIF_LOOP_APPLICATIONS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);
const GIF_PROFILE_APPLICATION = 'ICCRGBG1012';
const ICC_SIGNATURE = 'ICC_PROFILE\0';

/** True for the JPEG segments that are the picture itself (frame, tables, restart interval ...). */
function isJpegPictureSegment(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xcf) || (marker >= 0xdb && marker <= 0xdf);
}

export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new MetadataStripError('jpeg');
  }
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let position = 2;
  let dropped = false;
  while (position < bytes.length) {
    if (bytes[position] !== 0xff) throw new MetadataStripError('jpeg');
    // Fill bytes before a marker.
    let markerPos = position + 1;
    while (bytes[markerPos] === 0xff) markerPos += 1;
    const marker = bytes[markerPos];
    if (marker === undefined) throw new MetadataStripError('jpeg');
    if (marker === 0xd9) {
      // End of image: nothing after it is part of the picture.
      parts.push(Uint8Array.of(0xff, 0xd9));
      if (markerPos + 1 < bytes.length || markerPos !== position + 1) dropped = true;
      return dropped ? concat(parts) : bytes;
    }
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
      // Markers without a length.
      parts.push(bytes.subarray(position, markerPos + 1));
      position = markerPos + 1;
      continue;
    }
    const high = bytes[markerPos + 1];
    const low = bytes[markerPos + 2];
    if (high === undefined || low === undefined) throw new MetadataStripError('jpeg');
    const length = high * 256 + low;
    const end = markerPos + 1 + length;
    if (length < 2 || end > bytes.length) throw new MetadataStripError('jpeg');
    const keep =
      marker === 0xe0 ||
      marker === 0xee ||
      marker === 0xda ||
      isJpegPictureSegment(marker) ||
      (marker === 0xe2 &&
        ascii(bytes, markerPos + 3, markerPos + 3 + ICC_SIGNATURE.length) === ICC_SIGNATURE);
    if (keep) parts.push(bytes.subarray(position, end));
    else dropped = true;
    position = end;
    if (marker === 0xda) {
      // Entropy-coded data: runs until a marker that is not a stuffed zero or a restart.
      const scanStart = position;
      while (position < bytes.length) {
        if (bytes[position] === 0xff) {
          const next = bytes[position + 1];
          if (next === undefined) throw new MetadataStripError('jpeg');
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            position += 2;
            continue;
          }
          if (next === 0xff) {
            position += 1;
            continue;
          }
          break;
        }
        position += 1;
      }
      parts.push(bytes.subarray(scanStart, position));
    }
  }
  // No end of image: truncated, and no way to know where the picture stops.
  throw new MetadataStripError('jpeg');
}

export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < PNG_SIGNATURE_LENGTH + 12) throw new MetadataStripError('png');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [bytes.subarray(0, PNG_SIGNATURE_LENGTH)];
  let position = PNG_SIGNATURE_LENGTH;
  let dropped = false;
  let ended = false;
  while (position + 12 <= bytes.length) {
    const length = view.getUint32(position);
    const end = position + 12 + length;
    if (end > bytes.length) throw new MetadataStripError('png');
    const type = ascii(bytes, position + 4, position + 8);
    if (PNG_KEEP.has(type)) parts.push(bytes.subarray(position, end));
    else dropped = true;
    position = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended) throw new MetadataStripError('png');
  // Bytes after IEND are not part of the picture and could hold anything: they are cut off.
  if (position < bytes.length) dropped = true;
  return dropped ? concat(parts) : bytes;
}

/** One `ANMF` chunk (payload from `from` to `to`) with only its picture sub-chunks. */
function stripWebpFrame(
  bytes: Uint8Array,
  view: DataView,
  from: number,
  to: number,
): { chunk: Uint8Array; changed: boolean } {
  if (to - from < 16) throw new MetadataStripError('webp');
  const inner: Uint8Array[] = [bytes.subarray(from, from + 16)];
  let changed = false;
  let cursor = from + 16;
  while (cursor < to) {
    if (cursor + 8 > to) throw new MetadataStripError('webp');
    const type = ascii(bytes, cursor, cursor + 4);
    const size = view.getUint32(cursor + 4, true);
    const end = cursor + 8 + size + (size % 2);
    if (end > to + ((to - from) % 2)) throw new MetadataStripError('webp');
    if (WEBP_FRAME_KEEP.has(type)) inner.push(bytes.subarray(cursor, end));
    else changed = true;
    cursor = end;
  }
  const payload = concat(inner);
  const padded = payload.length % 2 === 1 ? 1 : 0;
  const chunk = new Uint8Array(8 + payload.length + padded);
  chunk.set(bytes.subarray(from - 8, from - 4), 0);
  new DataView(chunk.buffer).setUint32(4, payload.length, true);
  chunk.set(payload, 8);
  return {
    chunk: changed ? chunk : bytes.subarray(from - 8, to + ((to - from) % 2)),
    changed,
  };
}

export function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP') {
    throw new MetadataStripError('webp');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffEnd = 8 + view.getUint32(4, true);
  if (riffEnd > bytes.length || riffEnd < 12) throw new MetadataStripError('webp');
  const kept: Uint8Array[] = [];
  let position = 12;
  let dropped = false;
  while (position < riffEnd) {
    if (position + 8 > riffEnd) throw new MetadataStripError('webp');
    const type = ascii(bytes, position, position + 4);
    const size = view.getUint32(position + 4, true);
    // Chunks are padded to an even length.
    const end = position + 8 + size + (size % 2);
    if (end > riffEnd) throw new MetadataStripError('webp');
    if (!WEBP_KEEP.has(type)) {
      dropped = true;
    } else if (type === 'ANMF') {
      // 16 bytes of frame header, then the frame's own chunks: only the picture ones stay.
      const frame = stripWebpFrame(bytes, view, position + 8, position + 8 + size);
      if (frame.changed) dropped = true;
      kept.push(frame.chunk);
    } else if (type === 'VP8X' && size >= 10) {
      // Flags byte: 0x08 EXIF present, 0x04 XMP present.
      const chunk = bytes.slice(position, end);
      const flags = chunk[8] ?? 0;
      const cleared = flags & ~0x0c;
      if (cleared !== flags) {
        chunk[8] = cleared;
        dropped = true;
      }
      kept.push(chunk);
    } else {
      kept.push(bytes.subarray(position, end));
    }
    position = end;
  }
  // Anything after the RIFF payload is cut off, as with PNG.
  if (riffEnd < bytes.length) dropped = true;
  if (!dropped) return bytes;
  const payload = concat(kept);
  const out = new Uint8Array(12 + payload.length);
  out.set(bytes.subarray(0, 12), 0);
  new DataView(out.buffer).setUint32(4, 4 + payload.length, true);
  out.set(payload, 12);
  return out;
}

export function stripGifMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 13 || !/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) {
    throw new MetadataStripError('gif');
  }
  const parts: Uint8Array[] = [];
  let dropped = false;
  // Header + logical screen descriptor + global colour table.
  const screenFlags = bytes[10] ?? 0;
  let position = 13 + ((screenFlags & 0x80) !== 0 ? 3 * 2 ** ((screenFlags & 0x07) + 1) : 0);
  if (position > bytes.length) throw new MetadataStripError('gif');
  let runStart = 0; // the kept run starts here
  const flush = (upTo: number): void => {
    if (upTo > runStart) parts.push(bytes.subarray(runStart, upTo));
  };
  /** One past the terminator of the chain of data sub-blocks that starts at `from`. */
  const skipSubBlocks = (from: number): number => {
    let cursor = from;
    for (;;) {
      const size = bytes[cursor];
      if (size === undefined) throw new MetadataStripError('gif');
      cursor += 1 + size;
      if (cursor > bytes.length) throw new MetadataStripError('gif');
      if (size === 0) return cursor;
    }
  };
  let trailer = false;
  while (position < bytes.length) {
    const introducer = bytes[position];
    if (introducer === 0x3b) {
      trailer = true;
      position += 1;
      break;
    }
    if (introducer === 0x2c) {
      const flags = bytes[position + 9];
      if (flags === undefined) throw new MetadataStripError('gif');
      const table = (flags & 0x80) !== 0 ? 3 * 2 ** ((flags & 0x07) + 1) : 0;
      // LZW minimum code size (one byte), then the data sub-blocks.
      position = skipSubBlocks(position + 10 + table + 1);
      continue;
    }
    if (introducer === 0x21) {
      const label = bytes[position + 1];
      if (label === undefined) throw new MetadataStripError('gif');
      // Allow-list: graphic control (0xf9) and plain text (0x01) are part of the picture; an
      // application extension stays only as the colour profile or a bare loop count.
      let drop = label !== 0xf9 && label !== 0x01 && label !== 0xff;
      if (label === 0xff) {
        const size = bytes[position + 2];
        if (size === undefined) throw new MetadataStripError('gif');
        // The first sub-block names the application (8 + 3 bytes).
        const name = ascii(bytes, position + 3, position + 3 + size);
        drop = name !== GIF_PROFILE_APPLICATION;
        if (GIF_LOOP_APPLICATIONS.has(name)) {
          // Only the loop count (sub-block of 3 bytes, id 1) stays; any other sub-block is data.
          const first = position + 3 + size;
          const after = skipSubBlocks(position + 2);
          const hasLoop = bytes[first] === 3 && bytes[first + 1] === 1;
          if (!(hasLoop && after === first + 5)) {
            flush(position);
            if (hasLoop) {
              const rebuilt = new Uint8Array(first - position + 5);
              rebuilt.set(bytes.subarray(position, first + 4), 0); // the last byte stays 0: terminator
              parts.push(rebuilt);
            }
            runStart = after;
            dropped = true;
          }
          position = after;
          continue;
        }
      }
      const end = skipSubBlocks(position + 2);
      if (drop) {
        flush(position);
        runStart = end;
        dropped = true;
      }
      position = end;
      continue;
    }
    throw new MetadataStripError('gif');
  }
  if (!trailer) throw new MetadataStripError('gif');
  if (position < bytes.length) dropped = true; // after the trailer: cut off
  flush(position);
  return dropped ? concat(parts) : bytes;
}

/**
 * Strips by the kind the bytes were detected as (`png`, `jpeg`, ...); other kinds pass through.
 * Throws `MetadataStripError` for an image whose structure cannot be read.
 */
export function stripMetadata(kind: string, bytes: Uint8Array): Uint8Array {
  if (kind === 'jpeg') return stripJpegMetadata(bytes);
  if (kind === 'png') return stripPngMetadata(bytes);
  if (kind === 'webp') return stripWebpMetadata(bytes);
  if (kind === 'gif') return stripGifMetadata(bytes);
  return bytes;
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
