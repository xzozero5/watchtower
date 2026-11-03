'use client';

import { cn, TINT_CLASSES, Tooltip } from '@watchtower/ui';
import { CircleX, LoaderCircle, PauseCircle, Radio, RotateCw } from 'lucide-react';

import { RAIL_ITEM_CLASSES } from '@/components/rail-styles';
import { useT } from '@/i18n/provider';
import type { ConnectionState } from '@/lib/realtime/connection';
import { useRealtime } from '@/lib/realtime/realtime-provider';

/** Amber: degraded and recovering or unavailable. Red: stopped until someone acts. Else quiet. */
const VIEW = {
  open: { icon: Radio, key: 'live.open', tone: '', spin: false, problem: false },
  connecting: { icon: LoaderCircle, key: 'live.connecting', tone: '', spin: true, problem: false },
  reconnecting: {
    icon: LoaderCircle,
    key: 'live.reconnecting',
    tone: TINT_CLASSES.amber.icon,
    spin: true,
    problem: true,
  },
  paused: {
    icon: PauseCircle,
    key: 'live.paused',
    tone: TINT_CLASSES.red.icon,
    spin: false,
    problem: true,
  },
  forbidden: {
    icon: CircleX,
    key: 'live.forbidden',
    tone: TINT_CLASSES.amber.icon,
    spin: false,
    problem: true,
  },
  ended: { icon: CircleX, key: 'live.ended', tone: '', spin: false, problem: false },
} as const satisfies Record<ConnectionState, unknown>;

/**
 * Whether live updates are flowing, as an icon and words. A paused tab gets a retry button.
 * `compact` keeps the words for screen readers and a tooltip and shows only the icon (the rail).
 * `quiet` (the rail): while nothing is wrong the words stay for screen readers and tests but
 * nothing is drawn (the rail shows one neutral dot for the healthy case); a problem is a visible
 * row, laid out like the other rail items.
 */
export function LiveStatus({
  compact = false,
  quiet = false,
}: {
  compact?: boolean;
  quiet?: boolean;
}) {
  const t = useT();
  const { state, retry } = useRealtime();
  const view = VIEW[state];
  const Icon = view.icon;
  const text = t(view.key);
  const hidden = quiet && !view.problem;
  return (
    <div className={hidden ? 'sr-only' : 'flex items-center'}>
      <Tooltip content={text} side="right" disabled={!compact || hidden}>
        <p
          role="status"
          data-testid="live-status"
          data-state={state}
          aria-label={t('live.label')}
          className={cn(
            hidden
              ? undefined
              : cn(RAIL_ITEM_CLASSES, 'max-md:w-control max-md:justify-center max-md:px-0'),
          )}
        >
          <Icon
            aria-hidden
            className={cn('size-4 shrink-0', view.tone, view.spin && 'animate-spin')}
          />
          <span className={compact && !hidden ? 'sr-only' : 'truncate'}>{text}</span>
        </p>
      </Tooltip>
      {state === 'paused' ? (
        <button
          type="button"
          onClick={retry}
          aria-label={t('live.retry')}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border-strong px-1.5 text-xs text-foreground hover:bg-surface-muted"
        >
          <RotateCw aria-hidden className="size-3.5" />
          <span className={compact ? 'sr-only' : undefined}>{t('live.retry')}</span>
        </button>
      ) : null}
    </div>
  );
}
