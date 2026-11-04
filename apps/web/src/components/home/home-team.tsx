'use client';

import type { UseQueryResult } from '@tanstack/react-query';
import { OPEN_STATUSES, type ShiftOverview, type TicketStats } from '@watchtower/shared';
import { Skeleton, TintChip } from '@watchtower/ui';
import { TriangleAlert } from 'lucide-react';

import { LoadError } from '@/components/admin/admin-page';
import { AppLink } from '@/components/app-link';
import { useShiftFormat } from '@/components/shift/shift-bits';
import { useT } from '@/i18n/provider';
import { queueHref } from '@/lib/tickets/filters';

import { CountLink, CountsUnavailable } from './home-sections';

function ListSkeleton() {
  const t = useT();
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-1.5">
      <span className="sr-only">{t('home.loading')}</span>
      {[0, 1].map((index) => (
        <Skeleton key={index} className="h-6" />
      ))}
    </div>
  );
}

/**
 * Who is on shift and who was rostered but has not clocked in (T-141). The same source as the Lead
 * view (`GET /v1/shifts/overview`), so Home and that page always agree; this is the two-line version
 * with a link to the rest (unacknowledged handoff items, questions, clock-out).
 */
export function TeamNow({ query }: { query: UseQueryResult<ShiftOverview> }) {
  const t = useT();
  const format = useShiftFormat(query.data?.timezone);
  if (query.isPending) return <ListSkeleton />;
  if (query.isError) {
    return (
      <LoadError
        message={t('home.team.unavailable')}
        onRetry={() => void query.refetch()}
        className="px-0 text-muted-foreground"
      />
    );
  }
  const { onShift, noShows } = query.data;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="mb-1 text-sm font-medium text-foreground">
          {t('home.team.onShift')}{' '}
          <span className="tabular text-muted-foreground">{onShift.length}</span>
        </h3>
        {onShift.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('home.team.onShiftEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {onShift.map((session) => (
              <li key={session.id} className="flex flex-wrap items-center gap-x-2 text-sm">
                <span className="font-medium">{session.userName}</span>
                <span className="text-muted-foreground">
                  {session.shiftName ?? t('shift.chip.notRostered')} ·{' '}
                  {t('shift.overview.since', { time: format.time(session.clockedInAt) })}
                </span>
                {session.late ? (
                  <TintChip tone="amber" icon={TriangleAlert}>
                    {t('shift.overview.late', { minutes: session.lateMinutes })}
                  </TintChip>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="mb-1 text-sm font-medium text-foreground">
          {t('home.team.notClockedIn')}{' '}
          <span className="tabular text-muted-foreground">{noShows.length}</span>
        </h3>
        {noShows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('home.team.notClockedInEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {noShows.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-x-2 text-sm">
                <TriangleAlert aria-hidden className="size-3.5 text-danger" />
                <span className="font-medium">{entry.userName}</span>
                <span className="text-muted-foreground">
                  {t('home.team.expected', {
                    shift: entry.shiftName,
                    time: format.time(entry.startsAt),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <AppLink
        href="/shift/overview"
        className="self-start rounded-sm text-sm font-medium text-link underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {t('home.team.leadView')}
      </AppLink>
    </div>
  );
}

/**
 * Open work nobody holds, per team queue (T-141). `stats` is the counts endpoint asked for
 * `assignee=unassigned` over the open statuses, so the numbers add up to the Unassigned tile. Each
 * count opens the queue filtered the same way.
 */
export function UnclaimedByQueue({
  query,
  names,
}: {
  query: UseQueryResult<TicketStats>;
  /** Queue names by id: the counts carry ids only. */
  names: ReadonlyMap<string, string>;
}) {
  const t = useT();
  if (query.isPending) return <ListSkeleton />;
  if (query.isError) return <CountsUnavailable onRetry={() => void query.refetch()} />;
  const groups = query.data.byQueue.filter((queue) => queue.open > 0);
  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('home.team.unclaimedEmpty')}</p>;
  }
  return (
    <ul className="flex flex-wrap gap-2">
      {groups.map((queue) => (
        <li key={queue.queueId ?? 'none'}>
          {queue.queueId ? (
            <CountLink
              href={queueHref({
                queueId: queue.queueId,
                assignee: 'unassigned',
                status: OPEN_STATUSES,
              })}
              label={names.get(queue.queueId) ?? t('home.unknownQueue')}
              count={queue.open}
            />
          ) : (
            // There is no queue-less filter in the API yet. Do not link this count to all unassigned work.
            <span className="inline-flex items-baseline gap-1.5 rounded-full bg-surface-muted px-3.5 py-1.5 text-sm">
              <span className="text-muted-foreground">{t('home.noQueue')}</span>
              <span className="tabular font-semibold">{queue.open}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
