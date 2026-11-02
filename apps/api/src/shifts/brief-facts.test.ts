import type { Handoff, ShiftBrief } from '@watchtower/shared';
import { claimHrefSchema } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { briefFacts, briefHandoffFacts, briefTicketIds } from './brief-facts.js';

const ticket = (
  key: string,
  slaState: 'breached' | 'at_risk' | 'ok' | null,
  minutes: number | null,
) => ({
  id: '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11',
  key,
  subject: `Subject of ${key}`,
  priority: 'P2' as const,
  status: 'open',
  slaState,
  slaMinutesLeft: minutes,
  dueAt: null,
});

function brief(overrides: Partial<ShiftBrief> = {}): ShiftBrief {
  return {
    generatedAt: '2026-11-02T01:00:00.000Z',
    timezone: 'Asia/Bangkok',
    session: null,
    handoff: { handoffs: [], total: 0, acknowledged: 0, leadAlertAt: null },
    incidents: [],
    snoozedAlerts: [],
    deploys: [],
    watchItems: [],
    myTickets: [],
    carriedOver: [],
    notes: [],
    aiSummary: null,
    ...overrides,
  };
}

describe('briefFacts', () => {
  it('has no fact for an empty brief, so there is nothing to summarize and no model call', () => {
    expect(briefFacts(brief(), 'en')).toEqual([]);
  });

  it('puts breached before at risk, links each ticket to the queue page, and skips the healthy ones', () => {
    const facts = briefFacts(
      brief({
        myTickets: [
          ticket('OPS-1', 'breached', 0),
          ticket('OPS-2', 'at_risk', 25),
          ticket('OPS-3', 'ok', 300),
          ticket('OPS-4', null, null),
        ],
      }),
      'en',
    );
    expect(facts.map((fact) => fact.label)).toEqual(['OPS-1', 'OPS-2', 'My tickets']);
    expect(facts[0]?.href).toBe('/?ticket=OPS-1');
    expect(facts[0]?.text).toContain('breached');
    expect(facts[1]?.text).toContain('25 minutes left');
    expect(facts.at(-1)?.text).toBe('You hold 4 open tickets.');
  });

  it('writes the facts in the language of the screen', () => {
    const facts = briefFacts(
      brief({
        myTickets: [ticket('OPS-1', 'breached', 0)],
        notes: [
          {
            id: '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11',
            audience: 'user',
            author: { id: '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a12', name: 'A' },
            toUser: null,
            deliverAt: null,
            body: 'x',
            createdAt: '2026-11-02T00:00:00.000Z',
            readAt: null,
          } as never,
        ],
      }),
      'th',
    );
    expect(facts[0]?.text).toContain('เกิน SLA แล้ว');
    expect(facts.find((fact) => fact.kind === 'note')?.text).toContain('ยังไม่ได้อ่าน');
    expect(facts[0]?.text).not.toMatch(/\bis breached\b/);
  });

  it('only links to pages that exist: a ticket, the handoff, the notes, the brief', () => {
    const facts = briefFacts(
      brief({
        myTickets: [ticket('OPS-1', 'breached', 0)],
        carriedOver: [{ ...ticket('OPS-1', 'breached', 0), crossedShifts: 2 }],
        handoff: { handoffs: [], total: 3, acknowledged: 1, leadAlertAt: null },
        incidents: [
          {
            id: '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11',
            kind: 'incident',
            ticket: null,
            title: 'Checkout is slow',
            nextAction: 'Watch the error rate',
          } as never,
        ],
      }),
      'en',
    );
    expect(facts.length).toBeGreaterThanOrEqual(4);
    for (const fact of facts) {
      expect(fact.href, fact.label).toBeDefined();
      expect(claimHrefSchema.safeParse(fact.href).success, fact.label).toBe(true);
      expect(['/?ticket=OPS-1', '/shift/handoff', '/shift/notes', '/shift/brief']).toContain(
        fact.href,
      );
    }
    expect(facts.find((fact) => fact.kind === 'incident')?.text).toContain('Checkout is slow');
    expect(facts.find((fact) => fact.kind === 'handoff')?.text).toContain('1 of 3');
  });
});

describe('briefHandoffFacts', () => {
  it('turns the items of the open handoff into facts with the carried-over count', () => {
    const handoff = {
      items: [
        {
          id: '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11',
          kind: 'pending',
          ticket: {
            id: '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a12',
            key: 'OPS-9',
            subject: 'Cannot export',
            priority: 'P1',
            status: 'open',
            assignee: null,
            slaState: 'at_risk',
          },
          title: 'OPS-9 Cannot export',
          nextAction: 'Ask for the file',
          carriedShifts: 2,
        },
      ],
    } as unknown as Handoff;
    const [fact] = briefHandoffFacts(handoff, 'en');
    expect(fact?.href).toBe('/?ticket=OPS-9');
    expect(fact?.text).toContain('at risk');
    expect(fact?.text).toContain('Carried over 2 shift(s)');
  });
});

describe('the people of the customers (N4)', () => {
  it('rides on every fact as the dictionary of the redactor', () => {
    const facts = briefFacts(brief({ myTickets: [ticket('OPS-1', 'breached', 0)] }), 'en', {
      names: ['Somchai Customer'],
      complete: true,
    });
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) expect(fact.names).toEqual(['Somchai Customer']);
  });

  it('makes no facts, so no summary and no model call, when the list of people was cut short', () => {
    const people = { names: ['A'], complete: false };
    expect(
      briefFacts(brief({ myTickets: [ticket('OPS-1', 'breached', 0)] }), 'en', people),
    ).toEqual([]);
    expect(
      briefHandoffFacts(
        {
          items: [
            { id: 'x', kind: 'note', ticket: null, title: 'T', nextAction: null, carriedShifts: 0 },
          ],
        } as never,
        'en',
        people,
      ),
    ).toEqual([]);
  });
});

describe('briefTicketIds', () => {
  it('names every ticket the brief mentions, whoever holds it, so every organization is in the dictionary', () => {
    const mine = ticket('OPS-1', 'breached', 0);
    const incoming = {
      handoffs: [{ items: [{ ticket: { id: 'ticket-of-a-colleague' } }, { ticket: null }] }],
      total: 1,
      acknowledged: 0,
      leadAlertAt: null,
    };
    const ids = briefTicketIds(
      brief({
        myTickets: [mine],
        carriedOver: [{ ...mine, id: 'carried', crossedShifts: 1 }],
        handoff: incoming as never,
        incidents: [{ ticket: { id: 'ticket-of-an-incident' } } as never],
      }),
    );
    expect(new Set(ids)).toEqual(
      new Set([mine.id, 'carried', 'ticket-of-a-colleague', 'ticket-of-an-incident']),
    );
  });
});
