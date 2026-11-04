import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { loadFixture } from './__fixtures__/load.js';
import { normalizeMime } from './normalize.js';
import { ReplyBuildError, buildReply, makeMessageId, parentFromEmail } from './reply.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const parent = normalizeMime(loadFixture('plain-ascii.eml')).email;
const FIXED_DATE = new Date('2025-10-14T03:00:00Z');

function build(overrides: Record<string, unknown> = {}) {
  return buildReply({
    from: { address: 'support@example.com', name: 'Example Support' },
    inReplyTo: parentFromEmail(parent),
    textBody: 'We are looking into it.',
    messageId: makeMessageId('abc-123', 'app.example.com'),
    threadId: 't000001',
    date: FIXED_DATE,
    ...overrides,
  });
}

function decode(raw: string): { headers: string; body: string; text: string } {
  const text = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const [headers = '', ...rest] = text.split('\r\n\r\n');
  return { headers, body: rest.join('\r\n\r\n'), text };
}

describe('makeMessageId', () => {
  it('derives a stable id from the delivery id and host', () => {
    expect(makeMessageId('0f1e2d3c', 'App.Example.com')).toBe('wt.0f1e2d3c@app.example.com');
  });

  it('strips characters that could break a header', () => {
    expect(makeMessageId('a b<>\r\nc', 'x.example.com')).toBe('wt.abc@x.example.com');
  });

  it('refuses an empty id', () => {
    expect(() => makeMessageId('<>', 'x.example.com')).toThrow(ReplyBuildError);
  });
});

