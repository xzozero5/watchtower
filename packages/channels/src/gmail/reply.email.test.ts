import { describe, expect, it } from 'vitest';

import { normalizeMime } from './normalize.js';
import { buildReply, encodeRfc8187, makeMessageId } from './reply.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function build(overrides: Record<string, unknown> = {}) {
  return buildReply({
    from: { address: 'support@example.com', name: 'Example Support' },
    inReplyTo: {
      messageId: 'parent-1@mail.example.net',
      references: ['root-0@mail.example.net'],
      subject: 'Printer is down',
      from: { address: 'customer@example.org', name: 'Customer' },
      replyTo: [],
    },
    textBody: 'Hello\nWe are on it.',
    htmlBody: '<p>Hello</p><p><b>We are on it.</b></p>',
    messageId: makeMessageId('abc-123', 'app.example.com'),
    threadId: 't1',
    date: new Date('2025-10-14T03:00:00Z'),
    ...overrides,
  });
}

function mime(raw: string) {
  const bytes = Uint8Array.from(Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  return { bytes, text: Buffer.from(bytes).toString('utf8'), parsed: normalizeMime(bytes) };
}

describe('buildReply for an email composer', () => {
  it('sends text and html as multipart/alternative, threaded to the parent', () => {
    const built = build();
    const { text, parsed } = mime(built.raw);
    expect(text).toContain('Content-Type: multipart/alternative;');
    expect(text).toContain('In-Reply-To: <parent-1@mail.example.net>');
    expect(text).toContain('References: <root-0@mail.example.net> <parent-1@mail.example.net>');
    expect(parsed.email.textBody).toContain('We are on it.');
    expect(parsed.email.safeHtml).toContain('<b>We are on it.</b>');
  });

  it('writes Cc and Bcc headers and uses the typed subject', () => {
    const built = build({
      to: [{ address: 'a@example.org' }],
      cc: [{ address: 'b@example.org', name: 'B' }],
      bcc: [{ address: 'hidden@example.org' }],
      subject: 'Re: Printer is down (follow-up)',
    });
    const { text, parsed } = mime(built.raw);
    expect(text).toContain('Cc: B <b@example.org>');
    expect(text).toContain('Bcc: hidden@example.org');
    expect(parsed.email.subject).toBe('Re: Printer is down (follow-up)');
    expect(parsed.email.cc.map((c) => c.address)).toEqual(['b@example.org']);
  });

  it('keeps a blind copy in the Bcc header only (Gmail has no envelope), never in To, Cc or the reported recipients', () => {
    const built = build({
      to: [{ address: 'a@example.org' }],
      cc: [{ address: 'b@example.org' }],
      bcc: [{ address: 'hidden@example.org', name: 'Hidden' }],
    });
    const { text } = mime(built.raw);
    const headerBlock = text.split('\r\n\r\n')[0] ?? '';
    const holders = headerBlock.split('\r\n').filter((line) => line.includes('hidden@example.org'));
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatch(/^Bcc: |^ /);
    expect(headerBlock).toMatch(/^Bcc: Hidden <hidden@example\.org>$/m);
    // Not in the body either, and not in what the caller records as the recipients.
    expect(text.slice(headerBlock.length)).not.toContain('hidden@example.org');
    expect(built.headers.to).toEqual(['a@example.org']);
    expect(JSON.stringify(built.headers)).not.toContain('hidden@example.org');
  });

  it('lists an address once: a Cc or Bcc of someone already in To (or Cc) is dropped, with no empty header left', () => {
    const built = build({
      to: [{ address: 'A@example.org' }],
      cc: [{ address: 'a@example.org' }, { address: 'b@example.org' }],
      bcc: [{ address: 'b@example.org' }, { address: 'A@example.org' }],
    });
    const { text } = mime(built.raw);
    expect(text).toContain('Cc: b@example.org');
    expect(text).not.toMatch(/^Bcc:/m);
    expect(text.match(/b@example\.org/gi)).toHaveLength(1);
    expect(text.match(/a@example\.org/gi)).toHaveLength(1);
  });

  it('refuses a line break in a blind-copy address or name', () => {
    expect(() =>
      build({ bcc: [{ address: 'x@example.org', name: 'X\r\nTo: evil@example.org' }] }),
    ).toThrow(/header_injection/);
  });

  it('encodes the file name as RFC 8187 (no quote, parentheses or asterisk left raw in filename*)', () => {
    expect(encodeRfc8187("a(1)*'b.txt")).toBe('a%281%29%2A%27b.txt');
    const built = build({
      attachments: [
        { filename: "รายงาน (1)'.txt", contentType: 'text/plain', data: Buffer.from('x') },
      ],
    });
    const { text } = mime(built.raw);
    const star = /filename\*=UTF-8''([^\r\n;]+)/.exec(text)?.[1] ?? '';
    expect(star).not.toMatch(/['()*]/);
    expect(decodeURIComponent(star)).toBe("รายงาน (1)'.txt");
  });

  it('puts inline images in multipart/related and files in multipart/mixed', () => {
    const built = build({
      htmlBody: '<p>See <img src="cid:logo-1@wt"></p>',
      attachments: [
        {
          filename: 'logo.png',
          contentType: 'image/png',
          data: PNG,
          contentId: 'logo-1@wt',
          inline: true,
        },
        { filename: 'รายงาน.pdf', contentType: 'application/pdf', data: PNG },
      ],
    });
    const { text, parsed } = mime(built.raw);
    expect(text).toContain('Content-Type: multipart/mixed;');
    expect(text).toContain('Content-Type: multipart/related;');
    expect(text).toContain('Content-ID: <logo-1@wt>');
    expect(text).toContain("filename*=UTF-8''");
    expect(parsed.email.attachments.map((a) => a.contentType).sort()).toEqual([
      'application/pdf',
      'image/png',
    ]);
    expect(parsed.email.safeHtml).toContain('cid:logo-1@wt');
  });

  it('attaches files to a plain-text reply with multipart/mixed', () => {
    const { text } = mime(
      build({
        htmlBody: undefined,
        attachments: [{ filename: 'a.txt', contentType: 'text/plain', data: PNG }],
      }).raw,
    );
    expect(text).toContain('Content-Type: multipart/mixed;');
    expect(text).not.toContain('multipart/alternative');
  });

  it('refuses a header injection through the subject or a file name', () => {
    expect(() => build({ subject: 'x\r\nBcc: evil@example.org' })).toThrow(/header_injection/);
    expect(() =>
      build({ attachments: [{ filename: 'a\r\nb', contentType: 'text/plain', data: PNG }] }),
    ).toThrow(/header_injection/);
  });
});
