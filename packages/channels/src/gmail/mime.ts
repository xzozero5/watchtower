/**
 * Low-level RFC 5322 / RFC 2045-2047 / RFC 2231 parsing. Pure, byte-safe, no I/O.
 *
 * The whole message is held as bytes and split with a latin1 view (one char per byte) so 8-bit
 * bodies survive; each leaf is then transfer-decoded and charset-decoded on its own.
 */

import { createHash } from 'node:crypto';

export class MimeParseError extends Error {
  readonly code: 'message_too_large' | 'too_many_parts' | 'empty_message';

  constructor(code: MimeParseError['code']) {
    super(`MIME parse failed: ${code}`);
    this.name = 'MimeParseError';
    this.code = code;
  }
}

export interface MimeLimits {
  readonly maxMessageBytes: number;
  readonly maxParts: number;
  readonly maxDepth: number;
}

export const DEFAULT_MIME_LIMITS: MimeLimits = {
  // Gmail accepts up to about 25 MB of attachments, which is about 35 MB as raw MIME.
  maxMessageBytes: 40 * 1024 * 1024,
  maxParts: 500,
  maxDepth: 12,
};

// ---------------------------------------------------------------------------------------------
// Charsets

const THAI_LABELS = new Set([
  'tis-620',
  'tis620',
  'iso-8859-11',
  'iso8859-11',
  'windows-874',
  'x-windows-874',
  'cp874',
  'dos-874',
]);

const LATIN1_LABELS = new Set(['iso-8859-1', 'latin1', 'us-ascii', 'ascii', 'windows-1252']);

function strictDecode(bytes: Uint8Array, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function hasHighBit(bytes: Uint8Array): boolean {
  return bytes.some((byte) => byte > 0x7f);
}

/**
 * Decodes bytes with a MIME charset label.
 *
 * - TIS-620, ISO-8859-11 and windows-874 all decode as windows-874 (the WHATWG mapping; TIS-620 is
 *   a subset).
 * - A label of latin1 / us-ascii (or none) on bytes that are valid multi-byte UTF-8 is treated as
 *   UTF-8: senders frequently mislabel UTF-8.
 * - An unknown or missing label falls back to UTF-8, then to windows-874 (this product's primary
 *   locale), then to lossy UTF-8.
 */
export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? '').trim().toLowerCase().replace(/^"|"$/g, '');
  if (!hasHighBit(bytes)) return new TextDecoder('utf-8').decode(bytes);
  if (THAI_LABELS.has(label)) {
    return strictDecode(bytes, 'windows-874') ?? new TextDecoder('windows-874').decode(bytes);
  }
  if (LATIN1_LABELS.has(label)) {
    const asUtf8 = strictDecode(bytes, 'utf-8');
    if (asUtf8 !== null) return asUtf8;
    return new TextDecoder('windows-1252').decode(bytes);
  }
  const named = strictDecode(bytes, label === 'utf8' ? 'utf-8' : label);
  if (named !== null) return named;
  return (
    strictDecode(bytes, 'utf-8') ??
    strictDecode(bytes, 'windows-874') ??
    new TextDecoder('utf-8').decode(bytes)
  );
}

// ---------------------------------------------------------------------------------------------
// Transfer encodings

