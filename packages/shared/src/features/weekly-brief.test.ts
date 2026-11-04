import { describe, expect, it } from 'vitest';

import { emailJobSchema, splitEmailSecrets } from '../queues.js';
import type { Claim } from './claims.js';
import {
  evidenceOutsideDraft,
  humanClaim,
  parseWeeklyBriefTime,
  weeklyBriefContentSchema,
  weeklyBriefEmailParts,
  weeklyBriefPublishBodySchema,
  type WeeklyBriefContent,
} from './weekly-brief.js';

const ticket = { kind: 'ticket', label: 'OPS-12', href: '/?ticket=OPS-12' } as const;
const metric = { kind: 'data', label: 'SLA', href: '/dashboard/ceo' } as const;
const cited = (text: string, ...evidence: Claim['evidence']): Claim => ({
  text,
  evidence,
  uncited: evidence.length === 0,
});

const DRAFT: WeeklyBriefContent = {
  summary: [cited('SLA fell.', metric)],
  rootCauses: [{ title: 'Sign-in', claims: [cited('Nine tickets.', ticket)], ask: null }],
  decisions: [],
};

describe('weekly brief content', () => {
  it('accepts claims whose uncited flag agrees with their evidence and refuses those that do not', () => {
    expect(weeklyBriefContentSchema.safeParse(DRAFT).success).toBe(true);
    const lying = { ...DRAFT, summary: [{ text: 'x', evidence: [], uncited: false }] };
    expect(weeklyBriefContentSchema.safeParse(lying).success).toBe(false);
  });

  it('allows at most five root causes, one to three claims each', () => {
    const cause = DRAFT.rootCauses[0];
    expect(
      weeklyBriefContentSchema.safeParse({ ...DRAFT, rootCauses: Array(6).fill(cause) }).success,
    ).toBe(false);
    expect(
      weeklyBriefContentSchema.safeParse({
        ...DRAFT,
        rootCauses: [{ title: 'T', claims: [], ask: null }],
      }).success,
    ).toBe(false);
  });

  it('refuses a link that is not a page of the app or https', () => {
    const bad = {
      ...DRAFT,
      summary: [cited('x', { kind: 'ticket', label: 'OPS-1', href: 'javascript:alert(1)' })],
    };
    expect(weeklyBriefContentSchema.safeParse(bad).success).toBe(false);
  });
});

describe('evidenceOutsideDraft', () => {
  it('is empty for an edit that rewords, drops or adds a sentence with no evidence', () => {
    const edited: WeeklyBriefContent = {
      summary: [cited('SLA fell a lot.', metric), humanClaim('Our note.')],
      rootCauses: [],
      decisions: [],
    };
    expect(evidenceOutsideDraft(DRAFT, edited)).toEqual([]);
  });

  it('finds evidence the draft did not have, in any section', () => {
    const invented = { kind: 'incident', label: 'INC-9', href: '/incidents?incident=x' } as const;
    const edited: WeeklyBriefContent = {
      ...DRAFT,
      decisions: [cited('Decide.', invented)],
    };
    expect(evidenceOutsideDraft(DRAFT, edited)).toEqual([invented]);
  });

  it('compares the link too, not only the label', () => {
    const edited: WeeklyBriefContent = {
      ...DRAFT,
      summary: [cited('x', { ...metric, href: '/dashboard/cost' })],
    };
    expect(evidenceOutsideDraft(DRAFT, edited)).toHaveLength(1);
  });
});

