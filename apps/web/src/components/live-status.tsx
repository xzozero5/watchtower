'use client';

import { cn } from '@watchtower/ui';
import { CircleX, LoaderCircle, Radio, PauseCircle } from 'lucide-react';

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

/** Whether live updates are flowing, as an icon and words. A paused tab gets a retry button. */
export function LiveStatus() {
  const t = useT();
  const { state, retry } = useRealtime();
  const view = VIEW[state];
  const Icon = view.icon;
  return (
    <p
      role="status"
      data-testid="live-status"
      data-state={state}
      aria-label={t('live.label')}
      className={cn('flex items-center gap-1.5 text-sm font-medium', view.tone)}
    >
      <Icon aria-hidden className={cn('size-4', view.spin && 'animate-spin')} />
      <span>{t(view.key)}</span>
      {state === 'paused' ? (
        <button
          type="button"
          onClick={retry}
          className="rounded-md border border-border-strong px-2 py-0.5 text-xs text-foreground hover:bg-surface-muted"
        >
          {t('live.retry')}
        </button>
      ) : null}
    </p>
  );
}
