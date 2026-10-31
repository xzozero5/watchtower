import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { loadFixture } from './__fixtures__/load.js';
import { normalizeMime } from './normalize.js';
import { buildThreadKeys, extractTicketKeys, normalizeMessageId } from './threads.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

describe('normalizeMessageId', () => {
  it('removes brackets and whitespace and lower-cases', () => {
    expect(normalizeMessageId(' <ABC@Example.COM> ')).toBe('abc@example.com');
  });
});

describe('extractTicketKeys', () => {
  it('finds bracketed tokens with the instance prefix, in any case, once', () => {
    expect(extractTicketKeys('Re: [OPS-1234] help [ops-1234] [OPS-9]', 'OPS')).toEqual([
      'OPS-1234',
      'OPS-9',
    ]);
  });

  it('ignores other prefixes, unbracketed text and absurd numbers', () => {
    expect(extractTicketKeys('OPS-1 [XYZ-2] [OPS-] [OPS-12345678901]', 'OPS')).toEqual([]);
  });

  it('rejects a prefix that could change the pattern', () => {
    expect(() => extractTicketKeys('x', 'O.*')).toThrow();
    expect(() => extractTicketKeys('x', '')).toThrow();
  });
});

describe('buildThreadKeys (R-2.3)', () => {
  const { email } = normalizeMime(loadFixture('reply-in-thread.eml'));

  it('orders candidates: Gmail threadId, In-Reply-To, References newest first, subject token', () => {
    const keys = buildThreadKeys({ email, gmailThreadId: 't000001', ticketKeyPrefix: 'OPS' });
    expect(keys.candidates).toEqual([
      { kind: 'gmail_thread_id', value: 't000001' },
      { kind: 'in_reply_to', value: 'wt.delivery1@example.com' },
      { kind: 'references', value: 'wt.delivery1@example.com' },
      { kind: 'references', value: 'caf1234abcd@mail.customer.example.com' },
      { kind: 'subject_token', value: 'OPS-1234' },
    ]);
    // The same id as In-Reply-To appears once per kind, never twice for the same kind.
    expect(keys.candidates.filter((c) => c.kind === 'references')).toHaveLength(2);
  });

  it('stores the Gmail thread as the thread key when known', () => {
    expect(buildThreadKeys({ email, gmailThreadId: 't000001' }).threadKey).toBe('gmail:t000001');
  });

  it('falls back to the root of the reference chain, then to the message itself', () => {
    expect(buildThreadKeys({ email }).threadKey).toBe(
      'msgid:caf1234abcd@mail.customer.example.com',
    );
    const first = normalizeMime(loadFixture('plain-ascii.eml')).email;
    expect(buildThreadKeys({ email: first }).threadKey).toBe(
      'msgid:caf1234abcd@mail.customer.example.com',
    );
  });

  it('exposes the normalised Message-ID as the R-2.2 dedupe key', () => {
    expect(buildThreadKeys({ email }).messageIdKey).toBe('caf5678efgh@mail.customer.example.com');
  });

  it('skips subject matching without a prefix and handles messages with no ids at all', () => {
    expect(buildThreadKeys({ email }).candidates.some((c) => c.kind === 'subject_token')).toBe(
      false,
    );
    const bare = buildThreadKeys({
      email: { messageId: null, inReplyTo: null, references: [], subject: 'hi' },
    });
    expect(bare).toEqual({ candidates: [], threadKey: null, messageIdKey: null });
  });
});
