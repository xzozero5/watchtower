import { describe, expect, it } from 'vitest';

import { getMessages, translate } from '@/i18n';
import { ApiRequestError } from '@/lib/api/errors';
import { DEFAULT_FILTERS, filtersFromSearch, queueHref } from '@/lib/tickets/filters';
import { uuid } from '@/test/fixtures';

import {
  autonomyHistoryPageSchema,
  autonomyStateSchema,
  businessCalendarSchema,
  ticketStatsSchema,
} from '@watchtower/shared';

import { openInStatus } from './contracts';
import { describeError } from './errors';
import { adminSectionsFor, canFlipSwitches, HOME_PERMISSION } from './sections';
import { asStage } from './stages';

const AT = '2026-11-02T03:00:00.000Z';
const holds =
  (...permissions: string[]) =>
  (permission: string) =>
    permissions.includes(permission);

describe('contracts from @watchtower/shared', () => {
  const bucket = { count: 3, open: 3, sla: { ok: 1, at_risk: 2, breached: 0, paused: 0 } };

  it('reads the counts endpoint, and a status with no ticket counts as zero open', () => {
    const stats = ticketStatsSchema.parse({
      generatedAt: AT,
      total: bucket,
      byStatus: [{ status: 'open', ...bucket }],
      byQueue: [{ queueId: null, ...bucket }],
      byAssignee: [{ assigneeId: null, ...bucket }],
      byPriority: [{ priority: 'P1', ...bucket }],
    });
    expect(openInStatus(stats, 'open')).toBe(3);
    expect(openInStatus(stats, 'new')).toBe(0);
  });

  it('reads stage 3 (reached only by a promotion, ADR-025) and refuses a stage above it (N3)', () => {
    const intent = {
      id: uuid(1),
      key: 'k',
      name: 'n',
      isActive: true,
      stage: 3,
      effectiveStage: 2,
      pinned: false,
      updatedAt: AT,
    };
    const read = (over: object) =>
      autonomyStateSchema.safeParse({
        stageCeiling: 2,
        switches: [],
        intents: [{ ...intent, ...over }],
      }).success;
    expect(read({})).toBe(true);
    expect(read({ stage: 4, effectiveStage: 4 })).toBe(false);
    // The ceiling of a hand-set stage stays 2.
    expect(
      autonomyStateSchema.safeParse({ stageCeiling: 3, switches: [], intents: [] }).success,
    ).toBe(false);
  });

  it('reads who flipped a switch, and a holiday that nobody checked', () => {
    const state = autonomyStateSchema.parse({
      stageCeiling: 2,
      intents: [],
      switches: [
        {
          key: 'ai_kill_switch',
          on: true,
          reason: 'x',
          changedBy: null,
          changedByName: 'Mana',
          changedAt: AT,
        },
      ],
    });
    expect(state.switches[0]?.changedByName).toBe('Mana');
    const calendar = businessCalendarSchema.parse({
      id: uuid(2),
      name: 'c',
      timezone: 'Asia/Bangkok',
      hours: {
        sun: [],
        mon: [{ start: '09:00', end: '18:00' }],
        tue: [],
        wed: [],
        thu: [],
        fri: [],
        sat: [],
      },
      isDefault: false,
      createdAt: AT,
      updatedAt: AT,
      holidays: [{ date: '2026-12-31', name: 'a' }],
    });
    expect(calendar.holidays[0]).toMatchObject({ checked: false, checkedAt: null });
  });

  it('reads the intent history page', () => {
    const parsed = autonomyHistoryPageSchema.parse({
      items: [
        {
          id: uuid(3),
          intentId: uuid(4),
          change: 'stage',
          fromStage: 1,
          toStage: 2,
          pinned: false,
          reason: 'r',
          changedBy: uuid(5),
          changedByName: 'Mana',
          changedAt: AT,
        },
      ],
      nextCursor: null,
    });
    expect(parsed.items[0]?.toStage).toBe(2);
  });
});

describe('admin sections', () => {
  it('shows each role only what its permissions open', () => {
    const lead = holds(
      'user.read',
      'org.manage',
      'intent.manage',
      'queue.manage',
      'ai.autonomy.set',
    );
    expect(adminSectionsFor(lead).map((s) => s.id)).toEqual([
      'users',
      'orgs',
      'intents',
      'queues',
      'ai',
    ]);
    expect(adminSectionsFor(holds('ticket.read'))).toEqual([]);
  });

  it('lets only someone with both permissions flip the switches', () => {
    expect(canFlipSwitches(holds('ai.emergency_switch', 'ai.autonomy.set.any'))).toBe(true);
    expect(canFlipSwitches(holds('ai.emergency_switch'))).toBe(false);
    expect(canFlipSwitches(holds('ai.autonomy.set.any'))).toBe(false);
    expect(HOME_PERMISSION).toBe('user.read');
  });

  it('shows no stage above 2, whatever number arrives', () => {
    expect([0, 1, 2, 3, 4].map(asStage)).toEqual([0, 1, 2, 2, 2]);
  });
});

describe('describeError', () => {
  const t = (key: string) => translate(getMessages('en'), key as never);
  it('explains a 403, shows the api’s sentence for a 409 and a 400, and is generic otherwise', () => {
    expect(describeError(new ApiRequestError(403, 'forbidden', 'x'), t).message).toBe(
      'You do not have permission to do this.',
    );
    const conflict = describeError(new ApiRequestError(409, 'conflict', 'The intent is pinned'), t);
    expect(conflict).toMatchObject({
      kind: 'conflict',
      message: 'The intent is pinned',
      fromApi: true,
    });
    expect(
      describeError(new ApiRequestError(400, 'validation_failed', 'reason too short'), t).kind,
    ).toBe('invalid');
    expect(describeError(new ApiRequestError(0, 'network', 'x'), t).message).toBe(
      'The server could not be reached.',
    );
    expect(describeError(new Error('boom'), t).message).toBe('Something went wrong.');
  });
});

describe('links from Home into the queue', () => {
  it('builds addresses the queue understands, and reads them back', () => {
    const href = queueHref({
      status: ['new', 'triage'],
      assignee: 'unassigned',
      overdue: true,
      sort: 'due_asc',
    });
    expect(href).toBe('/?status=new%2Ctriage&assignee=unassigned&overdue=true&sort=due_asc');
    expect(filtersFromSearch(href.slice(1))).toMatchObject({
      status: ['new', 'triage'],
      assignee: 'unassigned',
      overdue: true,
      sort: 'due_asc',
    });
    expect(queueHref({})).toBe('/');
  });

  it('carries a queue and a person', () => {
    const queueId = uuid(800);
    const person = uuid(910);
    const read = filtersFromSearch(queueHref({ queueId, assignee: person }).slice(1));
    expect(read).toMatchObject({ queueId, assigneeId: person, assignee: 'any' });
  });

  it('keeps the default view when the address names no filter, and drops what it cannot trust', () => {
    expect(filtersFromSearch('')).toBeNull();
    expect(filtersFromSearch('ticket=OPS-1')).toBeNull();
    const dirty = filtersFromSearch(
      'status=bogus&sort=sideways&queueId=nope&assignee=%3Cscript%3E',
    );
    expect(dirty).toMatchObject({ status: [], sort: DEFAULT_FILTERS.sort, assignee: 'any' });
    expect(dirty?.queueId).toBeUndefined();
  });
});
