'use client';

import { cn, Tooltip } from '@watchtower/ui';
import { CircleX, LoaderCircle, PauseCircle, Radio, RotateCw } from 'lucide-react';

import { useT } from '@/i18n/provider';
import type { ConnectionState } from '@/lib/realtime/connection';
import { useRealtime } from '@/lib/realtime/realtime-provider';

const VIEW = {
  open: { icon: Radio, key: 'live.open', tone: 'text-success', spin: false },
  connecting: {
    icon: LoaderCircle,
    key: 'live.connecting',
    tone: 'text-muted-foreground',
    spin: true,
  },
  reconnecting: {
    icon: LoaderCircle,
    key: 'live.reconnecting',
    tone: 'text-muted-foreground',
    spin: true,
  },
  paused: { icon: PauseCircle, key: 'live.paused', tone: 'text-danger', spin: false },
  forbidden: { icon: CircleX, key: 'live.forbidden', tone: 'text-muted-foreground', spin: false },
  ended: { icon: CircleX, key: 'live.ended', tone: 'text-muted-foreground', spin: false },
} as const satisfies Record<ConnectionState, unknown>;

/**
 * Whether live updates are flowing, as an icon and words. A paused tab gets a retry button.
 * `compact` keeps the words for screen readers and a tooltip and shows only the icon (the rail).
 */
export function LiveStatus({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const { state, retry } = useRealtime();
  const view = VIEW[state];
  const Icon = view.icon;
  const text = t(view.key);
  return (
    <div className={cn('flex items-center gap-1.5', compact && 'justify-center')}>
      <Tooltip content={text} side="right" disabled={!compact}>
        <p
          role="status"
          data-testid="live-status"
          data-state={state}
          aria-label={t('live.label')}
          className={cn(
            'flex items-center gap-1.5 text-xs font-medium',
            compact && 'size-control justify-center',
            view.tone,
          )}
        >
          <Icon aria-hidden className={cn('size-4', view.spin && 'animate-spin')} />
          <span className={compact ? 'sr-only' : undefined}>{text}</span>
        </p>
      </Tooltip>
      {state === 'paused' ? (
        <button
          type="button"
          onClick={retry}
          aria-label={t('live.retry')}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-border-strong px-1.5 text-xs text-foreground hover:bg-surface-muted"
        >
          <RotateCw aria-hidden className="size-3.5" />
          <span className={compact ? 'sr-only' : undefined}>{t('live.retry')}</span>
        </button>
      ) : null}
    </div>
  );
}
