import { TICKET_EVENT_TYPES } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { firstName, oneLine } from './portal-notifier.js';
import {
  buildTimeline,
  canCustomerReply,
  type ViewEvent,
  type ViewMessage,
} from './portal-view.js';

let counter = 0;
const id = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 10, minute));

const message = (
  minute: number,
  direction: string,
  bodyText: string,
  staffName: string | null = null,
): ViewMessage => ({
  id: id(),
  direction,
  bodyText,
  createdAt: at(minute),
  staffName,
});
const statusEvent = (minute: number, from: string, to: string): ViewEvent => ({
  id: id(),
  type: TICKET_EVENT_TYPES.statusChanged,
  payload: { from, to, reason: 'internal staff reason', actor: 'x' },
  createdAt: at(minute),
});

describe('buildTimeline', () => {
  it('shows messages and customer status words in order, support by first name only', () => {
    const entries = buildTimeline(
      [message(1, 'inbound', 'It broke'), message(5, 'outbound', 'Looking now', 'Somchai Jaidee')],
      [
        { id: id(), type: TICKET_EVENT_TYPES.created, payload: {}, createdAt: at(0) },
        statusEvent(3, 'new', 'triage'),
        statusEvent(4, 'triage', 'open'),
        statusEvent(9, 'open', 'resolved'),
      ],
    );
    expect(
      entries.map((e) => (e.kind === 'message' ? `${e.from}:${e.authorName ?? 'null'}` : e.status)),
    ).toEqual(['received', 'customer:null', 'in_progress', 'support:Somchai', 'resolved']);
    expect(JSON.stringify(entries)).not.toContain('Jaidee');
    expect(JSON.stringify(entries)).not.toContain('internal staff reason');
  });

  it('keeps opened, message, status in order when they share a millisecond', () => {
    const same = at(5);
    const opened: ViewEvent = {
      id: 'ffffffff-0000-4000-8000-000000000001',
      type: TICKET_EVENT_TYPES.created,
      payload: {},
      createdAt: same,
    };
    const written: ViewMessage = {
      id: '00000000-0000-4000-8000-00000000000a',
      direction: 'inbound',
      bodyText: 'Hello',
      createdAt: same,
      staffName: null,
    };
    const timeline = buildTimeline([written], [opened]);
    expect(timeline.map((entry) => entry.kind)).toEqual(['status', 'message']);
  });

  it('leaves out a change that reads the same to the customer (triage to open)', () => {
    const entries = buildTimeline(
      [],
      [statusEvent(1, 'triage', 'open'), statusEvent(2, 'open', 'waiting_on_dev')],
    );
    expect(entries).toEqual([]);
  });

  it('names the primary ticket on a merge and ignores every other event type', () => {
    const entries = buildTimeline(
      [],
      [
        {
          id: id(),
          type: TICKET_EVENT_TYPES.merged,
          payload: { intoKey: 'OPS-3', reason: 'dup' },
          createdAt: at(1),
        },
        {
          id: id(),
          type: TICKET_EVENT_TYPES.assigned,
          payload: { to: 'someone' },
          createdAt: at(2),
        },
        { id: id(), type: TICKET_EVENT_TYPES.slaPaused, payload: {}, createdAt: at(3) },
        { id: id(), type: 'ai.draft', payload: { text: 'secret' }, createdAt: at(4) },
      ],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'status', status: 'merged', mergedIntoKey: 'OPS-3' });
  });

  it('ignores an event whose payload is not what the api writes', () => {
    expect(
      buildTimeline(
        [],
        [
          {
            id: id(),
            type: TICKET_EVENT_TYPES.statusChanged,
            payload: 'garbage',
            createdAt: at(1),
          },
        ],
      ),
    ).toEqual([]);
  });
});

describe('canCustomerReply', () => {
  const now = new Date('2026-11-10T00:00:00.000Z');
  it('allows open tickets and recently resolved ones only', () => {
    expect(canCustomerReply({ status: 'open', resolvedAt: null }, now)).toBe(true);
    expect(canCustomerReply({ status: 'waiting_on_customer', resolvedAt: null }, now)).toBe(true);
    expect(
      canCustomerReply({ status: 'resolved', resolvedAt: new Date('2026-11-05T00:00:00Z') }, now),
    ).toBe(true);
    expect(
      canCustomerReply({ status: 'resolved', resolvedAt: new Date('2026-10-30T00:00:00Z') }, now),
    ).toBe(false);
    expect(canCustomerReply({ status: 'closed', resolvedAt: null }, now)).toBe(false);
    expect(canCustomerReply({ status: 'merged', resolvedAt: null }, now)).toBe(false);
  });
});

describe('text helpers', () => {
  it('takes the first word of a name', () => {
    expect(firstName('Somchai Jaidee')).toBe('Somchai');
    expect(firstName('  Somchai ')).toBe('Somchai');
    expect(firstName('')).toBeNull();
    expect(firstName(null)).toBeNull();
  });

  it('puts a subject on one line without control characters', () => {
    expect(oneLine('Hello\r\nBcc: evil@example.com\u0000\t  there')).toBe(
      'Hello Bcc: evil@example.com there',
    );
    expect(oneLine('x'.repeat(500), 300)).toHaveLength(300);
  });
});
