import {
  goldenAnswerListSchema,
  goldenAnswerSchema,
  intentGradeMetricsResponseSchema,
  ticketGradeResponseSchema,
} from '@watchtower/shared';

import type { ApiClient } from './client';

/**
 * The grader's results (T-301d) and golden answers (T-302a). Grades are read by staff and developers
 * (redacted for a developer); the numbers per intent need `metric.read`; golden answers need
 * `ai.golden.manage` (lead and head).
 */
export function createGradeEndpoints(client: ApiClient) {
  const ticket = (ref: string) => `/v1/tickets/${encodeURIComponent(ref)}`;
  const withSignal = (signal: AbortSignal | undefined) => (signal ? { signal } : {});
  return {
    ticketGrade: (ref: string, signal?: AbortSignal) =>
      client.request({
        path: `${ticket(ref)}/ai/grade`,
        schema: ticketGradeResponseSchema,
        ...withSignal(signal),
      }),

    intentGradeMetrics: (days: number, signal?: AbortSignal) =>
      client.request({
        path: '/v1/ai/grades/metrics',
        query: { days },
        schema: intentGradeMetricsResponseSchema,
        ...withSignal(signal),
      }),

    goldenOfTicket: (ref: string, signal?: AbortSignal) =>
      client.request({
        path: `${ticket(ref)}/golden`,
        schema: goldenAnswerListSchema,
        ...withSignal(signal),
      }),

    markGolden: (ref: string, messageId: string, shareable = false) =>
      client.request({
        method: 'POST',
        path: `${ticket(ref)}/golden`,
        body: { messageId, shareable },
        schema: goldenAnswerSchema,
      }),

    goldenAnswers: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/ai/golden',
        query: { limit: 200 },
        schema: goldenAnswerListSchema,
        ...withSignal(signal),
      }),

    deleteGolden: (id: string) =>
      client.request({
        method: 'DELETE',
        path: `/v1/ai/golden/${encodeURIComponent(id)}`,
        schema: null,
      }),
  };
}
