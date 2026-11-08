import { insightsResponseSchema, type InsightsResponse } from '@watchtower/shared';

import type { ApiClient } from './client';

export interface InsightsQueryParams {
  elements: readonly string[] | string[];
  scope?: string;
  period?: string;
  locale?: 'th' | 'en';
}

/** `GET /v1/insights` (T-416, T-419a, ADR-029 section 9). Staff only; a client gets a 403. */
export function createInsightEndpoints(client: ApiClient) {
  return {
    insights: (query: InsightsQueryParams, signal?: AbortSignal): Promise<InsightsResponse> =>
      client.request({
        path: '/v1/insights',
        query: {
          elements: query.elements.join(','),
          ...(query.scope ? { scope: query.scope } : {}),
          ...(query.period ? { period: query.period } : {}),
          ...(query.locale ? { locale: query.locale } : {}),
        },
        schema: insightsResponseSchema,
        ...(signal ? { signal } : {}),
      }),
  };
}
