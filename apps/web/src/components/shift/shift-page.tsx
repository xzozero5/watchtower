'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { HandoffIncomplete, ShiftStatus } from '@watchtower/shared';
import { Button, toast } from '@watchtower/ui';
import { CalendarCheck, ClipboardList, Clock3, LogIn, LogOut, StickyNote } from 'lucide-react';
import { useState } from 'react';

import { RequirePermission } from '@/components/admin/admin-page';
import { LoadError } from '@/components/admin/admin-page';
import { AppLink } from '@/components/app-link';
import { ClockInDialog, OverrideDialog } from '@/components/shift/clock-dialogs';
import { GateBlockers } from '@/components/shift/gate-blockers';
import { ShiftSection, ShiftSkeleton, useShiftFormat } from '@/components/shift/shift-bits';
import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { useSession, useUserId } from '@/lib/auth/session';
import {
  chipLabel,
  describeShiftError,
  gateFromError,
  gateSentence,
  gateSummary,
} from '@/lib/shifts/model';
import { shiftKeys, useShiftStatus } from '@/lib/shifts/queries';

export function ShiftPage() {
  return (
    <RequirePermission permission="shift.clock" role="lead">
      <ShiftBody />
    </RequirePermission>
  );
}

function ShiftBody() {
  const { t } = useI18n();
  const status = useShiftStatus();
  if (status.isPending) return <ShiftSkeleton />;
  if (status.isError) {
    return (
      <LoadError message={t('shift.common.loadError')} onRetry={() => void status.refetch()} />
    );
  }
  return <StatusView status={status.data} />;
}

