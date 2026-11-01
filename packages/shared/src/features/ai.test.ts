import { describe, expect, it } from 'vitest';

import { ticketSummarySchema } from '../ticketing.js';
import {
  AI_REJECT_REASONS,
  AI_STATES,
  rejectAiDraftSchema,
  ticketAiInsightSchema,
  ticketAiRowSchema,
} from './ai.js';

const GENERATED_AT = '2026-11-02T03:00:00.000Z';

const insight = {
  state: 'draft_ready',
  summary: 'Customer cannot sign in after a password reset; the account is locked.',
  intent: { key: 'login_issue', confidence: 0.86, reason: 'Matches 12 earlier lockout tickets.' },
  nextStep: { kind: 'approve_draft', label: 'Approve reply' },
  evidence: [
    {
      id: 'ev-1',
      kind: 'kb',
      title: 'Unlocking an account',
      snippet: 'Locks clear after 15 minutes.',
      confidence: 0.91,
      href: '/kb/unlock',
    },
  ],
  draft: {
    id: 'draft-1',
    body: 'Hello, the lock clears after 15 minutes [1].',
    citations: ['ev-1'],
    uncitedClaims: 0,
    promptVersion: 'v3',
    createdAt: GENERATED_AT,
  },
  stage: 2,
  generatedAt: GENERATED_AT,
};

describe('ticketAiInsightSchema', () => {
  it('accepts the full contract of the design doc', () => {
    expect(ticketAiInsightSchema.parse(insight)).toEqual(insight);
  });

  it('accepts the smallest answer: a state, no evidence, a stage and a time', () => {
    const minimal = { state: 'none', evidence: [], stage: 2, generatedAt: GENERATED_AT };
    expect(ticketAiInsightSchema.parse(minimal)).toEqual(minimal);
  });

  it.each(AI_STATES)('accepts the state %s', (state) => {
    expect(
      ticketAiInsightSchema.safeParse({ state, evidence: [], stage: 1, generatedAt: GENERATED_AT })
        .success,
    ).toBe(true);
  });

  it.each([
    ['an unknown state', { state: 'thinking' }],
    ['a confidence above 1', { intent: { key: 'x', confidence: 1.2, reason: 'r' } }],
    ['an unknown next-step kind', { nextStep: { kind: 'launch', label: 'x' } }],
    [
      'an evidence kind outside the list',
      { evidence: [{ ...insight.evidence[0], kind: 'tweet' }] },
    ],
    ['a negative uncited count', { draft: { ...insight.draft, uncitedClaims: -1 } }],
    ['a missing generation time', { generatedAt: undefined }],
  ])('refuses %s', (_name, patch) => {
    expect(ticketAiInsightSchema.safeParse({ ...insight, ...patch }).success).toBe(false);
  });
});

describe('ticketAiRowSchema', () => {
  it('accepts a state with or without a summary', () => {
    expect(ticketAiRowSchema.parse({ state: 'investigating' })).toEqual({ state: 'investigating' });
    expect(ticketAiRowSchema.parse({ state: 'classified', summary: 'Export is slow' })).toEqual({
      state: 'classified',
      summary: 'Export is slow',
    });
  });

  it('is optional on a ticket summary and survives parsing when present', () => {
    const base = {
      id: 'a0000000-0000-4000-8000-000000000001',
      number: 1,
      key: 'OPS-1',
      subject: 'Subject',
      status: 'open',
      priority: 'P3',
      channel: 'portal',
      org: { id: 'a0000000-0000-4000-8000-000000000500', name: 'Example Org' },
      requester: null,
      intent: null,
      assignee: null,
      queue: null,
      slaPolicyId: null,
      firstResponseDueAt: null,
      resolutionDueAt: null,
      slaPausedAt: null,
      firstRespondedAt: null,
      resolvedAt: null,
      closedAt: null,
      parentTicketId: null,
      mergedIntoKey: null,
      tags: [],
      customFields: {},
      autonomyStageAtCreation: null,
      aiHandled: false,
      reopenCount: 0,
      csatScore: null,
      createdAt: GENERATED_AT,
      updatedAt: GENERATED_AT,
    };
    expect(ticketSummarySchema.parse(base).ai).toBeUndefined();
    expect(
      ticketSummarySchema.parse({ ...base, ai: { state: 'draft_ready', summary: 's' } }).ai,
    ).toEqual({ state: 'draft_ready', summary: 's' });
  });
});

describe('rejectAiDraftSchema', () => {
  it('lists the nine reason codes of the UI spec in order', () => {
    expect(AI_REJECT_REASONS).toEqual([
      'wrong_intent',
      'factually_wrong',
      'missing_info',
      'not_grounded',
      'disclosure_risk',
      'tone_style',
      'wrong_language',
      'no_reply_needed',
      'other',
    ]);
  });

  it('accepts a reason without a comment', () => {
    expect(rejectAiDraftSchema.safeParse({ reason: 'tone_style' }).success).toBe(true);
  });

  it('needs a comment when the reason is "other"', () => {
    expect(rejectAiDraftSchema.safeParse({ reason: 'other' }).success).toBe(false);
    expect(rejectAiDraftSchema.safeParse({ reason: 'other', comment: '   ' }).success).toBe(false);
    expect(
      rejectAiDraftSchema.safeParse({ reason: 'other', comment: 'Wrong product' }).success,
    ).toBe(true);
  });

  it('refuses a reason that is not on the list', () => {
    expect(rejectAiDraftSchema.safeParse({ reason: 'boring' }).success).toBe(false);
  });
});
