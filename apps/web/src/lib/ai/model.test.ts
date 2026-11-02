import { describe, expect, it } from 'vitest';

import type { RowModel } from '@/lib/tickets/model';
import type { SlaView } from '@/lib/tickets/sla';

import {
  changedFraction,
  citedEvidence,
  COLLAPSED_BY_DEFAULT,
  confidenceBand,
  groupRows,
  hasBrief,
  navigableRows,
  safeHref,
  sortBySlaThenPriority,
  triageGroup,
} from './model';
import { makeInsight } from '@/test/ai-fixtures';

const ON_TRACK: SlaView = { state: 'onTrack', target: 'resolution', ms: 3_600_000, dueAt: null };
const AT_RISK: SlaView = { ...ON_TRACK, state: 'atRisk' };

function row(key: string, overrides: Partial<RowModel> = {}): RowModel {
  return {
    id: key,
    key,
    subject: `Subject ${key}`,
    status: 'open',
    priority: 'P3',
    orgName: 'Example Org',
    requesterName: 'Riley Requester',
    requesterId: key,
    channel: 'gmail',
    assigneeName: null,
    unassigned: true,
    intentName: null,
    intentKey: null,
    ai: null,
    updatedAt: '2026-11-02T03:00:00.000Z',
    overdue: false,
    sla: ON_TRACK,
    ...overrides,
  };
}

describe('triageGroup', () => {
  it('puts a ready draft, an AI that is unsure and a failed AI under "Needs you"', () => {
    expect(triageGroup(row('A', { ai: { state: 'draft_ready' } }))).toBe('needsYou');
    expect(triageGroup(row('A', { ai: { state: 'needs_human' } }))).toBe('needsYou');
    expect(triageGroup(row('A', { ai: { state: 'failed' } }))).toBe('needsYou');
  });

  it('puts a ticket the AI has not touched, or has no AI data at all, under "Needs you"', () => {
    expect(triageGroup(row('A'))).toBe('needsYou');
    expect(triageGroup(row('A', { ai: { state: 'none' } }))).toBe('needsYou');
  });

  it('puts only tickets the AI is still investigating under "AI working"', () => {
    expect(triageGroup(row('A', { ai: { state: 'investigating' } }))).toBe('aiWorking');
  });

  it('puts a classified ticket under "Needs you": nothing else works on it until the investigator (T-108)', () => {
    expect(triageGroup(row('A', { ai: { state: 'classified' } }))).toBe('needsYou');
  });

  it('moves an AI-working ticket to "Needs you" when its SLA is at risk or breached', () => {
    expect(triageGroup(row('A', { ai: { state: 'investigating' }, sla: AT_RISK }))).toBe(
      'needsYou',
    );
    expect(
      triageGroup(
        row('A', { ai: { state: 'classified' }, sla: { ...AT_RISK, state: 'breached' } }),
      ),
    ).toBe('needsYou');
  });

  it('puts tickets waiting on the customer or on dev under "Waiting", whatever the AI did', () => {
    expect(triageGroup(row('A', { status: 'waiting_on_customer' }))).toBe('waiting');
    expect(triageGroup(row('A', { status: 'waiting_on_dev', ai: { state: 'draft_ready' } }))).toBe(
      'waiting',
    );
  });

  it('puts finished tickets under "Done"', () => {
    for (const status of ['resolved', 'closed', 'merged'] as const) {
      expect(triageGroup(row('A', { status }))).toBe('done');
    }
  });
});

describe('groupRows', () => {
  it('returns only the sections that have rows, in board order, keeping the api order inside', () => {
    const groups = groupRows([
      row('OPS-1', { status: 'waiting_on_customer' }),
      row('OPS-2', { ai: { state: 'investigating' } }),
      row('OPS-3', { ai: { state: 'draft_ready' } }),
      row('OPS-4'),
    ]);
    expect(groups.map((group) => [group.id, group.rows.map((r) => r.key)])).toEqual([
      ['needsYou', ['OPS-3', 'OPS-4']],
      ['aiWorking', ['OPS-2']],
      ['waiting', ['OPS-1']],
    ]);
  });

  it('returns nothing for an empty list', () => {
    expect(groupRows([])).toEqual([]);
  });
});

