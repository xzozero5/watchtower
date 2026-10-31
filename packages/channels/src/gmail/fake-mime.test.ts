import { describe, expect, it } from 'vitest';

import { classifyAutomated } from './classify.js';
import { buildFakeMime } from './fake-mime.js';
import { normalizeMime } from './normalize.js';

describe('buildFakeMime', () => {
  it('round-trips a Thai subject, sender name and body through the real normaliser', () => {
    const { raw, messageId } = buildFakeMime({
      from: 'somchai@customer.example.test',
      fromName: 'สมชาย ใจดี',
      subject: 'ระบบรายงานเปิดไม่ได้ตั้งแต่เช้านี้ รบกวนตรวจสอบด่วนมากครับ',
      body: 'สวัสดีครับ\nรายงานเปิดไม่ได้',
      messageId: 'abc123@customer.example.test',
    });
    const { email } = normalizeMime(raw);
    expect(messageId).toBe('abc123@customer.example.test');
    expect(email.messageId).toBe('abc123@customer.example.test');
    expect(email.from).toEqual({ address: 'somchai@customer.example.test', name: 'สมชาย ใจดี' });
    expect(email.subject).toBe('ระบบรายงานเปิดไม่ได้ตั้งแต่เช้านี้ รบกวนตรวจสอบด่วนมากครับ');
    expect(email.textBody).toBe('สวัสดีครับ\nรายงานเปิดไม่ได้');
  });

  it('writes reply headers and an HTML alternative', () => {
    const { raw } = buildFakeMime({
      from: 'a@customer.example.test',
      subject: 'Re: Hello',
      body: 'plain',
      html: '<p>rich</p>',
      inReplyTo: 'parent@x.example.test',
      references: ['root@x.example.test', 'parent@x.example.test'],
    });
    const { email } = normalizeMime(raw);
    expect(email.inReplyTo).toBe('parent@x.example.test');
    expect(email.references).toEqual(['root@x.example.test', 'parent@x.example.test']);
    expect(email.safeHtml).toContain('rich');
    expect(email.textBody).toBe('plain');
  });

  it('carries extra headers the classifier reads', () => {
    const { raw } = buildFakeMime({
      from: 'a@customer.example.test',
      subject: 'Out of office',
      body: 'I am away',
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
    const parsed = normalizeMime(raw);
    const verdict = classifyAutomated({
      headers: parsed.headers,
      rootContentType: parsed.rootContentType,
      rootContentTypeParams: parsed.rootContentTypeParams,
      subject: parsed.email.subject,
    });
    expect(verdict).toMatchObject({ disposition: 'auto_reply', subtype: 'out_of_office' });
  });

  it('refuses a header value with a line break (no header injection)', () => {
    expect(() =>
      buildFakeMime({
        from: 'a@x.example.test',
        subject: 'x',
        body: 'y',
        headers: { 'X-A': 'b\r\nBcc: c' },
      }),
    ).toThrow(/line break/);
  });
});
