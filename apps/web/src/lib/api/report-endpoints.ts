import {
  aiCostSchema,
  ceoImportResultSchema,
  ceoViewSchema,
  weeklyBriefDraftSchema,
  weeklyBriefPublishedSchema,
  weeklyBriefPublishResultSchema,
  weeklyBriefSchema,
  type CeoExportQuery,
  type CeoPointsBody,
  type WeeklyBriefContent,
} from '@watchtower/shared';

import type { ApiClient } from './client';

const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

/** The AI cost dashboard, the CEO view and its weekly brief (T-305a, T-305b, T-305c). One function per endpoint. */
export function createReportEndpoints(client: ApiClient) {
  return {
    aiCost: (days: number, top: number, signal?: AbortSignal) =>
      client.request({
        path: '/v1/reports/ai-cost',
        query: { days, top },
        schema: aiCostSchema,
        ...withSignal(signal),
      }),

    ceoView: (days: number, signal?: AbortSignal) =>
      client.request({
        path: '/v1/reports/ceo',
        query: { days },
        schema: ceoViewSchema,
        ...withSignal(signal),
      }),

    /** The export as bytes, through the same authenticated path as every other call. */
    ceoExport: (query: CeoExportQuery, signal?: AbortSignal) =>
      client.download(
        `/v1/reports/ceo/export?days=${String(query.days)}&format=${query.format}`,
        signal,
      ),

    recordCeoPoints: (body: CeoPointsBody) =>
      client.request({
        method: 'POST',
        path: '/v1/reports/ceo/points',
        body,
        schema: ceoImportResultSchema,
      }),

    importCeoCsv: (csv: string) =>
      client.request({
        method: 'POST',
        path: '/v1/reports/ceo/points/import',
        body: { csv },
        schema: ceoImportResultSchema,
      }),

    /** The newest published weekly brief (lead and head). */
    weeklyBrief: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/reports/ceo/brief',
        schema: weeklyBriefPublishedSchema,
        ...withSignal(signal),
      }),

    /** The newest draft with the AI's own text, and the default recipients (head). */
    weeklyBriefDraft: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/reports/ceo/brief/draft',
        schema: weeklyBriefDraftSchema,
        ...withSignal(signal),
      }),

    editWeeklyBrief: (id: string, content: WeeklyBriefContent) =>
      client.request({
        method: 'PUT',
        path: `/v1/reports/ceo/brief/${encodeURIComponent(id)}`,
        body: { content },
        schema: weeklyBriefSchema,
      }),

    publishWeeklyBrief: (id: string, recipients: readonly string[]) =>
      client.request({
        method: 'POST',
        path: `/v1/reports/ceo/brief/${encodeURIComponent(id)}/publish`,
        body: { recipients },
        schema: weeklyBriefPublishResultSchema,
      }),

    deleteCeoMetric: (key: string) =>
      client.request({
        method: 'DELETE',
        path: `/v1/reports/ceo/metrics/${encodeURIComponent(key)}`,
        schema: null,
      }),
  };
}
