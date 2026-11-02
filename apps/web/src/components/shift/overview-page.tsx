'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ShiftOverview, ShiftSession } from '@watchtower/shared';
import { Button, TintChip, toast } from '@watchtower/ui';
import {
  CircleAlert,
  MessageCircleQuestion,
  RefreshCw,
  TriangleAlert,
  UserRoundX,
  Users,
} from 'lucide-react';
import { useState } from 'react';

import { AccessDenied, LoadError } from '@/components/admin/admin-page';
import { AppLink } from '@/components/app-link';
import { OverrideDialog } from '@/components/shift/clock-dialogs';
import {
  EmptyLine,
  PriorityBadge,
  ShiftSection,
  ShiftSkeleton,
  TicketLink,
  useShiftFormat,
} from '@/components/shift/shift-bits';
import { RelativeTime } from '@/components/relative-time';
import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { useSession, useUserId } from '@/lib/auth/session';
import { describeShiftError, gateFromError } from '@/lib/shifts/model';
import { shiftKeys, useShiftOverview } from '@/lib/shifts/queries';

export function OverviewPage() {
  const { can } = useSession();
  if (!can('roster.manage') && !can('performance.read.all')) return <AccessDenied role="lead" />;
  return <OverviewBody />;
}

function OverviewBody() {
  const { t } = useI18n();
  const overview = useShiftOverview();
  if (overview.isPending) return <ShiftSkeleton rows={6} />;
  if (overview.isError) {
    return (
      <LoadError message={t('shift.common.loadError')} onRetry={() => void overview.refetch()} />
    );
  }
  return <OverviewView data={overview.data} onRefresh={() => void overview.refetch()} />;
}

