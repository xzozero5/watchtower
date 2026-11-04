import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { loadFixture } from './__fixtures__/load.js';
import { normalizeMime } from './normalize.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const thaiBody = 'สวัสดีครับ ระบบรายงานของเราเปิดไม่ได้ตั้งแต่เช้านี้ รบกวนตรวจสอบให้หน่อยครับ';
const thaiSubject = 'ระบบรายงานเปิดไม่ได้';

describe('normalizeMime: plain text', () => {
  it('extracts headers, addresses and body', () => {
    const { email } = normalizeMime(loadFixture('plain-ascii.eml'));
    expect(email.messageId).toBe('CAF1234abcd@mail.customer.example.com');
    expect(email.subject).toBe('Cannot log in to the dashboard');
    expect(email.from).toEqual({ address: 'alice@customer.example.com', name: 'Alice Example' });
    expect(email.to).toEqual([{ address: 'support@example.com', name: 'Support' }]);
    expect(email.sentAt).toBe('2025-10-14T02:11:58.000Z');
    expect(email.textSource).toBe('plain');
    expect(email.textBody).toContain('The page shows a blank screen.');
    expect(email.textBody).not.toContain('\r');
    expect(email.safeHtml).toBeNull();
    expect(email.attachments).toEqual([]);
  });

  it('gives the same result for CRLF and LF fixtures', () => {
    const crlf = normalizeMime(loadFixture('plain-ascii.eml')).email;
    const lf = normalizeMime(loadFixture('plain-ascii.eml', { crlf: false })).email;
    expect(lf).toEqual(crlf);
  });
});

describe('normalizeMime: Thai', () => {
  it('reads a UTF-8 multipart/alternative with QP text, base64 HTML and encoded headers', () => {
    const { email } = normalizeMime(loadFixture('thai-utf8-alternative.eml'));
    expect(email.subject).toBe(thaiSubject);
    expect(email.from?.name).toBe('สมชาย ใจดี');
    expect(email.textBody).toBe(thaiBody);
    expect(email.textSource).toBe('plain');
    expect(email.safeHtml).toContain(`<p>${thaiBody}</p>`);
    expect(email.safeHtml).toContain('<b>ด่วน</b>');
  });

  it('reads TIS-620 body (quoted-printable) and subject (B word)', () => {
    const { email } = normalizeMime(loadFixture('thai-tis620-qp.eml'));
    expect(email.subject).toBe(thaiSubject);
    expect(email.textBody).toBe(thaiBody);
  });

  it('reads windows-874 body (base64) and subject (Q word)', () => {
    const { email } = normalizeMime(loadFixture('thai-windows874-base64.eml'));
    expect(email.subject).toBe(thaiSubject);
    expect(email.textBody).toBe(thaiBody);
  });

  it('reads a raw 8-bit TIS-620 body with no transfer encoding', () => {
    const head =
      'From: a@customer.example.com\r\nContent-Type: text/plain; charset=tis-620\r\nContent-Transfer-Encoding: 8bit\r\n\r\n';
    const body = Buffer.from([0xca, 0xc7, 0xd1, 0xca, 0xb4, 0xd5]);
    const raw = Uint8Array.from(Buffer.concat([Buffer.from(head, 'latin1'), body]));
    expect(normalizeMime(raw).email.textBody).toBe('สวัสดี');
  });

  it('reads a raw 8-bit UTF-8 header without encoded words', () => {
    const raw = Uint8Array.from(
      Buffer.from('Subject: ปัญหาระบบ\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nx', 'utf8'),
    );
    expect(normalizeMime(raw).email.subject).toBe('ปัญหาระบบ');
  });
});

