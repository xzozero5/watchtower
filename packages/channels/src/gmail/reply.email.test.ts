import { describe, expect, it } from 'vitest';

import { normalizeMime } from './normalize.js';
import { buildReply, makeMessageId } from './reply.js';

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