describe('navigableRows', () => {
  const groups = groupRows([
    row('OPS-1', { ai: { state: 'draft_ready' } }),
    row('OPS-2', { ai: { state: 'investigating' } }),
    row('OPS-3', { status: 'resolved' }),
  ]);

  it('lists rows top to bottom as drawn, and skips a folded section', () => {
    expect(navigableRows(groups, new Set(), null).map((r) => r.key)).toEqual([
      'OPS-1',
      'OPS-2',
      'OPS-3',
    ]);
    expect(navigableRows(groups, new Set(['aiWorking']), null).map((r) => r.key)).toEqual([
      'OPS-1',
      'OPS-3',
    ]);
  });

  it('keeps the open ticket even when its section is folded', () => {
    expect(navigableRows(groups, new Set(['aiWorking']), 'OPS-2').map((r) => r.key)).toEqual([
      'OPS-1',
      'OPS-2',
      'OPS-3',
    ]);
  });

  it('starts with the Done section folded', () => {
    expect(COLLAPSED_BY_DEFAULT.has('done')).toBe(true);
    expect(COLLAPSED_BY_DEFAULT.has('needsYou')).toBe(false);
  });
});

describe('confidenceBand', () => {
  it.each([
    [0.9, 'high'],
    [0.75, 'high'],
    [0.74, 'medium'],
    [0.4, 'medium'],
    [0.39, 'low'],
    [0, 'low'],
  ] as const)('reads %s as %s', (value, band) => {
    expect(confidenceBand(value)).toBe(band);
  });
});

describe('changedFraction', () => {
  it('is 0 for the same text and 1 for a different one', () => {
    expect(changedFraction('a b c', 'a b c')).toBe(0);
    expect(changedFraction('a b c', 'x y z')).toBe(1);
  });

  it('counts the words that survive in order', () => {
    expect(changedFraction('one two three four', 'one two three five')).toBeCloseTo(0.25);
    expect(changedFraction('one two three four', 'one two')).toBeCloseTo(0.5);
  });

  it('ignores whitespace differences and handles empty text', () => {
    expect(changedFraction('a  b\nc', 'a b c')).toBe(0);
    expect(changedFraction('', '')).toBe(0);
    expect(changedFraction('a', '')).toBe(1);
  });
});

describe('safeHref', () => {
  it('lets through paths inside the app and http(s) addresses', () => {
    expect(safeHref('/?ticket=OPS-1')).toBe('/?ticket=OPS-1');
    expect(safeHref('https://docs.example.com/a')).toBe('https://docs.example.com/a');
  });

  it('drops anything else', () => {
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('//evil.example.com')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('not a url')).toBeNull();
  });
});

describe('the brief', () => {
  it('exists for every state but "none" and for no answer at all', () => {
    expect(hasBrief(undefined)).toBe(false);
    expect(hasBrief(makeInsight({ state: 'none' }))).toBe(false);
    expect(hasBrief(makeInsight({ state: 'classified' }))).toBe(true);
  });

  it('lists the evidence a draft cites in citation order', () => {
    const insight = makeInsight();
    expect(citedEvidence(insight).map((entry) => entry.id)).toEqual(['ev-kb-1', 'ev-ticket-1']);
    expect(citedEvidence({ ...insight, draft: undefined })).toEqual([]);
  });
});

