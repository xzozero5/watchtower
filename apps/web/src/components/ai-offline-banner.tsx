'use client';

import { useQuery } from '@tanstack/react-query';
import { Alert } from '@watchtower/ui';

import { useT } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';

const POLL_MS = 30_000;

/** `GET /v1/ai/status`, polled. Any failure means "unknown", which shows nothing (N5: no guessing). */
export function useAiStatus(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: ['ai-status', userId],
    queryFn: ({ signal }) => api.aiStatus(signal),
    enabled,
    retry: false,
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
  });
}

/**
 * Shown at the top of the main area of every console page while the AI cannot be reached (the host
 * of `claude -p` is off or has no internet, T-170). Not red: the work waits and retries by itself and
 * people carry on by hand. Nothing shows while the AI is online, switched off by configuration
 * (`disabled`), or when the status is unknown.
 */
export function AiOfflineBanner() {
  const t = useT();
  const status = useAiStatus();
  if (status.data?.status !== 'offline') return null;
  return (
    <div className="border-b border-border bg-background p-2" data-testid="ai-offline-banner">
      <Alert tone="info" title={t('aiOffline.title')}>
        {t('aiOffline.body')}
      </Alert>
    </div>
  );
}
