import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import {
  MimeParseError,
  decodeBase64Lenient,
  decodeCharset,
  decodeEncodedWords,
  decodeQuotedPrintable,
  parseAddressList,
  parseHeaderBlock,
  parseMessageIds,
  parseMime,
  parseStructuredValue,
} from './mime.js';

const guard = disableNetConnect();
afterAll(() => {
  expect(guard.blocked()).toEqual([]);
  guard.restore();
});

const thai = 'สวัสดีครับ';
const tis620 = Uint8Array.from([0xca, 0xc7, 0xd1, 0xca, 0xb4, 0xd5, 0xa4, 0xc3, 0xd1, 0xba]);

describe('decodeCharset', () => {
  it.each(['tis-620', 'TIS-620', 'iso-8859-11', 'windows-874', 'x-windows-874', 'cp874'])(
    'decodes Thai bytes labelled %s',
    (label) => {
      expect(decodeCharset(tis620, label)).toBe(thai);
    },
  );

  it('decodes UTF-8', () => {
    expect(decodeCharset(Uint8Array.from(Buffer.from(thai, 'utf8')), 'utf-8')).toBe(thai);
  });

  it('treats a latin1 label on valid UTF-8 bytes as UTF-8 (mislabelled mail)', () => {
    expect(decodeCharset(Uint8Array.from(Buffer.from(thai, 'utf8')), 'iso-8859-1')).toBe(thai);
  });

  it('falls back from an unknown charset to UTF-8, then to windows-874', () => {
    expect(decodeCharset(Uint8Array.from(Buffer.from(thai, 'utf8')), 'x-unknown')).toBe(thai);
    expect(decodeCharset(tis620, 'x-unknown')).toBe(thai);
    expect(decodeCharset(tis620, undefined)).toBe(thai);
  });

  it('never throws on garbage', () => {
    expect(() => decodeCharset(Uint8Array.from([0xff, 0xfe, 0x80]), 'utf-8')).not.toThrow();
  });
});

describe('transfer decoding', () => {
  it('decodes base64 with line breaks and missing padding', () => {
    expect(Buffer.from(decodeBase64Lenient('aGVs\r\nbG8')).toString()).toBe('hello');
  });

  it('decodes quoted-printable including soft line breaks', () => {
    const bytes = decodeQuotedPrintable('caf=C3=A9 and a long =\r\nline');
    expect(Buffer.from(bytes).toString('utf8')).toBe('café and a long line');
  });

  it('leaves an invalid =XX sequence alone', () => {
    expect(Buffer.from(decodeQuotedPrintable('50=ZZ')).toString()).toBe('50=ZZ');
  });
});

describe('RFC 2047 encoded-words', () => {
  it('decodes B and Q words with their own charset', () => {
    expect(decodeEncodedWords('=?UTF-8?B?4Liq4Lin4Lix4Liq4LiU4Li1?=')).toBe('สวัสดี');
    expect(decodeEncodedWords('=?TIS-620?Q?=CA=C7=D1=CA=B4=D5?=')).toBe('สวัสดี');
    expect(decodeEncodedWords('=?iso-8859-1?Q?caf=E9_au_lait?=')).toBe('café au lait');
  });

  it('joins adjacent words and drops the whitespace between them', () => {
    const half = Buffer.from('สวัสดี', 'utf8');
    // Split inside a multi-byte character: only decoding the words together gets it right.
    const first = half.subarray(0, 4).toString('base64');
    const second = half.subarray(4).toString('base64');
    expect(decodeEncodedWords(`=?UTF-8?B?${first}?= =?UTF-8?B?${second}?=`)).toBe('สวัสดี');
  });

  it('keeps plain text around encoded words', () => {
    expect(decodeEncodedWords('Re: =?UTF-8?B?4Liq4Lin4Lix4Liq4LiU4Li1?= [OPS-1]')).toBe(
      'Re: สวัสดี [OPS-1]',
    );
  });

  it('returns text without encoded words unchanged', () => {
    expect(decodeEncodedWords('plain subject')).toBe('plain subject');
  });
});

describe('headers', () => {
  it('unfolds continuation lines and keeps repeated fields', () => {
    const bag = parseHeaderBlock(
      'Subject: a long\r\n subject line\r\nReceived: one\r\nReceived: two\r\nX-Empty:\r\n',
    );
    expect(bag.get('subject')).toBe('a long subject line');
    expect(bag.getAll('received')).toEqual(['one', 'two']);
    expect(bag.get('SUBJECT')).toBe('a long subject line');
    expect(bag.has('x-empty')).toBe(true);
  });

  it('ignores lines that are not header fields', () => {
    expect(parseHeaderBlock('garbage line\r\nFrom: a@example.com').fields).toHaveLength(1);
  });
});

