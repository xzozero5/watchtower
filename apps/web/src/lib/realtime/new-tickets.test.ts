import { describe, expect, it } from 'vitest';

import { DEFAULT_FILTERS, type QueueFilters } from '@/lib/tickets/filters';

import { countNewMatching, matchesFilters, type NewTicket } from './new-tickets';

const ME = 'user-me';
const QUEUE_A = 'a0000000-0000-4000-8000-000000000700';
const QUEUE_B = 'a0000000-0000-4000-8000-000000000701';

const ticket = (overrides: Partial<NewTicket> = {}): NewTicket => ({
  id: 'a0000000-0000-4000-8000-000000000001',
  orgId: 'a0000000-0000-4000-8000-000000000500',
  queueId: null,
  channel: 'gmail',
  priority: 'P3',
  status: 'new',
  assigneeId: null,
  ...overrides,
});

const filters = (overrides: Partial<QueueFilters> = {}): QueueFilters => ({
  ...DEFAULT_FILTERS,
  ...overrides,
});

describe('matchesFilters', () => {
  it('counts a new ticket for the default open view', () => {
    expect(matchesFilters(ticket(), DEFAULT_FILTERS, ME)).toBe(true);
  });

  it('follows the queue filter', () => {
    const inA = ticket({ queueId: QUEUE_A });
    expect(matchesFilters(inA, filters({ queueId: QUEUE_A }), ME)).toBe(true);
    expect(matchesFilters(inA, filters({ queueId: QUEUE_B }), ME)).toBe(false);
    expect(matchesFilters(ticket(), filters({ queueId: QUEUE_A }), ME)).toBe(false);
  });

  it('follows the assignee filter', () => {
    const mine = ticket({ assigneeId: ME });
    const theirs = ticket({ assigneeId: 'someone-else' });
    expect(matchesFilters(mine, filters({ assignee: 'me' }), ME)).toBe(true);
    expect(matchesFilters(theirs, filters({ assignee: 'me' }), ME)).toBe(false);
    expect(matchesFilters(ticket(), filters({ assignee: 'unassigned' }), ME)).toBe(true);
    expect(matchesFilters(mine, filters({ assignee: 'unassigned' }), ME)).toBe(false);
    expect(matchesFilters(theirs, filters({ assigneeId: 'someone-else' }), ME)).toBe(true);
    expect(matchesFilters(mine, filters({ assigneeId: 'someone-else' }), ME)).toBe(false);
  });

  it('follows the priority and status filters', () => {
    expect(matchesFilters(ticket({ priority: 'P1' }), filters({ priority: ['P1'] }), ME)).toBe(
      true,
    );
    expect(matchesFilters(ticket({ priority: 'P3' }), filters({ priority: ['P1'] }), ME)).toBe(
      false,
    );
    expect(matchesFilters(ticket(), filters({ status: ['open'] }), ME)).toBe(false);
    expect(matchesFilters(ticket(), filters({ status: [] }), ME)).toBe(true);
  });

  it('does not guess what a search or the overdue filter would return', () => {
    expect(matchesFilters(ticket(), filters({ q: 'invoice' }), ME)).toBe(false);
    expect(matchesFilters(ticket(), filters({ overdue: true }), ME)).toBe(false);
    expect(matchesFilters(ticket(), filters({ q: '   ' }), ME)).toBe(true);
  });
});

describe('countNewMatching', () => {
  it('counts per filter, so a queue elsewhere does not light the pill', () => {
    const arrived = [
      ticket({ id: '1', queueId: QUEUE_A }),
      ticket({ id: '2', queueId: QUEUE_B }),
      ticket({ id: '3', queueId: QUEUE_A, channel: 'line' }),
    ];
    expect(countNewMatching(arrived, filters({ queueId: QUEUE_A }), ME)).toBe(2);
    expect(countNewMatching(arrived, filters({ queueId: QUEUE_B }), ME)).toBe(1);
    expect(countNewMatching(arrived, DEFAULT_FILTERS, ME)).toBe(3);
    expect(countNewMatching([], DEFAULT_FILTERS, ME)).toBe(0);
  });
});
