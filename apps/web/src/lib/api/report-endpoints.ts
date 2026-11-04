import {
  aiCostSchema,
  ceoImportResultSchema,
  ceoViewSchema,
  type CeoExportQuery,
  type CeoPointsBody,
} from '@watchtower/shared';

import type { ApiClient } from './client';

const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

/** The AI cost dashboard and the CEO view (T-305a, T-305b). One function per endpoint. */
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

    deleteCeoMetric: (key: string) =>
      client.request({
        method: 'DELETE',
        path: `/v1/reports/ceo/metrics/${encodeURIComponent(key)}`,
        schema: null,
      }),
  };
}