describe('structured values (RFC 2231)', () => {
  it('parses quoted parameters and lower-cases the main value', () => {
    const value = parseStructuredValue('Multipart/Mixed; Boundary="a;b"; charset=utf-8');
    expect(value.main).toBe('multipart/mixed');
    expect(value.params['boundary']).toBe('a;b');
  });

  it('decodes extended and continued filename parameters', () => {
    const star = parseStructuredValue(
      "attachment; filename*=UTF-8''%E0%B8%A3%E0%B8%B2%E0%B8%A2.txt",
    );
    expect(star.params['filename']).toBe('ราย.txt');
    const parts = parseStructuredValue(
      "attachment; filename*0*=UTF-8''%E0%B8%A3%E0%B8%B2; filename*1*=%E0%B8%A2; filename*2=.txt",
    );
    expect(parts.params['filename']).toBe('ราย.txt');
  });

  it('decodes an RFC 2047 word used (non-standard) in a filename', () => {
    const value = parseStructuredValue('attachment; filename="=?UTF-8?B?4Lij4Liy4LiiLnR4dA==?="');
    expect(value.params['filename']).toBe('ราย.txt');
  });

  it('returns an empty value for a missing header', () => {
    expect(parseStructuredValue(undefined)).toEqual({ main: '', params: {} });
  });
});

describe('addresses', () => {
  it('parses names, angle addresses and bare addresses', () => {
    expect(
      parseAddressList(
        '"Doe, Jane" <Jane@Example.com>, bob@example.com, Carol (ops) <carol@example.com>',
      ),
    ).toEqual([
      { address: 'jane@example.com', name: 'Doe, Jane' },
      { address: 'bob@example.com', name: null },
      { address: 'carol@example.com', name: 'Carol' },
    ]);
  });

  it('decodes encoded display names', () => {
    expect(parseAddressList('=?UTF-8?B?4Liq4Lih4LiK4Liy4Lii?= <somchai@example.com>')).toEqual([
      { address: 'somchai@example.com', name: 'สมชาย' },
    ]);
  });

  it('handles groups and drops invalid entries', () => {
    expect(parseAddressList('Team: a@example.com, b@example.com;, not-an-address')).toEqual([
      { address: 'a@example.com', name: null },
      { address: 'b@example.com', name: null },
    ]);
  });

  it('returns an empty list for an undefined header', () => {
    expect(parseAddressList(undefined)).toEqual([]);
  });

  it('extracts message ids without brackets', () => {
    expect(parseMessageIds('<a@x.example.com> (comment) <B@Y.example.com>')).toEqual([
      'a@x.example.com',
      'B@Y.example.com',
    ]);
  });
});

describe('parseMime', () => {
  const raw = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'latin1'));

  it('splits a multipart body and numbers the parts', () => {
    const { root, partCount } = parseMime(
      raw(
        'Content-Type: multipart/mixed; boundary=XX\r\n\r\npreamble\r\n--XX\r\nContent-Type: text/plain\r\n\r\none\r\n--XX\r\nContent-Type: text/plain\r\n\r\ntwo\r\n--XX--\r\nepilogue',
      ),
    );
    expect(partCount).toBe(3);
    expect(root.children.map((child) => child.partId)).toEqual(['1', '2']);
    expect(Buffer.from(root.children[1]?.body ?? []).toString()).toBe('two');
  });

  it('tolerates LF line endings and a missing close delimiter', () => {
    const { root } = parseMime(
      raw('Content-Type: multipart/mixed; boundary=XX\n\n--XX\nContent-Type: text/plain\n\nbody'),
    );
    expect(root.children).toHaveLength(1);
    expect(Buffer.from(root.children[0]?.body ?? []).toString()).toBe('body');
  });

  it('treats a message without headers as plain text', () => {
    const { root } = parseMime(raw('\r\njust a body'));
    expect(root.contentType.main).toBe('text/plain');
    expect(Buffer.from(root.body).toString()).toBe('just a body');
  });

  it('rejects an empty input and an oversized input', () => {
    expect(() => parseMime(new Uint8Array(0))).toThrow(MimeParseError);
    expect(() =>
      parseMime(raw('Subject: x\r\n\r\n' + 'a'.repeat(100)), { maxMessageBytes: 50 }),
    ).toThrow(/message_too_large/);
  });

  it('rejects a message with too many parts', () => {
    const parts = Array.from(
      { length: 20 },
      () => '--B\r\nContent-Type: text/plain\r\n\r\nx\r\n',
    ).join('');
    expect(() =>
      parseMime(raw(`Content-Type: multipart/mixed; boundary=B\r\n\r\n${parts}--B--`), {
        maxParts: 10,
      }),
    ).toThrow(/too_many_parts/);
  });

  it('stops recursing at the depth limit instead of failing', () => {
    let body = 'Content-Type: text/plain\r\n\r\nleaf';
    for (let level = 0; level < 20; level += 1) {
      body = `Content-Type: multipart/mixed; boundary=B${String(level)}\r\n\r\n--B${String(level)}\r\n${body}\r\n--B${String(level)}--`;
    }
    expect(() => parseMime(raw(body), { maxDepth: 5 })).not.toThrow();
  });
});