describe('weeklyBriefEmailParts', () => {
  const intent = { kind: 'data', label: 'intent: Password reset', href: '/dashboard/ceo' } as const;
  const person = { kind: 'person', label: 'Somchai Jaidee' } as const;
  const content: WeeklyBriefContent = {
    summary: [cited('Somchai Jaidee of Acme Co wrote about the invoice.', person, ticket)],
    rootCauses: [
      {
        title: 'Acme Co cannot sign in',
        claims: [cited('Somchai Jaidee: login loop.', intent, ticket, person)],
        ask: 'Call Somchai Jaidee',
      },
    ],
    decisions: [cited('Decide for Acme Co.', ticket), humanClaim('Ask Somchai Jaidee')],
  };

  it('carries only figures, keys and intent names, never the words of a claim (T-305f)', () => {
    const parts = weeklyBriefEmailParts(content, 'en', [
      'SLA compliance: 90% (period before 85%).',
    ]);
    expect(parts).toEqual({
      summary: ['SLA compliance: 90% (period before 85%).'],
      rootCauses: [{ title: 'Password reset', text: '[OPS-12]', ask: null }],
      decisions: ['Needs a decision: [OPS-12]', 'A decision is open, see the app'],
    });
    const wire = JSON.stringify(parts);
    for (const leak of ['Somchai', 'Acme', 'invoice', 'login loop']) {
      expect(wire).not.toContain(leak);
    }
  });

  it('is Thai when the brief is Thai and names a cause with no intent by its number', () => {
    const parts = weeklyBriefEmailParts(DRAFT, 'th', []);
    expect(parts.rootCauses[0]).toEqual({ title: 'สาเหตุที่ 1', text: '[OPS-12]', ask: null });
  });

  it('stays inside the limits of an email job', () => {
    const many = cited(
      'x',
      ...Array.from({ length: 8 }, (_, n) => ({ ...ticket, label: 'K'.repeat(30) + String(n) })),
    );
    const parts = weeklyBriefEmailParts(
      {
        summary: [],
        rootCauses: Array.from({ length: 5 }, () => ({ title: 'T', claims: [many], ask: null })),
        decisions: Array.from({ length: 5 }, () => many),
      },
      'en',
      Array.from({ length: 12 }, () => 'F'.repeat(2000)),
    );
    const job = {
      kind: 'weekly_brief',
      to: 'ceo@example.test',
      locale: 'en',
      periodFrom: '2026-11-03T00:00:00.000Z',
      periodTo: '2026-11-09T03:00:00.000Z',
      pageUrl: 'http://localhost:3000/dashboard/ceo',
      ...parts,
    };
    expect(emailJobSchema.safeParse(job).success).toBe(true);
  });
});

describe('the weekly brief email job', () => {
  it('seals the page link on the wire, so the envelope always has a sealed part', () => {
    const { clear, secret } = splitEmailSecrets({
      kind: 'weekly_brief',
      to: 'ceo@example.test',
      locale: 'th',
      periodFrom: '2026-11-03T00:00:00.000Z',
      periodTo: '2026-11-09T03:00:00.000Z',
      pageUrl: 'http://localhost:3000/dashboard/ceo',
      summary: ['x'],
      rootCauses: [],
      decisions: [],
    });
    expect(Object.keys(secret)).toEqual(['pageUrl']);
    expect(clear).not.toHaveProperty('pageUrl');
  });
});

describe('recipients and time', () => {
  it('lower-cases and validates addresses, at most fifty', () => {
    expect(weeklyBriefPublishBodySchema.parse({ recipients: [' A@Example.test '] })).toEqual({
      recipients: ['a@example.test'],
    });
    expect(weeklyBriefPublishBodySchema.safeParse({ recipients: ['nope'] }).success).toBe(false);
    expect(
      weeklyBriefPublishBodySchema.safeParse({
        recipients: Array.from({ length: 51 }, (_, n) => `p${String(n)}@example.test`),
      }).success,
    ).toBe(false);
    expect(weeklyBriefPublishBodySchema.parse({})).toEqual({});
  });

  it('reads HH:MM on a 24-hour clock', () => {
    expect(parseWeeklyBriefTime('08:00')).toBe(480);
    expect(parseWeeklyBriefTime('23:59')).toBe(1439);
    for (const bad of ['24:00', '8:00', '08:60', '8am', '']) {
      expect(parseWeeklyBriefTime(bad)).toBeNull();
    }
  });
});
