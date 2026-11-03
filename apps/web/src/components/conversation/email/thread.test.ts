import { describe, expect, it } from 'vitest';

import { makeMessage, makeTicket } from '@/test/fixtures';

import { defaultExpandedIds, replyDefaults, replySubject, threadSubject } from './thread';

const ticket = makeTicket(1);
const mail = (n: number, extra: Parameters<typeof makeMessage>[2] = {}) =>
  makeMessage(n, ticket, { channel: 'gmail', ...extra });

describe('defaultExpandedIds', () => {
  it('opens the newest mail and anything waiting or failed, not the rest', () => {
    const a = mail(1);
    const b = mail(2, { direction: 'outbound', deliveryStatus: 'failed' });
    const c = mail(3);
    const note = mail(4, { visibility: 'internal' });
    expect([...defaultExpandedIds([a, b, c, note])].sort()).toEqual([b.id, c.id].sort());
  });

  it('ignores non-email messages', () => {
    expect(defaultExpandedIds([makeMessage(1, ticket)]).size).toBe(0);
  });
});

describe('thread subject and reply defaults', () => {
  const customer = mail(1, {
    emailMeta: {
      from: { address: 'sam@example.org', name: 'Sam' },
      to: [{ address: 'help@example.com' }, { address: 'ann@example.org', name: 'Ann' }],
      cc: [{ address: 'me@example.com' }],
      bcc: [],
      subject: 'Printer is down',
    },
  });

  it('uses the first subject and never doubles Re:', () => {
    expect(threadSubject([customer])).toBe('Printer is down');
    expect(replySubject('Re: Printer is down')).toBe('Re: Printer is down');
    expect(replySubject('Printer is down')).toBe('Re: Printer is down');
  });

  it('replies to the last customer mail and offers the others for reply-all, minus the writer', () => {
    const out = replyDefaults([customer], {
      requester: { address: 'other@example.org' },
      self: 'ME@example.com',
      ticketSubject: 'fallback',
    });
    expect(out.to.map((a) => a.address)).toEqual(['sam@example.org']);
    expect(out.others.map((a) => a.address)).toEqual(['help@example.com', 'ann@example.org']);
    expect(out.subject).toBe('Re: Printer is down');
    expect(out.quoted?.id).toBe(customer.id);
  });

  it('falls back to the requester and the ticket subject', () => {
    const out = replyDefaults([], {
      requester: { address: 'r@example.org', name: 'R' },
      self: null,
      ticketSubject: 'Hello',
    });
    expect(out.to).toEqual([{ address: 'r@example.org', name: 'R' }]);
    expect(out.subject).toBe('Re: Hello');
    expect(out.quoted).toBeNull();
  });
});
