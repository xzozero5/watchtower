'use client';

import {
  buttonVariants,
  cn,
  EmptyState,
  HelpHint,
  IconButton,
  Skeleton,
  toast,
} from '@watchtower/ui';
import { CircleCheck, Copy } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useSyncExternalStore } from 'react';

import { useI18n } from '@/i18n/provider';
import { parseSubmitted, readSubmittedRaw } from '@/lib/portal/submitted-handoff';

import { NextSteps } from './next-steps';

const subscribe = () => () => undefined;

/**
 * "We received your request" (UI spec section 10): the ticket number, the masked address the
 * tracking link went to, and the first-response target from the SLA. The tracking link itself is
 * only in the email; it is never shown here.
 */
export function Confirmation() {
  const { t } = useI18n();
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

      <div className="flex items-center justify-between gap-3 rounded-2xl bg-surface p-pane ring-1 ring-border/60 ring-inset">
        <dl>
          <dt className="text-sm text-muted-foreground">{t('portal.confirmation.number')}</dt>
          <dd className="mt-0.5 font-mono text-3xl font-semibold tabular-nums">
            {result.ticketKey}
          </dd>
        </dl>
        <IconButton
          variant="secondary"
          label={t('portal.confirmation.copy')}
          icon={<Copy aria-hidden className="size-4" />}
          onClick={() => {
            void navigator.clipboard
              .writeText(result.ticketKey)
              .then(() => {
                toast(t('portal.confirmation.copied', { number: result.ticketKey }));
              })
              .catch(() => undefined);
          }}
        />
      </div>

      <div className="flex flex-col gap-2">
        <p>{t('portal.trackingSent', { email: result.maskedEmail })}</p>
        {/* What to do next and what to do without the email: one hint, not two paragraphs. */}
        <div className="flex">
          <HelpHint label={t('portal.confirmation.help')}>
            <p>{t('portal.confirmation.next')}</p>
            <p className="mt-2">{t('portal.confirmation.noEmail')}</p>
          </HelpHint>
        </div>
      </div>

      <NextSteps expectedFirstResponseAt={result.expectedFirstResponseAt} />

      <Link
        href="/portal"
        className={cn(buttonVariants({ variant: 'secondary' }), 'w-full sm:w-auto sm:self-start')}
      >
        {t('portal.confirmation.another')}
      </Link>
    </>
  );
}
