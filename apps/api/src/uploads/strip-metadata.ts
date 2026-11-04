/**
 * Removes the metadata a photo or a screenshot carries before the file is stored: EXIF (camera model,
 * GPS position, time), XMP and comments. Pure functions over bytes, no dependency.
 *
 * - JPEG: the APP1 (EXIF, XMP), APP13 (Photoshop/IPTC) and COM segments are dropped. APP0, the ICC
 *   profile (APP2) and everything that affects the picture stay, so the image looks the same.
 * - PNG: the `eXIf` chunk and the text chunks (`tEXt`, `zTXt`, `iTXt`) are dropped, and so are bytes
 *   after `IEND`.
 * - WebP (RIFF): the `EXIF` and `XMP ` chunks are dropped, the RIFF size is rewritten and the EXIF / XMP
 *   flags of the `VP8X` header are cleared. ICC profile, animation and picture chunks stay.
 * - GIF: comment extensions and every application extension other than the loop / animation ones
 *   (`NETSCAPE2.0`, `ANIMEXTS1.0`) and the colour profile (`ICCRGBG1012`) are dropped; this removes XMP.
 *
 * Fail closed (T-171 C-5): when the structure of a JPEG, PNG, GIF or WebP cannot be parsed, the
 * file could be hiding metadata the parser never saw, so `MetadataStripError` is thrown and the upload
 * is refused instead of being stored as it is. Bytes with nothing to drop come back as the same array.
 * Other kinds (PDF, text) are not touched. `[UNVERIFIED]` a PDF can carry metadata too, and a JPEG can
 * carry bytes after its end-of-image marker (they are kept).
 */

export class MetadataStripError extends Error {
  readonly kind: string;

  constructor(kind: string) {
    super(`cannot remove metadata from a ${kind} file: structure not understood`);
    this.name = 'MetadataStripError';
    this.kind = kind;
  }
}

const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]);
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);
const PNG_SIGNATURE_LENGTH = 8;
const WEBP_DROP = new Set(['EXIF', 'XMP ']);
const GIF_KEEP_APPLICATIONS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012']);

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
    if (marker === 0xda) {
      // Start of scan: the entropy-coded data runs to the end of the file; keep it whole.
      parts.push(bytes.subarray(position));
      return dropped ? concat(parts) : bytes;
    }
    if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
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
    if (JPEG_DROP.has(marker)) dropped = true;
    else parts.push(bytes.subarray(position, end));
    position = end;
  }
  // No start of scan: not a picture.
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
    if (PNG_DROP.has(type)) dropped = true;
    else parts.push(bytes.subarray(position, end));
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
    if (WEBP_DROP.has(type)) {
      dropped = true;
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
      let drop = label === 0xfe;
      if (label === 0xff) {
        const size = bytes[position + 2];
        if (size === undefined) throw new MetadataStripError('gif');
        // The first sub-block names the application (8 + 3 bytes); only known harmless ones stay.
        drop = !GIF_KEEP_APPLICATIONS.has(ascii(bytes, position + 3, position + 3 + size));
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