describe('normalizeMime: inline images and attachments', () => {
  const result = normalizeMime(loadFixture('inline-image-attachment.eml'));

  it('keeps the plain and HTML bodies of the nested alternative', () => {
    expect(result.email.textBody).toBe('See the screenshot below.');
    expect(result.email.safeHtml).toContain('See the screenshot below.');
  });

  it('turns the inline image into an attachment reference tied to the HTML by cid', () => {
    expect(result.email.safeHtml).toContain('src="cid:shot1@customer.example.com"');
    const image = result.email.attachments.find((a) => a.contentType === 'image/png');
    expect(image).toMatchObject({
      filename: 'shot.png',
      disposition: 'inline',
      contentId: 'shot1@customer.example.com',
      referencedByHtml: true,
    });
    expect(image?.size).toBeGreaterThan(0);
    expect(image?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const bytes = result.attachmentData.get(image?.partId ?? '');
    expect(bytes?.length).toBe(image?.size);
    // PNG signature
    expect(Array.from(bytes?.subarray(0, 4) ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('blocks the remote tracking pixel (no src, nothing loads) and counts it', () => {
    expect(result.email.safeHtml).not.toMatch(/\ssrc="https?:/);
    expect(result.email.safeHtml).toContain(
      'data-remote-src="https://tracker.example.net/pixel.gif"',
    );
    expect(result.email.remoteImagesBlocked).toBe(1);
  });

  it('lists the regular attachment with its decoded RFC 2231 Thai filename', () => {
    const log = result.email.attachments.find((a) => a.disposition === 'attachment');
    expect(log).toMatchObject({
      filename: 'รายงาน.txt',
      contentType: 'text/plain',
      contentId: null,
    });
    expect(Buffer.from(result.attachmentData.get(log?.partId ?? '') ?? []).toString()).toBe(
      'line one\nline two\n',
    );
    // Not mistaken for a body.
    expect(result.email.textBody).not.toContain('line one');
  });

  it('strips path segments from an attachment filename', () => {
    const raw = Buffer.from(
      'Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="..\\..\\evil/../a.bin"\r\n\r\nxx\r\n--B--',
      'latin1',
    );
    const ref = normalizeMime(Uint8Array.from(raw)).email.attachments[0];
    expect(ref?.filename).toBe('a.bin');
  });
});

describe('normalizeMime: hostile HTML', () => {
  const { email } = normalizeMime(loadFixture('html-hostile.eml'));
  const html = email.safeHtml ?? '';

  it('removes scripts, styles, frames, forms, svg, handlers and comments', () => {
    for (const forbidden of [
      '<script',
      '<style',
      '<iframe',
      '<form',
      '<input',
      '<svg',
      'onload',
      'onclick',
      'onerror',
      'steal',
      'evil.example.net',
      'comment()',
      'background:url',
      'c.css',
    ]) {
      expect(html.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // The remote image is held back: its address is inert data, not a src.
    expect(html).not.toMatch(/\ssrc="https?:/);
  });

  it('drops javascript: links, including obfuscated ones, and keeps safe links hardened', () => {
    expect(html.toLowerCase()).not.toContain('javascript');
    expect(html).toContain(
      '<a href="https://docs.example.com/page?a=1&amp;b=2" rel="noopener noreferrer nofollow" target="_blank">docs</a>',
    );
  });

  it('keeps the visible text', () => {
    expect(html).toContain('<p style="color:red">Hello <b>world</b></p>');
    expect(email.textBody).toContain('Hello world');
    expect(email.textBody).toContain('docs (https://docs.example.com/page?a=1&b=2)');
    expect(email.textSource).toBe('html');
  });

  it('counts the blocked remote image', () => {
    expect(email.remoteImagesBlocked).toBe(1);
  });
});

describe('normalizeMime: threading headers', () => {
  it('parses In-Reply-To and a folded References header', () => {
    const { email } = normalizeMime(loadFixture('reply-in-thread.eml'));
    expect(email.inReplyTo).toBe('wt.delivery1@example.com');
    expect(email.references).toEqual([
      'CAF1234abcd@mail.customer.example.com',
      'wt.delivery1@example.com',
    ]);
    expect(email.subject).toBe('Re: Cannot log in to the dashboard [OPS-1234]');
  });
});

describe('normalizeMime: bounce', () => {
  it('exposes the delivery-status part and keeps the explanation as the body', () => {
    const result = normalizeMime(loadFixture('bounce-dsn.eml'));
    expect(result.rootContentType).toBe('multipart/report');
    expect(result.deliveryStatusParts).toHaveLength(1);
    expect(result.email.textBody).toContain('could not be delivered');
    expect(result.email.attachments.map((a) => a.contentType).sort()).toEqual([
      'message/delivery-status',
      'text/rfc822-headers',
    ]);
  });
});

describe('normalizeMime: sender authentication (T-114a C-3)', () => {
  const mail = (extra: string): Uint8Array =>
    new TextEncoder().encode(
      `${extra}From: Ann <ann@customer.example>\r\nTo: s@example.com\r\nSubject: hi\r\nMessage-ID: <a@customer.example>\r\nContent-Type: text/plain\r\n\r\nhello\r\n`,
    );

  it('reads dmarc=pass from the receiving server header', () => {
    const raw = mail(
      'Authentication-Results: mx.google.com; dmarc=pass header.from=customer.example\r\n',
    );
    expect(normalizeMime(raw).email.senderAuth).toBe('pass');
  });

  it('is none without the header and fail on dmarc=fail', () => {
    expect(normalizeMime(mail('')).email.senderAuth).toBe('none');
    const failed = mail(
      'Authentication-Results: mx.google.com; dmarc=fail header.from=customer.example\r\n',
    );
    expect(normalizeMime(failed).email.senderAuth).toBe('fail');
  });
});
