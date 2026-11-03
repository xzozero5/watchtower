'use client';

import { cn, TINT_CLASSES, Tooltip } from '@watchtower/ui';

import { ApiStatus, useApiHealth } from '@/components/api-status';
import { LiveStatus } from '@/components/live-status';
import { useT } from '@/i18n/provider';
import { useRealtime } from '@/lib/realtime/realtime-provider';

/**
 * The connection state of the rail, in two parts. Healthy: one small green dot with a tooltip and
 * an accessible name ("Connected: live updates on, API online") — green because a grey dot beside a
 * person reads as offline (owner, 2026-11-03), and small so a normal state stays quiet; grey while
 * still connecting. Trouble (api unreachable, live updates reconnecting, paused or unavailable): a visible
 * row with words and an amber or red icon, from LiveStatus and ApiStatus. The two status elements
 * are always in the page (hidden while healthy), so the checks that read their state keep working.
 */
export function RailStatus({
  expanded,
  part,
}: {
  expanded: boolean;
  /**
   * `badge`: the same dot, small and ringed, for the corner of the avatar in the narrow rail. It is
   * decoration there (inside the account button); the status words stay in the page through `rows`.
   */
  part: 'rows' | 'dot' | 'badge';
}) {
  const t = useT();
  const { state } = useRealtime();
  const api = useApiHealth();
  const trouble =
    api === 'error' || state === 'reconnecting' || state === 'paused' || state === 'forbidden';
  const settling = state === 'connecting' || api === 'pending';
  const label = t(settling ? 'rail.statusConnecting' : 'rail.statusOk');
  if (part === 'rows') {
    return (
      <>
        <LiveStatus compact={!expanded} quiet />
        <ApiStatus compact={!expanded} quiet />
      </>
    );
  }
  if (part === 'badge') {
    return trouble ? null : (
      <span
        data-testid="rail-status-badge"
        className={cn(
          'block size-2.5 rounded-full ring-2 ring-frame',
          settling ? 'bg-muted-foreground/60' : TINT_CLASSES.green.dot,
        )}
      />
    );
  }
  return (
    <>
      {trouble ? null : (
        <Tooltip content={label} side="right">
          <span
            role="img"
            tabIndex={0}
            aria-label={label}
            data-testid="rail-status-dot"
            className="grid size-control shrink-0 place-items-center rounded-full outline-offset-0 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span
              aria-hidden
              className={cn(
                'size-2 rounded-full',
                settling ? 'bg-muted-foreground/60' : TINT_CLASSES.green.dot,
              )}
            />
          </span>
        </Tooltip>
      )}
    </>
  );
}
