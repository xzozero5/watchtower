'use client';

import { Tooltip } from '@watchtower/ui';

import { ApiStatus, useApiHealth } from '@/components/api-status';
import { LiveStatus } from '@/components/live-status';
import { useT } from '@/i18n/provider';
import { useRealtime } from '@/lib/realtime/realtime-provider';

/**
 * The connection state of the rail, in two parts. Healthy: one small neutral dot with a tooltip
 * and an accessible name ("Connected: live updates on, API online"), because a normal state should
 * be quiet. Trouble (api unreachable, live updates reconnecting, paused or unavailable): a visible
 * row with words and an amber or red icon, from LiveStatus and ApiStatus. The two status elements
 * are always in the page (hidden while healthy), so the checks that read their state keep working.
 */
export function RailStatus({ expanded, part }: { expanded: boolean; part: 'rows' | 'dot' }) {
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
            <span aria-hidden className="size-2 rounded-full bg-muted-foreground/60" />
          </span>
        </Tooltip>
      )}
    </>
  );
}
