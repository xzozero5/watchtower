import { describe, expect, it } from 'vitest';

import { toTicketAiInsight } from './ticket-ai.service.js';

type InsightRow = Parameters<typeof toTicketAiInsight>[0];

function row(overrides: Partial<InsightRow>): InsightRow {
  return {
    ticketId: '00000000-0000-4000-8000-000000000001',
    state: 'classified',
    reasonCode: null,
    summary: null,
    intentKey: null,
    intentConfidence: null,
    intentReason: null,
    nextStepKind: null,
    nextStepLabel: null,
    evidence: [],
    draftId: null,
    stage: 2,
    classifierRunId: null,
    summarizerRunId: null,
    generatedAt: new Date('2026-11-02T16:00:00Z'),
    report: null,
    progress: null,
    requestedBy: null,
    investigatedAt: null,
    updatedAt: new Date('2026-11-02T16:00:00Z'),
    ...overrides,
  };
}

describe('toTicketAiInsight reason code (QA-07)', () => {
  it('says why a failed brief failed', () => {
    const insight = toTicketAiInsight(row({ state: 'failed', reasonCode: 'model_output_invalid' }));
    expect(insight.reasonCode).toBe('model_output_invalid');
  });

  it('leaves the reason out when the brief did not fail', () => {
    const insight = toTicketAiInsight(row({ state: 'classified', reasonCode: 'provider_error' }));
    expect(insight).not.toHaveProperty('reasonCode');
  });
});

describe('toTicketAiInsight stage', () => {
  it('shows the stage of the intent the ticket has now, not the one when the brief was made', () => {
    // Classified while the ticket had no intent (stage 0); a person then set an intent at stage 2.
    expect(toTicketAiInsight(row({ stage: 0 }), undefined, 2).stage).toBe(2);
  });

  it('keeps the stored stage when the ticket has no intent', () => {
    expect(toTicketAiInsight(row({ stage: 0 })).stage).toBe(0);
  });
});
