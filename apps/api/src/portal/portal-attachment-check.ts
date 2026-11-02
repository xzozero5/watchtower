import {
  PORTAL_ATTACHMENT_MAX_BYTES,
  PORTAL_ATTACHMENT_MAX_FILES,
  PORTAL_ATTACHMENT_MAX_NAME,
  PORTAL_ATTACHMENT_MAX_TOTAL_BYTES,
  portalAttachmentExtension,
  type PortalAttachmentExtension,
} from '@watchtower/shared';

/**
 * What a portal upload is, decided from its own bytes (T-140, ADR-007 section "Uploads"). The name
 * and the MIME type the browser sends are claims; they are used only to be compared with what the
 * bytes say. Pure functions, no I/O, so every rule has a unit test.
 */

export type DetectedKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf' | 'text';

/** The extensions that are honest for each kind of content. */
const KIND_EXTENSIONS: Readonly<Record<DetectedKind, readonly PortalAttachmentExtension[]>> = {
  png: ['png'],
  jpeg: ['jpg', 'jpeg'],
  gif: ['gif'],
  webp: ['webp'],
  pdf: ['pdf'],
  text: ['txt', 'csv', 'log'],
};

/**
 * The content type stored and served. Chosen by the server from the detected kind and the extension,
 * never taken from the request. Text is served as `text/plain` or `text/csv`, never `text/html`.
 */
const CONTENT_TYPES: Readonly<Record<PortalAttachmentExtension, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  log: 'text/plain',
};

export type AttachmentRefusal =
  | 'too_many_files'
  | 'empty_file'
  | 'file_too_large'
  | 'total_too_large'
  | 'extension_not_allowed'
  | 'content_not_allowed'
  | 'content_mismatch'
  | 'active_content';

export interface CheckedAttachment {
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

export class AttachmentRefused extends Error {
  readonly reason: AttachmentRefusal;
  /** Position of the file in the request; null when the request as a whole is refused. */
  readonly index: number | null;

  constructor(reason: AttachmentRefusal, index: number | null) {
    super(`attachment refused: ${reason}`);
    this.name = 'AttachmentRefused';
    this.reason = reason;
    this.index = index;
  }
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

const ascii = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.subarray(start, end));

/** Markup that a browser could run or render if it ever opened the file as a page. */
const ACTIVE_MARKUP =
  /<\s*(?:!doctype|html|head|body|svg|script|iframe|object|embed|link|meta|\?xml)/i;
/** How much of a text file is read for the markup check and the encoding check. */
const TEXT_SCAN_BYTES = 8192;

/** Binary formats by signature; text only when it is valid UTF-8 without NUL bytes. Null: not allowed. */
export function detectKind(bytes: Uint8Array): DetectedKind | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return 'gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return 'webp';
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  return isPlainText(bytes) ? 'text' : null;
}

function isPlainText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** True when the start of a text file looks like a web page or SVG, so it is refused whatever its name says. */
export function looksLikeMarkup(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, TEXT_SCAN_BYTES));
  return ACTIVE_MARKUP.test(head);
}

/** C0/C1 controls and the bidirectional marks and overrides that can make an extension read backwards. */
function isHiddenCharacter(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Display name: the last path segment, no control or bidirectional-override characters, at most
 * `PORTAL_ATTACHMENT_MAX_NAME` characters with the extension kept. It is shown to staff as text and
 * used in `Content-Disposition`; it is never part of a storage key.
 */
export function sanitizeFileName(raw: string): string {
  let name = raw.normalize('NFC');
  name = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  name = Array.from(name)
    .filter((char) => !isHiddenCharacter(char.codePointAt(0) ?? 0))
    .join('');
  name = name.trim().replace(/^\.+/, '');
  if (name === '') return 'file';
  if (name.length <= PORTAL_ATTACHMENT_MAX_NAME) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  return `${name.slice(0, PORTAL_ATTACHMENT_MAX_NAME - ext.length)}${ext}`;
}

/**
 * Browsers send the file name as UTF-8, multer reads header bytes as latin1: a Thai name arrives as
 * mojibake. Undo that when the bytes really are UTF-8; otherwise keep the name as it came.
 */
export function repairFileNameEncoding(raw: string): string {
  const codes = Array.from(raw, (char) => char.codePointAt(0) ?? 0);
  // Only a name made entirely of latin1 characters, with at least one above ASCII, can be mojibake.
  if (codes.some((code) => code > 0xff) || !codes.some((code) => code > 0x7f)) return raw;
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  return decoded.includes(String.fromCodePoint(0xfffd)) ? raw : decoded;
}

/** Checks the whole request and returns what to store. Throws `AttachmentRefused` at the first problem. */
export function checkAttachments(
  files: readonly { readonly originalName: string; readonly bytes: Uint8Array }[],
): CheckedAttachment[] {
  if (files.length > PORTAL_ATTACHMENT_MAX_FILES)
    throw new AttachmentRefused('too_many_files', null);
  let total = 0;
  const checked: CheckedAttachment[] = [];
  for (const [index, file] of files.entries()) {
    const { bytes } = file;
    if (bytes.length === 0) throw new AttachmentRefused('empty_file', index);
    if (bytes.length > PORTAL_ATTACHMENT_MAX_BYTES)
      throw new AttachmentRefused('file_too_large', index);
    total += bytes.length;
    if (total > PORTAL_ATTACHMENT_MAX_TOTAL_BYTES)
      throw new AttachmentRefused('total_too_large', null);

    const fileName = sanitizeFileName(repairFileNameEncoding(file.originalName));
    const extension = portalAttachmentExtension(fileName);
    if (extension === null) throw new AttachmentRefused('extension_not_allowed', index);
    const kind = detectKind(bytes);
    if (kind === null) throw new AttachmentRefused('content_not_allowed', index);
    if (!KIND_EXTENSIONS[kind].includes(extension)) {
      throw new AttachmentRefused('content_mismatch', index);
    }
    if (kind === 'text' && looksLikeMarkup(bytes))
      throw new AttachmentRefused('active_content', index);
    checked.push({ fileName, contentType: CONTENT_TYPES[extension], size: bytes.length, bytes });
  }
  return checked;
}
