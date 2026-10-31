import { randomUUID } from 'node:crypto';

/**
 * Builds a plain RFC 5322 message for tests and the fake channel of the e2e harness (T-122c): what
 * a customer's mail client would send, with non-ASCII subjects and bodies encoded the way mail
 * clients do (RFC 2047 words, base64 body). Not a general MIME writer and never used to send.
 */

export interface FakeMimeOptions {
  readonly from: string;
  readonly fromName?: string | null;
  readonly to?: string;
  readonly subject: string;
  readonly body: string;
  readonly html?: string;
  /** Without angle brackets. Default: a random id on `fake.example.test`. */
  readonly messageId?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly date?: Date;
  /** Extra headers, for example `Auto-Submitted: auto-replied` or `List-Unsubscribe`. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface FakeMime {
  readonly raw: Uint8Array;
  /** `raw` as base64url, the form Gmail's `format=raw` returns. */
  readonly rawBase64Url: string;
  readonly messageId: string;
}

const isAscii = (value: string): boolean => /^[\x20-\x7e]*$/.test(value);

function encodeWord(value: string): string {
  if (isAscii(value)) return value;
  // One word per 24 characters keeps every encoded word under the 75-character limit.
  const words = Array.from(value);
  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += 24) {
    chunks.push(words.slice(index, index + 24).join(''));
  }
  return chunks
    .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}

function foldBase64(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n')
    .trimEnd();
}

function assertHeaderSafe(name: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`header ${name} must not contain a line break`);
}

export function buildFakeMime(options: FakeMimeOptions): FakeMime {
  const messageId = options.messageId ?? `${randomUUID()}@fake.example.test`;
  const from =
    options.fromName === undefined || options.fromName === null || options.fromName === ''
      ? options.from
      : `${encodeWord(options.fromName)} <${options.from}>`;
  const lines: string[] = [];
  const header = (name: string, value: string): void => {
    lines.push(`${name}: ${value}`);
  };
  // Check what the caller wrote; the encoder adds its own folding line breaks afterwards.
  assertHeaderSafe('Subject', options.subject);
  assertHeaderSafe('From', options.from + (options.fromName ?? ''));
  assertHeaderSafe('To', options.to ?? '');
  assertHeaderSafe('Message-ID', messageId);
  assertHeaderSafe('In-Reply-To', options.inReplyTo ?? '');
  for (const id of options.references ?? []) assertHeaderSafe('References', id);
  for (const [name, value] of Object.entries(options.headers ?? {})) assertHeaderSafe(name, value);
  header('From', from);
  header('To', options.to ?? 'support@fake.example.test');
  header('Subject', encodeWord(options.subject));
  header('Date', (options.date ?? new Date()).toUTCString().replace('GMT', '+0000'));
  header('Message-ID', `<${messageId}>`);
  if (options.inReplyTo !== undefined) header('In-Reply-To', `<${options.inReplyTo}>`);
  if ((options.references ?? []).length > 0) {
    header('References', (options.references ?? []).map((id) => `<${id}>`).join(' '));
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) header(name, value);
  header('MIME-Version', '1.0');

  let body: string;
  if (options.html === undefined) {
    header('Content-Type', 'text/plain; charset=UTF-8');
    header('Content-Transfer-Encoding', 'base64');
    body = foldBase64(options.body);
  } else {
    const boundary = `fake-${randomUUID()}`;
    header('Content-Type', `multipart/alternative; boundary="${boundary}"`);
    const part = (type: string, content: string): string =>
      [
        `--${boundary}`,
        `Content-Type: ${type}; charset=UTF-8`,
        'Content-Transfer-Encoding: base64',
        '',
        foldBase64(content),
      ].join('\r\n');
    body = [
      part('text/plain', options.body),
      part('text/html', options.html),
      `--${boundary}--`,
    ].join('\r\n');
  }
  const raw = Uint8Array.from(Buffer.from(`${lines.join('\r\n')}\r\n\r\n${body}\r\n`, 'utf8'));
  const rawBase64Url = Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { raw, rawBase64Url, messageId };
}
