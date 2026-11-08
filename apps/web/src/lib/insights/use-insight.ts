'use client';

import { useQuery } from '@tanstack/react-query';
import type { InsightElementKey, InsightItem } from '@watchtower/shared';
import { INSIGHTS_MAX_ELEMENTS } from '@watchtower/shared';

import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import type { Endpoints } from '@/lib/api/endpoints';
import { useUserId } from '@/lib/auth/session';

export interface UseInsightOptions {
  element: InsightElementKey;
  scope?: string;
  period?: string;
  enabled?: boolean;
}

interface QueuedItem {
  api: Endpoints;
  userId: string;
  element: InsightElementKey;
  scope?: string;
  period?: string;
  locale: 'th' | 'en';
  resolve: (item: InsightItem | null) => void;
  reject: (err: unknown) => void;
}

/** Global in-flight batch queue to group multiple <ElementInsight> requests on the same page tick. */
let queuedBatch: QueuedItem[] = [];
let batchScheduled = false;

function flushBatch() {
  const currentBatch = queuedBatch;
  queuedBatch = [];
  batchScheduled = false;

  if (currentBatch.length === 0) return;

  // Group by (userId, scope, period, locale) so distinct principals never share a microtask batch
  const groups = new Map<string, QueuedItem[]>();
  for (const item of currentBatch) {
    const key = `${item.userId}::${item.scope ?? ''}::${item.period ?? ''}::${item.locale}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  for (const items of groups.values()) {
    // Chunk into at most INSIGHTS_MAX_ELEMENTS (12)
    for (let i = 0; i < items.length; i += INSIGHTS_MAX_ELEMENTS) {
      const chunk = items.slice(i, i + INSIGHTS_MAX_ELEMENTS);
      const first = chunk[0];
      if (!first) continue;

      const elements = [...new Set(chunk.map((c) => c.element))];
      first.api
        .insights({
          elements,
          ...(first.scope ? { scope: first.scope } : {}),
          ...(first.period ? { period: first.period } : {}),
          locale: first.locale,
        })
        .then((response) => {
          const byElement = new Map<string, InsightItem>(
            response.items.map((item) => [item.element, item]),
          );
          for (const req of chunk) {
            req.resolve(byElement.get(req.element) ?? null);
          }
        })
        .catch((err: unknown) => {
          for (const req of chunk) {
            req.reject(err);
          }
        });
    }
  }
}

export function fetchBatchedInsight(
  api: Endpoints,
  element: InsightElementKey,
  scope: string | undefined,
  period: string | undefined,
  locale: 'th' | 'en',
  userId = '',
): Promise<InsightItem | null> {
  return new Promise((resolve, reject) => {
    queuedBatch.push({ api, userId, element, scope, period, locale, resolve, reject });
    if (!batchScheduled) {
      batchScheduled = true;
      // Microtask tick batches synchronous renders together in 1 network call
      queueMicrotask(() => {
        flushBatch();
      });
    }
  });
}

export const insightKeys = (userId: string) => {
  const root = ['insights', userId] as const;
  return {
    root,
    item: (element: InsightElementKey, scope?: string, period?: string, locale?: string) =>
      [...root, element, scope ?? '', period ?? '', locale ?? ''] as const,
  };
};

/**
 * Reads an embedded insight via TanStack Query (ADR-029 section 9.6).
 * staleTime: 5 min, refetch on window focus, batched across elements on the same page.
 */
export function useInsight({ element, scope, period, enabled = true }: UseInsightOptions) {
  const api = useApi();
  const userId = useUserId();
  const { locale } = useI18n();

  return useQuery({
    queryKey: insightKeys(userId).item(element, scope, period, locale),
    queryFn: () => fetchBatchedInsight(api, element, scope, period, locale, userId),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    enabled,
    retry: false,
    placeholderData: (previousData) => previousData,
  });
}
