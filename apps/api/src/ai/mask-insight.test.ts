import type { TicketAiInsight } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import type { MaskingSession } from '../masking/pii-masker.js';
import { maskInsight } from './mask-insight.js';

const session = {
  text: (value: string) => value.replaceAll('secret', '[MASKED]'),
  textOrNull: (value: string | null) =>
    value === null ? null : value.replaceAll('secret', '[MASKED]'),
} as unknown as MaskingSession;

describe('maskInsight and the priority suggestion (T-147)', () => {
  it('masks the reason of a suggested priority and keeps the rest', () => {
    const insight: TicketAiInsight = {
      state: 'classified',
      evidence: [],
      stage: 2,
      generatedAt: '2026-11-04T00:00:00.000Z',
      report: {
        findings: [],
        likelyCause: null,
        confidence: 0.5,
        openQuestions: [],
        tools: [],
        promptVersion: 'v2',
        suggestedPriority: { priority: 'P1', reason: 'secret outage', confidence: 0.8 },
        replyBlocked: 'no_outbound_channel',
      },
    };
    const masked = maskInsight(insight, session);
    expect(masked.report?.suggestedPriority).toEqual({
      priority: 'P1',
      reason: '[MASKED] outage',
      confidence: 0.8,
    });
    expect(masked.report?.replyBlocked).toBe('no_outbound_channel');
  });
});
