import { describe, expect, it } from 'vitest';

import type { TicketRow } from '../rows.js';
import { joinability, normalizeSubject } from './match.js';

describe('normalizeSubject', () => {
  it.each([
    ['Cannot sign in', 'cannot sign in'],
    ['Re: Cannot sign in', 'cannot sign in'],
    ['RE: Re: FW: Cannot   sign in ', 'cannot sign in'],
    ['Fwd: [OPS-12] Cannot sign in', 'cannot sign in'],
    ['ตอบกลับ: ปัญหา รายงานไม่ขึ้น', 'ปัญหา รายงานไม่ขึ้น'],
    ['ส่งต่อ: Re: ปัญหา   รายงานไม่ขึ้น', 'ปัญหา รายงานไม่ขึ้น'],
    ['Ｒｅ： Ｃannot sign in', 'cannot sign in'],
  ])('%j -> %j', (subject, expected) => {
    expect(normalizeSubject(subject)).toBe(expected);
  });

  it('keeps words that only look like a prefix', () => {
    expect(normalizeSubject('Reset my password')).toBe('reset my password');
    expect(normalizeSubject('Reference number missing')).toBe('reference number missing');
  });

  it('leaves nothing for an empty or prefix-only subject', () => {
    expect(normalizeSubject('')).toBe('');
    expect(normalizeSubject('Re: ')).toBe('');
  });
});

const NOW = new Date('2026-11-10T00:00:00Z');
const ticket = (patch: Partial<TicketRow>): TicketRow =>
  ({ status: 'open', resolvedAt: null, ...patch }) as TicketRow;

describe('joinability', () => {
  it('joins every open status', () => {
    for (const status of ['new', 'triage', 'open', 'waiting_on_customer', 'waiting_on_dev']) {
      expect(joinability(ticket({ status }), 'gmail_thread_id', NOW, 7)).toBe('join');
    }
  });

  it('reopens a resolved ticket only inside the window', () => {
    const day = 24 * 3600 * 1000;
    expect(
      joinability(
        ticket({ status: 'resolved', resolvedAt: new Date(NOW.getTime() - 7 * day) }),
        'in_reply_to',
        NOW,
        7,
      ),
    ).toBe('join');
    expect(
      joinability(
        ticket({ status: 'resolved', resolvedAt: new Date(NOW.getTime() - 7 * day - 1) }),
        'in_reply_to',
        NOW,
        7,
      ),
    ).toBe('too_old');
    expect(
      joinability(ticket({ status: 'resolved', resolvedAt: null }), 'in_reply_to', NOW, 7),
    ).toBe('too_old');
  });

  it('never joins a closed ticket', () => {
    expect(joinability(ticket({ status: 'closed' }), 'gmail_thread_id', NOW, 7)).toBe('closed');
  });

  it('does not reopen a resolved ticket for a chat message (no thread to prove it is the same issue)', () => {
    expect(
      joinability(ticket({ status: 'resolved', resolvedAt: NOW }), 'line_conversation', NOW, 7),
    ).toBe('too_old');
  });
});
