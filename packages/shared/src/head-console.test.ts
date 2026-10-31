import { describe, expect, it } from 'vitest';

import {
  AUDIT_EXPORT_COLUMNS,
  AUDIT_EXPORT_MAX_ROWS,
  auditLogExportQuerySchema,
  auditLogQuerySchema,
} from './auth.js';
import { autonomyHistoryQuerySchema, aiSwitchSchema } from './features/autonomy.js';
import {
  TICKET_SORTS,
  ticketListQuerySchema,
  ticketStatsQuerySchema,
  ticketStatsSchema,
} from './ticketing.js';

// T-127: the contracts the head console reads.

describe('ticket list and stats query', () => {
  it('accepts the new sorts and a list of SLA states', () => {
    expect(TICKET_SORTS).toEqual(
      expect.arrayContaining(['created_asc', 'sla_due_asc', 'due_asc', 'created_desc']),
    );
    const query = ticketListQuerySchema.parse({
      sort: 'sla_due_asc',
      slaState: 'at_risk,breached',
    });
    expect(query.sort).toBe('sla_due_asc');
    expect(query.slaState).toEqual(['at_risk', 'breached']);
    expect(ticketListQuerySchema.safeParse({ slaState: 'late' }).success).toBe(false);
  });

  it('gives the stats the list filters but no paging or sort', () => {
    const query = ticketStatsQuerySchema.parse({
      status: 'new,open',
      assignee: 'unassigned',
      slaState: ['ok'],
      sort: 'created_asc',
      limit: '5',
      cursor: 'abc',
    });
    expect(query).toEqual({ status: ['new', 'open'], assignee: 'unassigned', slaState: ['ok'] });
  });

  it('describes the answer: totals and four groupings, each with SLA counts', () => {
    const bucket = { count: 1, open: 1, sla: { ok: 1, at_risk: 0, breached: 0, paused: 0 } };
    expect(
      ticketStatsSchema.safeParse({
        generatedAt: '2026-11-02T03:00:00.000Z',
        total: bucket,
        byStatus: [{ status: 'open', ...bucket }],
        byQueue: [{ queueId: null, ...bucket }],
        byAssignee: [{ assigneeId: null, ...bucket }],
        byPriority: [{ priority: 'P1', ...bucket }],
      }).success,
    ).toBe(true);
    expect(
      ticketStatsSchema.safeParse({
        generatedAt: 'now',
        total: bucket,
        byStatus: [],
        byQueue: [],
        byAssignee: [],
        byPriority: [],
      }).success,
    ).toBe(false);
  });
});

describe('autonomy', () => {
  it('has the name of who flipped a switch, nullable', () => {
    const base = {
      key: 'ai_kill_switch',
      on: true,
      reason: 'x',
      changedBy: null,
      changedAt: '2026-11-02T03:00:00.000Z',
    };
    expect(aiSwitchSchema.safeParse({ ...base, changedByName: null }).success).toBe(true);
    expect(aiSwitchSchema.safeParse({ ...base, changedByName: 'Mana' }).success).toBe(true);
    expect(aiSwitchSchema.safeParse(base).success).toBe(false);
  });

  it('pages the history with a limit between 1 and 200', () => {
    expect(autonomyHistoryQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(autonomyHistoryQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(autonomyHistoryQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  });
});

describe('audit log', () => {
  it('filters by the kind of actor', () => {
    expect(auditLogQuerySchema.parse({ actorType: 'ai' }).actorType).toBe('ai');
    expect(auditLogQuerySchema.safeParse({ actorType: 'robot' }).success).toBe(false);
  });

  it('exports with the list filters, a row cap, and columns that exclude personal fields', () => {
    const query = auditLogExportQuerySchema.parse({ actorType: 'system', limit: '5' });
    expect(query).toEqual({ actorType: 'system', maxRows: AUDIT_EXPORT_MAX_ROWS });
    expect(auditLogExportQuerySchema.safeParse({ maxRows: '0' }).success).toBe(false);
    expect(
      auditLogExportQuerySchema.safeParse({ maxRows: AUDIT_EXPORT_MAX_ROWS + 1 }).success,
    ).toBe(false);
    for (const personal of ['ip', 'before', 'after', 'metadata']) {
      expect(AUDIT_EXPORT_COLUMNS).not.toContain(personal);
    }
  });
});
