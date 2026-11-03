'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PortalReplyResult, PortalTicketView } from '@watchtower/shared';
import { Alert, Button, buttonVariants, Skeleton } from '@watchtower/ui';
import Link from 'next/link';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { useI18n } from '@/i18n/provider';
import { classifyPortalError } from '@/lib/portal/portal-client';
import { formatPortalTime, formatWait } from '@/lib/portal/portal-format';
import {
  claimedToken,
  claimIntoStore,
  dropFromStore,
  subscribeToClaims,
} from '@/lib/portal/tracking-token';
import { usePortalApi } from '@/lib/portal/use-portal';

import { CustomerStatusLabel } from './customer-status-label';
import { ExpiredLink } from './expired-link';
import { NextSteps } from './next-steps';
import { ReplyForm, withReply } from './reply-form';
import { PortalTimeline } from './timeline';

/**
 * The token of this ticket for this tab. `undefined` until the browser has been asked (the server
 * cannot read the address-bar fragment), then the token or `null` when the tab has none.
 */
function useTrackingToken(ticketKey: string): [string | null | undefined, () => void] {
  const token = useSyncExternalStore(
    subscribeToClaims,
    () => claimedToken(ticketKey),
    () => undefined,
  );
  useEffect(() => {
    // Reads the fragment, removes it from the address bar and keeps the token for this tab only.
    claimIntoStore(ticketKey);
  }, [ticketKey]);
  const drop = useCallback(() => {
    dropFromStore(ticketKey);
  }, [ticketKey]);
  return [token, drop];
}

function Loading() {
  const { t } = useI18n();
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="sr-only">{t('portal.tracking.loading')}</span>
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-24" />
      <Skeleton className="h-24" />
    </div>
  );
}

function TicketView({
  view,
  ticketKey,
  token,
  onReplied,
  onInvalidLink,
  onNotOpen,
}: {
  view: PortalTicketView;
  ticketKey: string;
  token: string;
  onReplied: (result: PortalReplyResult) => void;
  onInvalidLink: () => void;
  onNotOpen: () => void;
}) {
  const { t, locale } = useI18n();
  const merged = view.status === 'merged' && view.mergedIntoKey !== null;
  const waitingForTeam = view.status === 'received' && view.expectedFirstResponseAt !== null;

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-[1.7333rem] leading-tight font-light text-foreground-strong">
          <span className="font-mono tabular-nums">{view.key}</span>
        </h1>
        <p className="text-lg">{view.subject}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <CustomerStatusLabel
            status={view.status}
            mergedInto={view.mergedIntoKey}
            className="text-sm"
          />
          <span className="text-sm text-muted-foreground tabular-nums">
            {t('portal.tracking.opened', { date: formatPortalTime(view.createdAt, locale) })}
          </span>
          <span className="text-sm text-muted-foreground tabular-nums">
            {t('portal.tracking.updated', { date: formatPortalTime(view.updatedAt, locale) })}
          </span>
        </div>
        {waitingForTeam && view.expectedFirstResponseAt ? (
          <p>
            {t('portal.tracking.expected', {
              time: formatPortalTime(view.expectedFirstResponseAt, locale),
            })}
          </p>
        ) : null}
      </div>

      {view.status === 'received' ? (
        <NextSteps expectedFirstResponseAt={null} showTime={!waitingForTeam} />
      ) : null}

      {merged && view.mergedIntoKey ? (
        <Alert tone="info" title={t('portal.status.mergedInto', { key: view.mergedIntoKey })}>
          <p>{t('portal.tracking.mergedBody', { key: view.mergedIntoKey })}</p>
          <Link
            href={`/portal/tickets/${encodeURIComponent(view.mergedIntoKey)}`}
            className="mt-1 inline-block font-medium text-link underline underline-offset-2"
          >
            {t('portal.tracking.mergedLink', { key: view.mergedIntoKey })}
          </Link>
        </Alert>
      ) : null}

      <section aria-labelledby="portal-timeline-title" className="flex flex-col gap-2">
        <h2 id="portal-timeline-title" className="text-lg font-semibold">
          {t('portal.tracking.timeline')}
        </h2>
        <PortalTimeline entries={view.timeline} truncated={view.truncated} />
      </section>

      {view.canReply ? (
        <section aria-labelledby="portal-reply-title" className="flex flex-col gap-2">
          <h2 id="portal-reply-title" className="text-lg font-semibold">
            {t('portal.tracking.replyTitle')}
          </h2>
          <ReplyForm
            ticketKey={ticketKey}
            token={token}
            onSent={onReplied}
            onInvalidLink={onInvalidLink}
            onNotOpen={onNotOpen}
          />
        </section>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-muted-foreground">{t('portal.tracking.cannotReply')}</p>
          <Link href="/portal" className={buttonVariants({ variant: 'secondary' })}>
            {t('portal.tracking.submitNew')}
          </Link>
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        {t('portal.tracking.accessUntil', {
          date: formatPortalTime(view.accessExpiresAt, locale),
        })}
      </p>
    </>
  );
}

/**
 * The tracking page of a signed link (R-9.2). The link carries the token in the fragment; this
 * page takes it out of the address bar, keeps it for this tab only and sends it as
 * `X-Portal-Token`. Any refusal of the token shows "This link has expired" with the resend form.
 */
export function TrackingPage({ ticketKey }: { ticketKey: string }) {
  const { t, locale } = useI18n();
  const api = usePortalApi();
  const queryClient = useQueryClient();
  const [token, dropToken] = useTrackingToken(ticketKey);
  const queryKey = ['portal-ticket', ticketKey] as const;

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => {
      if (typeof token !== 'string') throw new Error('no token');
      return api.ticket(ticketKey, token, signal);
    },
    enabled: typeof token === 'string',
    retry: false,
    gcTime: 0,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });

  const failure = query.isError ? classifyPortalError(query.error) : null;
  const linkRefused = failure?.kind === 'invalidLink';
  useEffect(() => {
    if (linkRefused) dropToken();
  }, [linkRefused, dropToken]);

  if (token === undefined) return <Loading />;
  if (token === null || linkRefused) return <ExpiredLink ticketKey={ticketKey} />;

  if (query.isError && failure) {
    const key =
      failure.kind === 'rateLimited'
        ? 'portal.tracking.errors.rateLimited'
        : failure.kind === 'network'
          ? 'portal.tracking.errors.network'
          : 'portal.tracking.errors.server';
    return (
      <Alert
        tone="error"
        title={t(key, { time: formatWait(failure.retryAfterSeconds ?? 60, locale) })}
      >
        <Button
          className="mt-2"
          onClick={() => {
            void query.refetch();
          }}
        >
          {t('portal.tracking.retry')}
        </Button>
      </Alert>
    );
  }

  if (!query.data) return <Loading />;

  return (
    <TicketView
      view={query.data}
      ticketKey={ticketKey}
      token={token}
      onReplied={(result) => {
        queryClient.setQueryData<PortalTicketView>(queryKey, (current) =>
          current ? withReply(current, result) : current,
        );
        void queryClient.invalidateQueries({ queryKey });
      }}
      onInvalidLink={dropToken}
      onNotOpen={() => {
        void queryClient.invalidateQueries({ queryKey });
      }}
    />
  );
}
