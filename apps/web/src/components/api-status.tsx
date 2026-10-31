'use client';

import { useQuery } from '@tanstack/react-query';
import { cn } from '@watchtower/ui';
import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react';

import { useT } from '@/i18n/provider';
import { useRuntimeConfig } from '@/lib/runtime-config-context';

const POLL_MS = 30_000;
const TIMEOUT_MS = 5_000;

export async function fetchApiHealth(apiUrl: string, signal?: AbortSignal): Promise<'ok'> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(`${apiUrl}/health`, {
    cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`API health returned ${String(response.status)}`);
  // TanStack Query rejects a query that resolves to undefined, so return a value.
  return 'ok';
}

/**
 * Shows whether the browser can reach the API. It uses the runtime API URL, so it also proves the
 * deployment's configuration is wired up. The state is words plus an icon, never colour alone.
 */
export function ApiStatus() {
  const t = useT();
  const { apiUrl } = useRuntimeConfig();
  const { status } = useQuery({
    queryKey: ['api-health', apiUrl],
    queryFn: ({ signal }) => fetchApiHealth(apiUrl, signal),
    retry: false,
    refetchInterval: POLL_MS,
  });

  const view =
    status === 'pending'
      ? {
          icon: LoaderCircle,
          text: t('apiStatus.checking'),
          tone: 'text-muted-foreground',
          spin: true,
        }
      : status === 'success'
        ? { icon: CircleCheck, text: t('apiStatus.online'), tone: 'text-success', spin: false }
        : { icon: CircleX, text: t('apiStatus.offline'), tone: 'text-danger', spin: false };
  const Icon = view.icon;

  return (
    <p
      role="status"
      data-testid="api-status"
      data-state={status}
      aria-label={t('apiStatus.label')}
      className={cn('flex items-center gap-1.5 text-sm font-medium', view.tone)}
    >
      <Icon aria-hidden className={cn('size-4', view.spin && 'animate-spin')} />
      <span>{view.text}</span>
    </p>
  );
}