export function decodeBase64Lenient(text: string): Uint8Array {
  const cleaned = text
    .replace(/[^A-Za-z0-9+/_-]/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  return Uint8Array.from(Buffer.from(cleaned, 'base64'));
}

/** Quoted-printable. `forHeader` (RFC 2047 Q) also maps `_` to a space. */
export function decodeQuotedPrintable(text: string, forHeader = false): Uint8Array {
  const joined = forHeader ? text.replace(/_/g, ' ') : text.replace(/=[ \t]*\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    const char = joined.charCodeAt(i);
    if (char === 0x3d /* = */) {
      const hex = joined.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(char & 0xff);
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------------------------
// Headers

export interface HeaderField {
  /** Lower-case name. */
  readonly name: string;
  /** Unfolded raw value (still RFC 2047 encoded). */
  readonly value: string;
}

export class HeaderBag {
  readonly fields: readonly HeaderField[];

  constructor(fields: readonly HeaderField[]) {
    this.fields = fields;
  }

  get(name: string): string | undefined {
    const lower = name.toLowerCase();
    return this.fields.find((field) => field.name === lower)?.value;
  }

  getAll(name: string): string[] {
    const lower = name.toLowerCase();
    return this.fields.filter((field) => field.name === lower).map((field) => field.value);
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
}

function fromLatin1(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text, 'latin1'));
}

/** Raw 8-bit header bytes: read them as UTF-8 when valid, else windows-874. */
function decodeRawHeaderText(text: string): string {
  // eslint-disable-next-line no-control-regex -- detecting 8-bit bytes in the latin1 view
  if (!/[^\x00-\x7f]/.test(text)) return text;
  return decodeCharset(fromLatin1(text), undefined);
}

export function parseHeaderBlock(block: string): HeaderBag {
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  const fields: HeaderField[] = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!/^[!-9;-~]+$/.test(name)) continue;
    fields.push({ name, value: decodeRawHeaderText(line.slice(colon + 1).trim()) });
  }
  return new HeaderBag(fields);
}

/** RFC 2047 encoded-words. Adjacent words of one charset and encoding are decoded together. */
export function decodeEncodedWords(value: string): string {
  const pattern = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
  interface Segment {
    readonly text?: string;
    readonly charset?: string;
    readonly encoding?: string;
    readonly bytes?: Uint8Array;
  }
  const segments: Segment[] = [];
  let last = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index;
    if (index > last) segments.push({ text: value.slice(last, index) });
    const charset = (match[1] ?? '').split('*')[0] ?? '';
    const encoding = (match[2] ?? '').toUpperCase();
    const payload = match[3] ?? '';
    const bytes =
      encoding === 'B' ? decodeBase64Lenient(payload) : decodeQuotedPrintable(payload, true);
    segments.push({ charset, encoding, bytes });
    last = index + match[0].length;
  }
  if (segments.length === 0) return value;
  if (last < value.length) segments.push({ text: value.slice(last) });

  let out = '';
  let pending: { charset: string; chunks: Uint8Array[] } | null = null;
  const flush = (): void => {
    if (pending === null) return;
    const total = pending.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of pending.chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    out += decodeCharset(joined, pending.charset);
    pending = null;
  };
  for (const [position, segment] of segments.entries()) {
    if (segment.bytes !== undefined && segment.charset !== undefined) {
      if (pending !== null && pending.charset.toLowerCase() !== segment.charset.toLowerCase()) {
        flush();
      }
      pending ??= { charset: segment.charset, chunks: [] };
      pending.chunks.push(segment.bytes);
      continue;
    }
    const text = segment.text ?? '';
    // Whitespace between two encoded-words is not part of the text (RFC 2047 section 6.2).
    const between =
      text.trim() === '' &&
      pending !== null &&
      segments[position + 1]?.bytes !== undefined &&
      position > 0;
    if (between) continue;
    flush();
    out += text;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Structured header values (Content-Type, Content-Disposition) with RFC 2231 parameters

export interface StructuredValue {
  /** Lower-case main value, for example `text/plain` or `attachment`. */
  readonly main: string;
  readonly params: Readonly<Record<string, string>>;
}

function splitOutsideQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value.charAt(i);
    if (char === '\\' && quoted) {
      current += char + value.charAt(i + 1);
      i += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === separator && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return trimmed;
}

function percentDecodeToBytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const hex = text.slice(i + 1, i + 3);
    if (text.charAt(i) === '%' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      out.push(text.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export function parseStructuredValue(value: string | undefined): StructuredValue {
  if (value === undefined) return { main: '', params: {} };
  const [head = '', ...rest] = splitOutsideQuotes(value, ';');
  interface Piece {
    readonly index: number;
    readonly encoded: boolean;
    readonly value: string;
  }
  const simple: Record<string, string> = {};
  const pieces = new Map<string, Piece[]>();
  let charsetByName = new Map<string, string>();
  for (const raw of rest) {
    const eq = raw.indexOf('=');
    if (eq <= 0) continue;
    const key = raw.slice(0, eq).trim().toLowerCase();
    const rawValue = unquote(raw.slice(eq + 1));
    const match = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(key);
    if (match?.[1] === undefined || (match[2] === undefined && match[3] === undefined)) {
      simple[key] = decodeEncodedWords(rawValue);
      continue;
    }
    const name = match[1];
    const index = match[2] === undefined ? 0 : Number(match[2]);
    const encoded = match[3] !== undefined;
    let text = rawValue;
    if (encoded && index === 0) {
      const ext = /^([^']*)'[^']*'(.*)$/.exec(rawValue);
      if (ext !== null) {
        charsetByName = new Map(charsetByName).set(name, ext[1] ?? '');
        text = ext[2] ?? '';
      }
    }
    const list = pieces.get(name) ?? [];
    list.push({ index, encoded, value: text });
    pieces.set(name, list);
  }
  const params: Record<string, string> = { ...simple };
  for (const [name, list] of pieces) {
    const ordered = [...list].sort((a, b) => a.index - b.index);
    const bytes: number[] = [];
    for (const piece of ordered) {
      const chunk = piece.encoded ? percentDecodeToBytes(piece.value) : fromLatin1(piece.value);
      bytes.push(...chunk);
    }
    params[name] = decodeCharset(Uint8Array.from(bytes), charsetByName.get(name) ?? 'utf-8');
  }
  return { main: head.trim().toLowerCase(), params };
}

// ---------------------------------------------------------------------------------------------
// Addresses

export interface MailAddress {
  /** Lower-cased mailbox, `local@domain`. */
  readonly address: string;
  readonly name: string | null;
}

const ADDRESS_PATTERN = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+$/;

export function parseAddressList(value: string | undefined): MailAddress[] {
  if (value === undefined) return [];
  const results: MailAddress[] = [];
  const entries: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  let comment = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value.charAt(i);
    if (char === '\\' && (quoted || comment > 0)) {
      current += char + value.charAt(i + 1);
      i += 1;
      continue;
    }
    if (char === '"' && comment === 0) quoted = !quoted;
    else if (!quoted && char === '(') comment += 1;
    else if (!quoted && char === ')' && comment > 0) comment -= 1;
    else if (!quoted && comment === 0 && char === '<') angle = true;
    else if (!quoted && comment === 0 && char === '>') angle = false;
    if (!quoted && !angle && comment === 0 && (char === ',' || char === ';')) {
      entries.push(current);
      current = '';
      continue;
    }
    if (!quoted && !angle && comment === 0 && char === ':' && !current.includes('@')) {
      // "Group name: a@x, b@y;" - drop the group label.
      current = '';
      continue;
    }
    current += char;
  }
  entries.push(current);

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const angled = /<([^<>]*)>\s*$/.exec(trimmed);
    let address: string;
    let displayRaw: string;
    if (angled?.[1] !== undefined) {
      address = angled[1].trim();
      displayRaw = trimmed.slice(0, angled.index);
    } else {
      address = trimmed.replace(/\([^)]*\)/g, '').trim();
      displayRaw = (/\(([^)]*)\)/.exec(trimmed)?.[1] ?? '').trim();
    }
    // Source routes ("@a,@b:user@host") are obsolete; keep the final mailbox.
    address = address.replace(/^.*:/, '').trim().toLowerCase();
    if (!ADDRESS_PATTERN.test(address)) continue;
    const name = decodeEncodedWords(unquote(displayRaw.replace(/\([^)]*\)/g, '').trim())).trim();
    results.push({ address, name: name === '' ? null : name });
  }
  return results;
}

/** Message-ID style tokens (`<id@host>`) in a header such as `References`. Brackets removed. */
export function parseMessageIds(value: string | undefined): string[] {
  if (value === undefined) return [];
  const ids: string[] = [];
  for (const match of value.matchAll(/<([^<>\s]+)>/g)) {
    if (match[1] !== undefined) ids.push(match[1]);
  }
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Part tree

export interface MimePart {
  /** `1`, `1.1`, `2` ... in document order, like the Gmail `partId` convention. */
  readonly partId: string;
  readonly headers: HeaderBag;
  readonly contentType: StructuredValue;
  readonly disposition: StructuredValue;
  /** Body after transfer decoding. For multipart this is empty. */
  readonly body: Uint8Array;
  readonly children: readonly MimePart[];
}

function splitHead(text: string): { head: string; body: string } {
  if (text.startsWith('\r\n') || text.startsWith('\n')) {
    return { head: '', body: text.replace(/^\r?\n/, '') };
  }
  const match = /\r?\n\r?\n/.exec(text);
  if (match === null) return { head: text, body: '' };
  return { head: text.slice(0, match.index), body: text.slice(match.index + match[0].length) };
}

function transferDecode(body: string, encoding: string | undefined): Uint8Array {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'base64':
      return decodeBase64Lenient(body);
    case 'quoted-printable':
      return decodeQuotedPrintable(body);
    default:
      return fromLatin1(body);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = new RegExp(
    `(?:^|\\r?\\n)--${escapeRegExp(boundary)}(--)?[ \\t]*(?=\\r?\\n|$)`,
    'g',
  );
  const parts: string[] = [];
  let previousEnd = -1;
  for (const match of body.matchAll(delimiter)) {
    if (previousEnd >= 0) parts.push(body.slice(previousEnd, match.index));
    previousEnd = match.index + match[0].length;
    if (match[1] !== undefined) {
      previousEnd = -1;
      break;
    }
    // Skip the line break after the delimiter.
    const rest = body.slice(previousEnd);
    previousEnd += /^\r?\n/.exec(rest)?.[0].length ?? 0;
  }
  // A missing close delimiter: take everything after the last open delimiter.
  if (previousEnd >= 0) parts.push(body.slice(previousEnd));
  return parts;
}

export function parseMime(
  input: Uint8Array,
  limits: Partial<MimeLimits> = {},
): { readonly root: MimePart; readonly partCount: number } {
  const effective = { ...DEFAULT_MIME_LIMITS, ...limits };
  if (input.length === 0) throw new MimeParseError('empty_message');
  if (input.length > effective.maxMessageBytes) throw new MimeParseError('message_too_large');

  let partCount = 0;
  const build = (text: string, partId: string, depth: number): MimePart => {
    partCount += 1;
    if (partCount > effective.maxParts) throw new MimeParseError('too_many_parts');
    const { head, body } = splitHead(text);
    const headers = parseHeaderBlock(head);
    const contentType = parseStructuredValue(headers.get('content-type') ?? 'text/plain');
    const disposition = parseStructuredValue(headers.get('content-disposition'));
    const boundary = contentType.params['boundary'];
    if (contentType.main.startsWith('multipart/') && boundary !== undefined && boundary !== '') {
      if (depth >= effective.maxDepth) {
        return { partId, headers, contentType, disposition, body: fromLatin1(body), children: [] };
      }
      const children = splitMultipart(body, boundary).map((chunk, index) =>
        build(
          chunk,
          partId === '' ? String(index + 1) : `${partId}.${String(index + 1)}`,
          depth + 1,
        ),
      );
      return { partId, headers, contentType, disposition, body: new Uint8Array(0), children };
    }
    return {
      partId,
      headers,
      contentType,
      disposition,
      body: transferDecode(body, headers.get('content-transfer-encoding')),
      children: [],
    };
  };

  const root = build(latin1(input), '', 0);
  return { root: { ...root, partId: root.partId === '' ? '0' : root.partId }, partCount };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Decodes a text leaf using its own charset parameter. CRLF becomes LF. */
export function decodeTextPart(part: MimePart): string {
  return decodeCharset(part.body, part.contentType.params['charset']).replace(/\r\n?/g, '\n');
}