describe('Needs you scoping (QA-01) and inclusion (QA-02)', () => {
  const me = { userId: 'me', queueIds: new Set(['q-mine']) };

  it('keeps a ticket assigned to me, or unassigned in my queue, in "Needs you"', () => {
    expect(triageGroup(row('A', { assigneeId: 'me', unassigned: false }), me)).toBe('needsYou');
    expect(triageGroup(row('A', { assigneeId: null, queueId: 'q-mine' }), me)).toBe('needsYou');
    expect(triageGroup(row('A', { assigneeId: null, queueId: null }), me)).toBe('needsYou');
  });

  it('moves a ticket assigned to someone else, or unassigned in another queue, out of "Needs you"', () => {
    expect(triageGroup(row('A', { assigneeId: 'other', unassigned: false }), me)).toBe('waiting');
    expect(triageGroup(row('A', { assigneeId: null, queueId: 'q-other' }), me)).toBe('waiting');
    // Without a scope nothing is filtered (customer lists, the plain rules).
    expect(triageGroup(row('A', { assigneeId: 'other', unassigned: false }))).toBe('needsYou');
  });

  it('lets a re-assigned open ticket leave "Needs you" even if it is pinned there', () => {
    const moved = row('A', { assigneeId: 'other', unassigned: false });
    const groups = groupRows([moved], { key: 'A', group: 'needsYou' }, me);
    expect(groups.map((g) => g.id)).toEqual(['waiting']);
  });

  it('puts every P1 and every breached or at-risk ticket in "Needs you", whatever the AI does', () => {
    const investigating = { ai: { state: 'investigating' as const } };
    expect(triageGroup(row('A', investigating))).toBe('aiWorking');
    expect(triageGroup(row('A', { ...investigating, priority: 'P1' }))).toBe('needsYou');
    expect(triageGroup(row('A', { ...investigating, sla: AT_RISK }))).toBe('needsYou');
    expect(
      triageGroup(row('A', { ...investigating, sla: { ...AT_RISK, state: 'breached' } })),
    ).toBe('needsYou');
    // Finished and waiting tickets stay where they are.
    expect(triageGroup(row('A', { priority: 'P1', status: 'resolved' }))).toBe('done');
    expect(triageGroup(row('A', { priority: 'P1', status: 'waiting_on_customer' }))).toBe(
      'waiting',
    );
  });
});

describe('sorting inside a section (QA-01, QA-02)', () => {
  const at = (iso: string, state: SlaView['state'] = 'onTrack'): SlaView => ({
    state,
    target: 'resolution',
    ms: 0,
    dueAt: iso,
  });

  it('orders breached, then at risk, then priority, then due time, with no SLA last', () => {
    const rows = [
      row('NOSLA', { sla: { ...ON_TRACK, state: 'none', dueAt: null }, priority: 'P2' }),
      row('LATE-P3', { sla: at('2026-11-05T00:00:00Z'), priority: 'P3' }),
      row('SOON-P3', { sla: at('2026-11-03T00:00:00Z'), priority: 'P3' }),
      row('SOON-P2', { sla: at('2026-11-04T00:00:00Z'), priority: 'P2' }),
      row('RISK', { sla: at('2026-11-06T00:00:00Z', 'atRisk'), priority: 'P4' }),
      row('BREACH-P4', { sla: at('2026-11-01T00:00:00Z', 'breached'), priority: 'P4' }),
      row('BREACH-P1', { sla: at('2026-11-02T00:00:00Z', 'breached'), priority: 'P1' }),
    ];
    expect(sortBySlaThenPriority(rows).map((r) => r.key)).toEqual([
      'BREACH-P1',
      'BREACH-P4',
      'RISK',
      'SOON-P2',
      'NOSLA',
      'SOON-P3',
      'LATE-P3',
    ]);
  });

  it('is applied inside every section by groupRows and is stable for equal rows', () => {
    const a = row('A');
    const b = row('B');
    expect(groupRows([a, b])[0]?.rows.map((r) => r.key)).toEqual(['A', 'B']);
    const p1 = row('P1', { priority: 'P1' });
    expect(groupRows([a, p1])[0]?.rows.map((r) => r.key)).toEqual(['P1', 'A']);
  });
});
