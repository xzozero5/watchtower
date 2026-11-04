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
  it('names the evidence on each line and says when there is none', () => {
    const parts = weeklyBriefEmailParts({
      ...DRAFT,
      summary: [cited('SLA fell.', metric, ticket), humanClaim('A person wrote this.')],
      decisions: [cited('Decide.', ticket)],
    });
    expect(parts.summary).toEqual([
      'SLA fell. [SLA, OPS-12]',
      'A person wrote this. (no evidence)',
    ]);
    expect(parts.rootCauses).toEqual([
      { title: 'Sign-in', text: 'Nine tickets. [OPS-12]', ask: null },
    ]);
    expect(parts.decisions).toEqual(['Decide. [OPS-12]']);
  });

  it('stays inside the limits of an email job, however long a sentence is', () => {
    const long = cited(
      'x'.repeat(600),
      ...Array.from({ length: 8 }, () => ({ ...ticket, label: 'L'.repeat(100) })),
    );
    const parts = weeklyBriefEmailParts({
      summary: [long],
      rootCauses: [{ title: 'T'.repeat(160), claims: [long, long, long], ask: 'a'.repeat(300) }],
      decisions: [long],
    });
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
