import { describe, expect, it } from 'vitest';

import { OUTBOX_AGE_CRITICAL_SECONDS, OUTBOX_AGE_WARNING_SECONDS, outboxHealthStatus } from './ops.js';
import { TICKET_SORTS } from './ticketing.js';
import {
  BULK_MAX_TICKETS,
  SYSTEM_VIEWS,
  SYSTEM_VIEW_KEYS,
  bulkRequestSchema,
  createSavedViewSchema,
  createTicketLinkSchema,
  savedViewFiltersSchema,
} from './views.js';

const ID = '3f0c1f4e-8f86-4c0e-9d52-0a1c7a9a3b11';

describe('built-in views', () => {
  it('have filters the list understands and a known sort', () => {
    for (const key of SYSTEM_VIEW_KEYS) {
      const view = SYSTEM_VIEWS[key];
      expect(savedViewFiltersSchema.safeParse(view.filters).success, key).toBe(true);
      expect(TICKET_SORTS).toContain(view.sort);
      expect(view.name.length).toBeGreaterThan(0);
    }
  });

  it('keep SLA at risk to the SLA states and in the running-target order', () => {
    expect(SYSTEM_VIEWS.sla_at_risk).toMatchObject({
      filters: { slaState: ['at_risk', 'breached'] },
      sort: 'sla_due_asc',
    });
  });
});

describe('saved view bodies', () => {
  it('refuse unknown filters, an empty filter list and a short search', () => {
    expect(savedViewFiltersSchema.safeParse({ colour: 'red' }).success).toBe(false);
    expect(savedViewFiltersSchema.safeParse({ status: [] }).success).toBe(false);
    expect(savedViewFiltersSchema.safeParse({ q: 'a' }).success).toBe(false);
    expect(savedViewFiltersSchema.safeParse({ assignee: 'me', overdue: true }).success).toBe(true);
  });

  it('default to personal and the SLA order', () => {
    expect(createSavedViewSchema.parse({ name: ' Mine ', filters: {} })).toEqual({
      name: 'Mine',
      filters: {},
      sort: 'sla_due_asc',
      shared: false,
    });
  });
});

describe('bulk requests', () => {
  const ok = { type: 'priority', priority: 'P2' };

  it('take up to 100 distinct ticket ids', () => {
    expect(bulkRequestSchema.safeParse({ ticketIds: [ID], action: ok }).success).toBe(true);
    expect(bulkRequestSchema.safeParse({ ticketIds: [], action: ok }).success).toBe(false);
    expect(bulkRequestSchema.safeParse({ ticketIds: [ID, ID], action: ok }).success).toBe(false);
    const many = Array.from({ length: BULK_MAX_TICKETS + 1 }, (_, index) =>
      `3f0c1f4e-8f86-4c0e-9d52-${String(index).padStart(12, '0')}`,
    );
    expect(bulkRequestSchema.safeParse({ ticketIds: many, action: ok }).success).toBe(false);
  });

  it('have exactly four actions and none that sends anything to a customer', () => {
    for (const action of [
      { type: 'assign', assigneeId: null },
      { type: 'assign', assigneeId: ID },
      { type: 'status', status: 'resolved' },
      { type: 'priority', priority: 'P1' },
      { type: 'merge', intoTicketId: 'OPS-12' },
    ]) {
      expect(bulkRequestSchema.safeParse({ ticketIds: [ID], action }).success, action.type).toBe(true);
    }
    for (const action of [
      { type: 'reply', body: 'Hello' },
      { type: 'note', body: 'Hello' },
      { type: 'status', status: 'merged' },
      { type: 'assign' },
    ]) {
      expect(bulkRequestSchema.safeParse({ ticketIds: [ID], action }).success, action.type).toBe(false);
    }
  });
});

describe('ticket links', () => {
  it('take a kind and the other ticket by id or number', () => {
    expect(createTicketLinkSchema.safeParse({ kind: 'duplicate', ticketId: ID }).success).toBe(true);
    expect(createTicketLinkSchema.safeParse({ kind: 'related', ticketId: 'OPS-7' }).success).toBe(true);
    expect(createTicketLinkSchema.safeParse({ kind: 'blocks', ticketId: ID }).success).toBe(false);
    expect(createTicketLinkSchema.safeParse({ kind: 'related', ticketId: 'x' }).success).toBe(false);
  });
});

describe('outbox health', () => {
  it('is ok under two minutes, a warning from two, critical from ten', () => {
    expect(outboxHealthStatus(0)).toBe('ok');
    expect(outboxHealthStatus(OUTBOX_AGE_WARNING_SECONDS - 1)).toBe('ok');
    expect(outboxHealthStatus(OUTBOX_AGE_WARNING_SECONDS)).toBe('warning');
    expect(outboxHealthStatus(OUTBOX_AGE_CRITICAL_SECONDS - 1)).toBe('warning');
    expect(outboxHealthStatus(OUTBOX_AGE_CRITICAL_SECONDS)).toBe('critical');
  });
});