function OverviewView({ data, onRefresh }: { data: ShiftOverview; onRefresh: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const format = useShiftFormat(data.timezone);
  const [target, setTarget] = useState<ShiftSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clockOut = useMutation({
    mutationFn: ({ session, reason }: { session: ShiftSession; reason: string }) =>
      api.clockOut({ userId: session.userId, override: { reason } }),
    onSuccess: async () => {
      setTarget(null);
      await queryClient.invalidateQueries({ queryKey: shiftKeys(userId).all });
      toast(t('shift.clockOut.done'));
    },
    onError: (failure) => {
      setError(
        gateFromError(failure)
          ? t('shift.clockOut.refusedTitle')
          : describeShiftError(failure, t).message,
      );
    },
  });

  const unack = data.unacknowledged;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{t('shift.overview.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {t('shift.overview.updated', { time: format.time(data.generatedAt) })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onRefresh}>
            <RefreshCw aria-hidden className="size-4" />
            {t('shift.overview.refresh')}
          </Button>
          {can('roster.manage') ? (
            <Button asChild>
              <AppLink href="/admin/shifts">{t('shift.overview.rosterLink')}</AppLink>
            </Button>
          ) : null}
        </div>
      </div>

      <ShiftSection
        id="overview-unack"
        title={t('shift.overview.unacknowledged')}
        tone="indigo"
        icon={CircleAlert}
        actions={
          <span className="flex items-center gap-2 text-sm" data-testid="unack-summary">
            <span className="tabular font-semibold">
              {unack.count === 0
                ? t('shift.overview.unacknowledgedZero')
                : t('shift.overview.unacknowledgedCount', { count: unack.count })}
            </span>
            {unack.overdue > 0 ? (
              <TintChip tone="red" icon={TriangleAlert} strong>
                {t('shift.overview.overdue', { count: unack.overdue })}
              </TintChip>
            ) : null}
          </span>
        }
      >
        {unack.items.length === 0 ? (
          <EmptyLine>{t('shift.overview.unacknowledgedEmpty')}</EmptyLine>
        ) : (
          <ul className="flex flex-col gap-2">
            {unack.items.map((item) => (
              <li
                key={item.itemId}
                data-overdue={item.overdue ? 'true' : undefined}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-inner bg-surface px-3.5 py-2.5 shadow-card text-sm"
              >
                {item.ticketKey ? <TicketLink ticketKey={item.ticketKey} /> : null}
                <span className="min-w-0 flex-1">
                  {t('shift.overview.itemLine', {
                    title: item.title,
                    name: item.from.name,
                    time: format.dateTime(item.confirmedAt),
                  })}
                </span>
                {item.overdue ? (
                  <span title={t('shift.overview.overdueHint')}>
                    <TintChip tone="red" icon={TriangleAlert} strong>
                      {t('shift.overview.overdueFlag')}
                    </TintChip>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </ShiftSection>

      <ShiftSection
        id="overview-questions"
        title={t('shift.overview.questions')}
        count={data.questions.items.length}
        tone="amber"
        icon={MessageCircleQuestion}
        actions={
          data.questions.overdue > 0 ? (
            <TintChip tone="red" icon={TriangleAlert} strong>
              {t('shift.overview.overdue', { count: data.questions.overdue })}
            </TintChip>
          ) : undefined
        }
      >
        {data.questions.items.length === 0 ? (
          <EmptyLine>{t('shift.overview.questionsEmpty')}</EmptyLine>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.questions.items.map((item) => (
              <li
                key={item.itemId}
                data-overdue={item.overdue ? 'true' : undefined}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-inner bg-surface px-3.5 py-2.5 shadow-card text-sm"
              >
                <TicketLink ticketKey={item.ticketKey} />
                <PriorityBadge priority={item.priority} />
                <span className="min-w-0 flex-1">
                  {item.title} ·{' '}
                  {t('shift.overview.questionLine', {
                    key: item.ticketKey,
                    name: item.askedBy?.name ?? t('shift.overview.questionNobody'),
                    time: format.dateTime(item.askedAt),
                  })}
                </span>
                {item.overdue ? (
                  <TintChip tone="red" icon={TriangleAlert} strong>
                    {t('shift.overview.overdueFlag')}
                  </TintChip>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {data.openQuestions > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('shift.overview.openQuestions', { count: data.openQuestions })}
          </p>
        ) : null}
      </ShiftSection>

      <ShiftSection
        id="overview-on-shift"
        title={t('shift.overview.onShift')}
        count={data.onShift.length}
        tone="green"
        icon={Users}
      >
        {data.onShift.length === 0 ? (
          <EmptyLine>{t('shift.overview.onShiftEmpty')}</EmptyLine>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.onShift.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-inner bg-surface px-3.5 py-2.5 shadow-card text-sm"
              >
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
                {can('roster.manage') ? (
                  <Button
                    size="sm"
                    className="ml-auto"
                    aria-label={t('shift.overview.clockOutFor', { name: session.userName })}
                    onClick={() => {
                      setError(null);
                      setTarget(session);
                    }}
                  >
                    {t('shift.clockOut.button')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </ShiftSection>

      <ShiftSection
        id="overview-no-shows"
        title={t('shift.overview.noShows')}
        count={data.noShows.length}
        tone="red"
        icon={UserRoundX}
      >
        {data.noShows.length === 0 ? (
          <EmptyLine>{t('shift.overview.noShowsEmpty')}</EmptyLine>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.noShows.map((entry) => (
              <li
                key={entry.id}
                className="rounded-inner bg-surface px-3.5 py-2.5 shadow-card text-sm"
              >
                {t('shift.overview.noShowLine', {
                  name: entry.userName,
                  shift: entry.shiftName,
                  time: format.time(entry.startsAt),
                })}{' '}
                <span className="text-muted-foreground">
                  (<RelativeTime iso={entry.startsAt} />)
                </span>
              </li>
            ))}
          </ul>
        )}
      </ShiftSection>

      {target ? (
        <OverrideDialog
          open
          onOpenChange={(open) => {
            if (!open) setTarget(null);
          }}
          title={t('shift.clockOut.overrideTitleFor', { name: target.userName })}
          description={t('shift.clockOut.overrideDescriptionFor')}
          pending={clockOut.isPending}
          error={error}
          onSubmit={(reason) => {
            clockOut.mutate({ session: target, reason });
          }}
        />
      ) : null}
    </>
  );
}