function StatusView({ status }: { status: ShiftStatus }) {
  const { t, locale } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const format = useShiftFormat(status.timezone);
  const [clockInOpen, setClockInOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  // A refusal the api sent although the status said the gate was open (stale status): show it as the gate.
  const [refused, setRefused] = useState<{ gate: HandoffIncomplete; forNow: string } | null>(null);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const session = status.session;
  const open = session !== null && session.clockedOutAt === null;
  const gate = open
    ? (status.clockOutBlocked ?? (refused?.forNow === status.now ? refused.gate : null))
    : null;
  const summary = gate ? gateSummary(gate) : null;
  const blocked = summary !== null && !summary.open;
  const chip = chipLabel(status, t, locale);

  const clockOut = useMutation({
    mutationFn: (reason?: string) =>
      api.clockOut(reason === undefined ? {} : { override: { reason } }),
    onSuccess: async (result) => {
      setRefused(null);
      setOverrideOpen(false);
      setFailure(null);
      await queryClient.invalidateQueries({ queryKey: shiftKeys(userId).all });
      toast(result.overridden ? t('shift.clockOut.overridden') : t('shift.clockOut.done'));
    },
    onError: (error) => {
      const refusal = gateFromError(error);
      if (refusal) {
        setRefused({ gate: refusal, forNow: status.now });
        setOverrideError(null);
        setFailure(null);
        void queryClient.invalidateQueries({ queryKey: shiftKeys(userId).status });
        return;
      }
      const message = describeShiftError(error, t).message;
      setOverrideError(message);
      setFailure(message);
    },
  });

  const explainId = 'clock-out-explain';
  return (
    <>
      <ShiftSection
        id="status"
        title={t('shift.status.heading')}
        tone="green"
        icon={Clock3}
        actions={
          <span className="text-xs text-muted-foreground">
            {t('shift.status.timezone', { zone: status.timezone })}
          </span>
        }
      >
        <div className="flex flex-col gap-3 rounded-card bg-surface shadow-card p-4">
          <p
            data-testid="shift-chip-text"
            className={chip.warning ? 'text-base font-semibold' : 'text-base font-medium'}
          >
            {open ? t('shift.status.onHeading') : t('shift.status.offHeading')}
            <span className="sr-only"> — </span>
            <span className="ml-2 text-sm font-normal text-muted-foreground">{chip.text}</span>
          </p>
          {open ? (
            <ul className="flex flex-col gap-0.5 text-sm text-muted-foreground">
              <li>{t('shift.status.session', { time: format.time(session.clockedInAt) })}</li>
              <li>
                {session.onRoster && session.shiftName
                  ? t('shift.status.onRoster', {
                      name: session.shiftName,
                      range:
                        session.scheduledStart && session.scheduledEnd
                          ? `${format.time(session.scheduledStart)}–${format.time(session.scheduledEnd)}`
                          : '',
                    })
                  : t('shift.status.offRoster')}
              </li>
              {session.device ? (
                <li>{t('shift.status.device', { device: session.device })}</li>
              ) : null}
            </ul>
          ) : null}

          {!open ? (
            <div>
              <Button
                variant="primary"
                onClick={() => {
                  setClockInOpen(true);
                }}
              >
                <LogIn aria-hidden className="size-4" />
                {t('shift.clockIn.button')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  aria-disabled={blocked || clockOut.isPending ? true : undefined}
                  aria-describedby={blocked ? explainId : undefined}
                  onClick={() => {
                    if (blocked || clockOut.isPending) return;
                    clockOut.mutate(undefined);
                  }}
                >
                  <LogOut aria-hidden className="size-4" />
                  {clockOut.isPending ? t('shift.clockOut.pending') : t('shift.clockOut.button')}
                </Button>
                {blocked && can('roster.manage') ? (
                  <Button
                    onClick={() => {
                      setOverrideError(null);
                      setOverrideOpen(true);
                    }}
                  >
                    {t('shift.clockOut.override')}
                  </Button>
                ) : null}
              </div>
              {blocked && gate ? (
                <div id={explainId} className="flex flex-col gap-2">
                  <p className="text-sm font-medium">{gateSentence(gate, t)}</p>
                  <GateBlockers gate={gate} />
                  <div>
                    <Button asChild size="sm">
                      <AppLink href="/shift/handoff">{t('shift.clockOut.gateLinkHandoff')}</AppLink>
                    </Button>
                  </div>
                </div>
              ) : null}
              {failure ? (
                <p role="alert" className="text-sm font-medium text-danger">
                  {failure}
                </p>
              ) : null}
            </div>
          )}
        </div>
      </ShiftSection>

      {!open ? (
        <ShiftSection
          id="roster"
          title={t('shift.status.rosterHeading')}
          tone="indigo"
          icon={CalendarCheck}
        >
          {status.roster.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('shift.status.rosterEmpty')}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {status.roster.map((entry) => (
                <li key={entry.id}>
                  {t('shift.status.onRoster', {
                    name: entry.shiftName,
                    range: `${format.time(entry.startsAt)}–${format.time(entry.endsAt)}`,
                  })}{' '}
                  <span className="text-muted-foreground">({entry.workDate})</span>
                </li>
              ))}
            </ul>
          )}
        </ShiftSection>
      ) : null}

      <ul className="flex flex-wrap gap-2">
        <li>
          <Button asChild>
            <AppLink href="/shift/brief">
              <ClipboardList aria-hidden className="size-4" />
              {t('shift.status.goBrief')}
              {status.pendingAcks > 0 ? (
                <span className="tabular ml-1 rounded-full bg-surface-muted px-1.5">
                  {status.pendingAcks}
                  <span className="sr-only">
                    {' '}
                    — {t('shift.status.pendingAcks', { count: status.pendingAcks })}
                  </span>
                </span>
              ) : null}
            </AppLink>
          </Button>
        </li>
        {open && can('handoff.write') ? (
          <li>
            <Button asChild>
              <AppLink href="/shift/handoff">
                <CalendarCheck aria-hidden className="size-4" />
                {t('shift.status.goHandoff')}
              </AppLink>
            </Button>
          </li>
        ) : null}
        <li>
          <Button asChild>
            <AppLink href="/shift/notes">
              <StickyNote aria-hidden className="size-4" />
              {t('shift.status.goNotes')}
              {status.unreadNotes > 0 ? (
                <span className="tabular ml-1 rounded-full bg-surface-muted px-1.5">
                  {status.unreadNotes}
                  <span className="sr-only">
                    {' '}
                    — {t('shift.status.unreadNotes', { count: status.unreadNotes })}
                  </span>
                </span>
              ) : null}
            </AppLink>
          </Button>
        </li>
      </ul>

      <ClockInDialog open={clockInOpen} onOpenChange={setClockInOpen} status={status} />
      {overrideOpen ? (
        <OverrideDialog
          open
          onOpenChange={setOverrideOpen}
          title={t('shift.clockOut.overrideTitle')}
          description={t('shift.clockOut.overrideDescription')}
          pending={clockOut.isPending}
          error={overrideError}
          onSubmit={(reason) => {
            clockOut.mutate(reason);
          }}
        />
      ) : null}
    </>
  );
}
