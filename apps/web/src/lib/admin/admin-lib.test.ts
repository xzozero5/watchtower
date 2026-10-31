import { describe, expect, it } from 'vitest';

import { getMessages, translate } from '@/i18n';
import { ApiRequestError } from '@/lib/api/errors';
import { DEFAULT_FILTERS, filtersFromSearch, queueHref } from '@/lib/tickets/filters';
import { uuid } from '@/test/fixtures';

import {
  autonomyHistorySchema,
  autonomyViewSchema,
  calendarViewSchema,
  statCount,
  ticketStatsSchema,
} from './contracts';
import { describeError } from './errors';
import { adminSectionsFor, canFlipSwitches, HOME_PERMISSION } from './sections';
import { asStage } from './stages';

const AT = '2026-11-02T03:00:00.000Z';
const holds =
  (...permissions: string[]) =>
  (permission: string) =>
    permissions.includes(permission);

describe('contracts assumed for the api tasks', () => {
  it('reads the counts endpoint and treats a missing status as zero', () => {
    const stats = ticketStatsSchema.parse({
      byStatus: { open: 3 },
      byQueue: [{ queueId: null, name: null, n: 1 }],
      byAssignee: [{ userId: null, name: null, n: 1 }],
      byPriority: { P1: 1 },
      bySlaState: { ok: 1, at_risk: 2, breached: 3, paused: 4 },
    });
    expect(statCount(stats.byStatus, 'open')).toBe(3);
    expect(statCount(stats.byStatus, 'new')).toBe(0);
  });

  it('rejects counts that are not the agreed shape', () => {
    expect(ticketStatsSchema.safeParse({ byStatus: { open: 'many' } }).success).toBe(false);
  });

  it('accepts the autonomy state with and without the name of who flipped a switch', () => {
    const base = {
      stageCeiling: 2,
      intents: [],
      switches: [{ key: 'ai_kill_switch', on: true, reason: 'x', changedBy: null, changedAt: AT }],
    };
    expect(autonomyViewSchema.parse(base).switches[0]?.changedByName).toBeUndefined();
    const named = autonomyViewSchema.parse({
      ...base,
      switches: [{ ...base.switches[0], changedByName: 'Mana K.' }],
    });
    expect(named.switches[0]?.changedByName).toBe('Mana K.');
  });

  it('refuses a stage above 2 in the autonomy state (N3)', () => {
    const intent = {
      id: uuid(1),
      key: 'k',
      name: 'n',
      isActive: true,
      stage: 3,
      effectiveStage: 3,
      pinned: false,
      updatedAt: AT,
    };
    expect(
      autonomyViewSchema.safeParse({ stageCeiling: 2, switches: [], intents: [intent] }).success,
    ).toBe(false);
  });

  it('accepts a holiday with or without a check state', () => {
    const calendar = {
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
    };
    const parsed = calendarViewSchema.parse({
      ...calendar,
      holidays: [
        { date: '2026-12-31', name: 'a' },
        { date: '2027-01-01', name: 'b', checked: true },
      ],
    });
    expect(parsed.holidays.map((h) => h.checked)).toEqual([undefined, true]);
  });

  it('reads the intent history', () => {
    const parsed = autonomyHistorySchema.parse({
      entries: [
        {
          id: '1',
          change: 'stage',
          fromStage: 1,
          toStage: 2,
          reason: 'r',
          changedBy: null,
          changedAt: AT,
        },
      ],
    });
    expect(parsed.entries[0]?.toStage).toBe(2);
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