describe('buildReply: headers for an in-thread send (R-2.3)', () => {
  const built = build();
  const { headers, body } = decode(built.raw);

  it('sets threadId, In-Reply-To, References and keeps the subject', () => {
    expect(built.threadId).toBe('t000001');
    expect(headers).toContain('In-Reply-To: <CAF1234abcd@mail.customer.example.com>');
    expect(headers).toContain('References: <CAF1234abcd@mail.customer.example.com>');
    expect(headers).toContain('Subject: Cannot log in to the dashboard');
    expect(built.headers.subject).toBe('Cannot log in to the dashboard');
  });

  it('addresses the original sender from the configured mailbox', () => {
    expect(headers).toContain('From: Example Support <support@example.com>');
    expect(headers).toContain('To: Alice Example <alice@customer.example.com>');
    expect(built.headers.to).toEqual(['alice@customer.example.com']);
  });

  it('uses the supplied Message-ID and a fixed date', () => {
    expect(headers).toContain('Message-ID: <wt.abc-123@app.example.com>');
    expect(built.headers.messageId).toBe('wt.abc-123@app.example.com');
    expect(headers).toContain('Date: Tue, 14 Oct 2025 03:00:00 +0000');
  });

  it('uses CRLF and base64 UTF-8 for the body', () => {
    expect(headers).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(headers).toContain('Content-Transfer-Encoding: base64');
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe('We are looking into it.');
    expect(headers).not.toMatch(/(?<!\r)\n/);
  });

  it('is not an automatic response by default', () => {
    expect(headers).not.toContain('Auto-Submitted');
  });

  it('round-trips through the inbound normaliser', () => {
    const raw = Buffer.from(built.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const { email } = normalizeMime(Uint8Array.from(raw));
    expect(email.inReplyTo).toBe('CAF1234abcd@mail.customer.example.com');
    expect(email.messageId).toBe('wt.abc-123@app.example.com');
    expect(email.textBody).toBe('We are looking into it.');
    expect(email.to[0]?.address).toBe('alice@customer.example.com');
  });
});

describe('buildReply: references chain', () => {
  const reply = normalizeMime(loadFixture('reply-in-thread.eml')).email;

  it('appends the parent to the existing chain without duplicating it', () => {
    const built = build({ inReplyTo: parentFromEmail(reply) });
    expect(built.headers.references).toEqual([
      'CAF1234abcd@mail.customer.example.com',
      'wt.delivery1@example.com',
      'CAF5678efgh@mail.customer.example.com',
    ]);
    expect(built.headers.inReplyTo).toBe('CAF5678efgh@mail.customer.example.com');
    const again = build({
      inReplyTo: {
        ...parentFromEmail(reply),
        references: [...reply.references, reply.messageId ?? ''],
      },
    });
    expect(again.headers.references).toHaveLength(3);
  });

  it('keeps the root and the newest ids when the chain is very long', () => {
    const references = Array.from({ length: 60 }, (_, i) => `id${String(i)}@x.example.com`);
    const built = build({ inReplyTo: { ...parentFromEmail(parent), references } });
    expect(built.headers.references).toHaveLength(30);
    expect(built.headers.references[0]).toBe('id0@x.example.com');
    expect(built.headers.references.at(-1)).toBe('CAF1234abcd@mail.customer.example.com');
  });

  it('folds long References lines under 78 characters', () => {
    const references = Array.from(
      { length: 8 },
      (_, i) => `a-long-message-id-number-${String(i)}@host.example.com`,
    );
    const { headers } = decode(
      build({ inReplyTo: { ...parentFromEmail(parent), references } }).raw,
    );
    for (const line of headers.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
  });
});

describe('buildReply: subject handling', () => {
  it('can add Re: and the ticket key token', () => {
    const built = build({ subjectMode: 'prefix_re', ticketKey: 'ops-77' });
    expect(built.headers.subject).toBe('Re: Cannot log in to the dashboard [OPS-77]');
  });

  it('does not double the token or the Re: prefix', () => {
    const tagged = { ...parentFromEmail(parent), subject: 'Re: Problem [OPS-77]' };
    const built = build({ inReplyTo: tagged, subjectMode: 'prefix_re', ticketKey: 'OPS-77' });
    expect(built.headers.subject).toBe('Re: Problem [OPS-77]');
  });

  it('encodes a Thai subject and display name as RFC 2047 words that decode back', () => {
    const thai = { ...parentFromEmail(parent), subject: 'ระบบรายงานเปิดไม่ได้ ' + 'ก'.repeat(60) };
    const built = build({
      inReplyTo: thai,
      from: { address: 'support@example.com', name: 'ทีมซัพพอร์ต' },
    });
    const raw = Buffer.from(built.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const { email } = normalizeMime(Uint8Array.from(raw));
    expect(email.subject).toBe(thai.subject);
    const { headers } = decode(built.raw);
    for (const line of headers.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
  });
});

describe('buildReply: other behaviours', () => {
  it('marks automatic replies with Auto-Submitted: auto-replied (RFC 3834)', () => {
    expect(decode(build({ automatic: true }).raw).headers).toContain(
      'Auto-Submitted: auto-replied',
    );
  });

  it('marks a message the system starts itself with Auto-Submitted: auto-generated', () => {
    expect(
      decode(build({ automatic: true, autoSubmitted: 'auto-generated' }).raw).headers,
    ).toContain('Auto-Submitted: auto-generated');
  });

  it('sends multipart/alternative when HTML is given', () => {
    const { headers, text } = decode(build({ htmlBody: '<p>Hello</p>' }).raw);
    expect(headers).toMatch(/Content-Type: multipart\/alternative; boundary="wt-[0-9a-f]{24}"/);
    expect(text).toContain('Content-Type: text/html; charset="UTF-8"');
  });

  it('prefers Reply-To over From and allows overriding recipients and adding Cc', () => {
    const withReplyTo = {
      ...parentFromEmail(parent),
      replyTo: [{ address: 'desk@customer.example.com', name: null }],
    };
    expect(build({ inReplyTo: withReplyTo }).headers.to).toEqual(['desk@customer.example.com']);
    const { headers } = decode(
      build({
        to: [{ address: 'x@customer.example.com' }],
        cc: [{ address: 'y@customer.example.com', name: 'Y, Person' }],
      }).raw,
    );
    expect(headers).toContain('To: x@customer.example.com');
    expect(headers).toContain('Cc: "Y, Person" <y@customer.example.com>');
  });

  it('uses a from alias when given (send-as, R-2.4)', () => {
    const { headers } = decode(build({ from: { address: 'billing@example.com' } }).raw);
    expect(headers).toContain('From: billing@example.com');
  });

  it('sends a first message of a thread when the parent has no Message-ID', () => {
    const built = build({
      inReplyTo: { ...parentFromEmail(parent), messageId: null, references: [] },
    });
    expect(built.headers.inReplyTo).toBeNull();
    expect(decode(built.raw).headers).not.toContain('In-Reply-To');
  });

  it('works without a thread id', () => {
    expect(build({ threadId: undefined }).threadId).toBeUndefined();
  });

  it('is deterministic for the same input', () => {
    expect(build().raw).toBe(build().raw);
  });
});

describe('buildReply: rejects bad input', () => {
  it('refuses CR/LF in any header value (header injection)', () => {
    const injected = { ...parentFromEmail(parent), subject: 'Hi\r\nBcc: attacker@example.com' };
    expect(() => build({ inReplyTo: injected })).toThrow(/header_injection/);
    expect(() =>
      build({ from: { address: 'a@example.com', name: 'X\nBcc: y@example.com' } }),
    ).toThrow(/header_injection/);
    expect(() =>
      build({
        inReplyTo: { ...parentFromEmail(parent), references: ['a@x.example.com>\r\nBcc: z'] },
      }),
    ).toThrow(ReplyBuildError);
  });

  it('refuses a missing recipient, an empty body and a malformed Message-ID', () => {
    expect(() => build({ inReplyTo: { ...parentFromEmail(parent), from: null } })).toThrow(
      /no recipient/,
    );
    expect(() => build({ textBody: '' })).toThrow(ReplyBuildError);
    expect(() => build({ messageId: 'no-at-sign' })).toThrow(ReplyBuildError);
    expect(() => build({ from: { address: 'not an address' } })).toThrow(ReplyBuildError);
  });

  it('does not echo the input in the error message', () => {
    try {
      build({ textBody: '' });
    } catch (error) {
      expect(String(error)).not.toContain('alice@customer.example.com');
    }
  });
});
