'use client';

import { buttonVariants, cn, EmptyState, Skeleton } from '@watchtower/ui';
import { CircleCheck } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useSyncExternalStore } from 'react';

import { useI18n } from '@/i18n/provider';
import { formatPortalTime } from '@/lib/portal/portal-format';
import { parseSubmitted, readSubmittedRaw } from '@/lib/portal/submitted-handoff';

const subscribe = () => () => undefined;

/**
 * "We received your request" (UI spec section 10): the ticket number, the masked address the
 * tracking link went to, and the first-response target from the SLA. The tracking link itself is
 * only in the email; it is never shown here.
 */
export function Confirmation() {
  const { t, locale } = useI18n();
  // undefined on the server and during hydration, then the stored answer (or null).
  const raw = useSyncExternalStore(subscribe, readSubmittedRaw, () => undefined);
  const result = useMemo(() => (raw === undefined ? undefined : parseSubmitted(raw)), [raw]);

  if (result === undefined) {
    return (
      <div role="status" className="flex flex-col gap-3">
        <span className="sr-only">{t('loading.label')}</span>
        <Skeleton className="h-8" />
        <Skeleton className="h-24" />
      </div>
    );
  }

  if (result === null) {
    return (
      <EmptyState
        title={t('portal.confirmation.missing')}
        action={
          <Link href="/portal" className={buttonVariants({ variant: 'primary' })}>
            {t('portal.confirmation.another')}
          </Link>
        }
      />
    );
  }

  return (
    <>
      <div className="flex items-start gap-3">
        <CircleCheck aria-hidden className="mt-1 size-6 shrink-0 text-success" />
        <h1 className="text-2xl font-semibold">
          {t('portal.received', { number: result.ticketKey })}
        </h1>
      </div>

      <dl className="rounded-2xl bg-surface p-pane ring-1 ring-border/60 ring-inset">
        <dt className="text-sm text-muted-foreground">{t('portal.confirmation.number')}</dt>
        <dd className="mt-0.5 font-mono text-xl font-semibold tabular-nums">{result.ticketKey}</dd>
      </dl>

      <div className="flex flex-col gap-2">
        <p>{t('portal.trackingSent', { email: result.maskedEmail })}</p>
        {result.expectedFirstResponseAt ? (
          <p>
            {t('portal.confirmation.expected', {
              time: formatPortalTime(result.expectedFirstResponseAt, locale),
            })}
          </p>
        ) : null}
        <p className="text-muted-foreground">{t('portal.confirmation.next')}</p>
        <p className="text-muted-foreground">{t('portal.confirmation.noEmail')}</p>
      </div>

      <Link
        href="/portal"
        className={cn(buttonVariants({ variant: 'secondary' }), 'w-full sm:w-auto sm:self-start')}
      >
        {t('portal.confirmation.another')}
      </Link>
    </>
  );
}
