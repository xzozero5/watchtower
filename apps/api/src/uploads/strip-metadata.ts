/**
 * Removes the metadata a photo or a screenshot carries before the file is stored: EXIF (camera model,
 * GPS position, time), XMP and comments. Pure functions over bytes, no dependency.
 *
 * - JPEG: the APP1 (EXIF, XMP), APP13 (Photoshop/IPTC) and COM segments are dropped. APP0, the ICC
 *   profile (APP2) and everything that affects the picture stay, so the image looks the same.
 * - PNG: the `eXIf` chunk and the text chunks (`tEXt`, `zTXt`, `iTXt`) are dropped.
 * - GIF and WebP are returned as they are (`[UNVERIFIED]` whether they carry GPS; screenshots do not,
 *   phone photos are almost always JPEG).
 *
 * If the structure cannot be parsed the original bytes are returned unchanged: a file is never lost to
 * a stripping bug, and the type check has already accepted it.
 */

const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]);
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);
const PNG_SIGNATURE_LENGTH = 8;

export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let position = 2;
  let dropped = false;
  while (position < bytes.length) {
    if (bytes[position] !== 0xff) return bytes;
    // Fill bytes before a marker.
    let markerPos = position + 1;
    while (bytes[markerPos] === 0xff) markerPos += 1;
    const marker = bytes[markerPos];
    if (marker === undefined) return bytes;
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
    if (high === undefined || low === undefined) return bytes;
    const length = high * 256 + low;
    const end = markerPos + 1 + length;
    if (length < 2 || end > bytes.length) return bytes;
    if (JPEG_DROP.has(marker)) dropped = true;
    else parts.push(bytes.subarray(position, end));
    position = end;
  }
  return dropped ? concat(parts) : bytes;
}

export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < PNG_SIGNATURE_LENGTH + 12) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [bytes.subarray(0, PNG_SIGNATURE_LENGTH)];
  let position = PNG_SIGNATURE_LENGTH;
  let dropped = false;
  while (position + 12 <= bytes.length) {
    const length = view.getUint32(position);
    const end = position + 12 + length;
    if (end > bytes.length) return bytes;
    const type = String.fromCharCode(...bytes.subarray(position + 4, position + 8));
    if (PNG_DROP.has(type)) dropped = true;
    else parts.push(bytes.subarray(position, end));
    position = end;
    if (type === 'IEND') break;
  }
  return dropped ? concat(parts) : bytes;
}

/** Strips by the kind the bytes were detected as (`png`, `jpeg`, ...); other kinds pass through. */
export function stripMetadata(kind: string, bytes: Uint8Array): Uint8Array {
  if (kind === 'jpeg') return stripJpegMetadata(bytes);
  if (kind === 'png') return stripPngMetadata(bytes);
  return bytes;
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
