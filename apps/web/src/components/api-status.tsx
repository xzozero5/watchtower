'use client';

import { useQuery } from '@tanstack/react-query';
import { cn, TINT_CLASSES, Tooltip } from '@watchtower/ui';
import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react';

import { RAIL_ITEM_CLASSES } from '@/components/rail-styles';
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

/** The api health check, polled. `success`, `error` or `pending`. */
export function useApiHealth() {
  const { apiUrl } = useRuntimeConfig();
  return useQuery({
    queryKey: ['api-health', apiUrl],
    queryFn: ({ signal }) => fetchApiHealth(apiUrl, signal),
    retry: false,
    refetchInterval: POLL_MS,
  }).status;
}

/**
 * Shows whether the browser can reach the API. It uses the runtime API URL, so it also proves the
 * deployment's configuration is wired up. The state is words plus an icon, never colour alone.
 *
 * `quiet` (the rail): while all is well the words stay for screen readers and tests but nothing is
 * drawn, because a normal state is not news (the rail shows one neutral dot instead). A failure is
 * always a visible row, laid out like the other rail items.
 */
export function ApiStatus({
  compact = false,
  quiet = false,
}: {
  compact?: boolean;
  quiet?: boolean;
}) {
  const t = useT();
  const status = useApiHealth();

  const view =
    status === 'pending'
      ? { icon: LoaderCircle, text: t('apiStatus.checking'), tone: '', spin: true }
      : status === 'success'
        ? { icon: CircleCheck, text: t('apiStatus.online'), tone: '', spin: false }
        : {
            icon: CircleX,
            text: t('apiStatus.offline'),
            tone: TINT_CLASSES.red.icon,
            spin: false,
          };
  const Icon = view.icon;
  const hidden = quiet && status !== 'error';

  return (
    <Tooltip content={view.text} side="right" disabled={!compact || hidden}>
      <p
        role="status"
        data-testid="api-status"
        data-state={status}
        aria-label={t('apiStatus.label')}
        className={cn(
          hidden
            ? 'sr-only'
            : cn(RAIL_ITEM_CLASSES, 'max-md:w-control max-md:justify-center max-md:px-0'),
        )}
      >
        <Icon
          aria-hidden
          className={cn('size-4 shrink-0', view.tone, view.spin && 'animate-spin')}
        />
        <span className={compact && !hidden ? 'sr-only' : 'truncate'}>{view.text}</span>
      </p>
    </Tooltip>
  );
}
