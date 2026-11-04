'use client';

import { emailSchema, type PortalMyRequestsView, type PortalLocale } from '@watchtower/shared';
import { Alert, Button, buttonVariants, Input, Skeleton } from '@watchtower/ui';
import { ListChecks } from 'lucide-react';
import Link from 'next/link';
import { type SyntheticEvent, useEffect, useId, useRef, useState } from 'react';

import type { MessageKey } from '@/i18n';
import { useI18n } from '@/i18n/provider';
import { forgetOpenedList, keepOpenedList, loadOpenedList } from '@/lib/portal/my-requests-store';
import { PowRefusedError } from '@/lib/portal/pow-core';
import { classifyPortalError, type PortalClient } from '@/lib/portal/portal-client';
import { formatPortalTime, formatWait } from '@/lib/portal/portal-format';
import { parseFragmentToken, stripFragment } from '@/lib/portal/tracking-token';
import { useHumanCheck, usePortalApi } from '@/lib/portal/use-portal';

import { CustomerStatusLabel } from './customer-status-label';
import { describedBy, FormField } from './form-field';
import { HumanCheckStatus } from './human-check-status';

/** What the page is showing. `opening` while the one-time link is being spent. */
type Phase =
  | { kind: 'deciding' }
  | { kind: 'opening' }
  | { kind: 'list'; view: PortalMyRequestsView }
  | { kind: 'form'; invalidLink: boolean };

let opening: { token: string; promise: Promise<PortalMyRequestsView> } | null = null;

/** Tests only: start from a page that has opened nothing. */
export function resetMyRequestsOpening(): void {
  opening = null;
}

/** One request per token for this page load, however many times the effect runs. */
function openOnce(api: PortalClient, token: string): Promise<PortalMyRequestsView> {
  if (opening?.token !== token) opening = { token, promise: api.openMyRequests(token) };
  return opening.promise;
}

/**
 * "My requests" (T-152, PRD R-9.4 for people without an account). Three states in one route:
 * the request form (an address, the same human check as the submit form), the opening of the
 * one-time link from the email (`#token=...`, read once, removed from the address bar, sent in a
 * header), and the read-only list. The form's answer is the same whether or not the address is
 * known: it never says whether we have requests for it.
 */
export function MyRequestsPage() {
  const api = usePortalApi();
  const [phase, setPhase] = useState<Phase>({ kind: 'deciding' });

  useEffect(() => {
    const fromLink = parseFragmentToken(window.location.hash);
    if (window.location.hash !== '') stripFragment(window);
    // The second run of the effect in development finds the fragment already removed: the request
    // the first run started is the one to wait for.
    const token = fromLink ?? opening?.token ?? null;
    let live = true;
    if (token === null) {
      // The address bar and this tab's storage are outside React: read them, then show the result.
      const kept = loadOpenedList();
      queueMicrotask(() => {
        if (live)
          setPhase(kept ? { kind: 'list', view: kept } : { kind: 'form', invalidLink: false });
      });
      return () => {
        live = false;
      };
    }
    // The link works once and is never cancelled mid-flight: React runs this effect twice in
    // development, and both runs must share the one request instead of spending the link twice.
    openOnce(api, token).then(
      (view) => {
        if (!live) return;
        keepOpenedList(view);
        setPhase({ kind: 'list', view });
      },
      () => {
        if (live) setPhase({ kind: 'form', invalidLink: true });
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  if (phase.kind === 'deciding' || phase.kind === 'opening') return <Opening />;
  if (phase.kind === 'list') {
    return (
      <RequestList
        view={phase.view}
        onLeave={() => {
          forgetOpenedList();
          opening = null;
          setPhase({ kind: 'form', invalidLink: false });
        }}
      />
    );
  }
  return <RequestForm invalidLink={phase.invalidLink} />;
}

function Opening() {
  const { t } = useI18n();
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="sr-only">{t('portal.myRequests.opening')}</span>
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
    </div>
  );
}

function RequestList({ view, onLeave }: { view: PortalMyRequestsView; onLeave: () => void }) {
  const { t, locale } = useI18n();
  return (
    <>
      <div className="flex items-start gap-3">
        <ListChecks aria-hidden className="mt-1 size-6 shrink-0 text-muted-foreground" />
        <div>
          <h1 className="text-[1.7333rem] leading-tight font-light text-foreground-strong">
            {t('portal.myRequests.title')}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {t('portal.myRequests.listFor', { email: view.maskedEmail })}
          </p>
        </div>
      </div>

      {view.items.length === 0 ? (
        <p>{t('portal.myRequests.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('portal.myRequests.title')}>
          {view.items.map((item) => (
            <li
              key={item.key}
              className="flex flex-col gap-1 rounded-xl bg-surface px-3 py-2.5 ring-1 ring-border-strong ring-inset"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  href={`/portal/tickets/${encodeURIComponent(item.key)}`}
                  aria-label={t('portal.myRequests.open', { key: item.key })}
                  className="font-mono text-link underline underline-offset-2 tabular-nums"
                >
                  {item.key}
                </Link>
                <CustomerStatusLabel status={item.status} className="text-sm" />
              </div>
              <p className="break-words">{item.subject}</p>
              <p className="text-sm text-muted-foreground tabular-nums">
                {t('portal.myRequests.updated', { date: formatPortalTime(item.updatedAt, locale) })}
                {item.status === 'closed' ? ` · ${t('portal.myRequests.closedHint')}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
      {view.truncated ? (
        <p className="text-sm text-muted-foreground">
          {t('portal.myRequests.truncated', { count: String(view.items.length) })}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">{t('portal.myRequests.readOnly')}</p>

      <div className="flex flex-wrap gap-2">
        <Button onClick={onLeave}>{t('portal.myRequests.leave')}</Button>
        <Link
          href="/portal"
          className={buttonVariants({ variant: 'ghost', className: 'w-full sm:w-auto' })}
        >
          {t('portal.myRequests.newRequest')}
        </Link>
      </div>
    </>
  );
}

type FailureKey = 'verification' | 'rateLimited' | 'network' | 'server';
const FAILURE_KEYS: Record<FailureKey, MessageKey> = {
  verification: 'portal.myRequests.errors.verification',
  rateLimited: 'portal.myRequests.errors.rateLimited',
  network: 'portal.myRequests.errors.network',
  server: 'portal.myRequests.errors.server',
};

function RequestForm({ invalidLink }: { invalidLink: boolean }) {
  const { t, locale } = useI18n();
  const api = usePortalApi();
  const { check, state: checkState } = useHumanCheck(api);
  const uid = useId();
  const emailId = `${uid}-email`;
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [error, setError] = useState<MessageKey | null>(null);
  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [failure, setFailure] = useState<{ key: FailureKey; wait: number | null } | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const portalLocale: PortalLocale = locale;

  const onSubmit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (phase === 'sending') return;
    setFailure(null);
    const trimmed = email.trim();
    const nextError: MessageKey | null =
      trimmed === ''
        ? 'portal.myRequests.errors.emailRequired'
        : !emailSchema.safeParse(trimmed).success
          ? 'portal.myRequests.errors.emailInvalid'
          : null;
    setError(nextError);
    if (nextError !== null) {
      document.getElementById(emailId)?.focus();
      return;
    }
    setPhase('sending');
    try {
      const verification = await check.getProof();
      await api.requestMyRequests({
        email: emailSchema.parse(trimmed),
        locale: portalLocale,
        ...(website === '' ? {} : { website }),
        verification,
      });
      setPhase('sent');
    } catch (caught) {
      setPhase('idle');
      const classified = classifyPortalError(caught);
      const key: FailureKey =
        caught instanceof PowRefusedError || classified.kind === 'verification'
          ? 'verification'
          : classified.kind === 'rateLimited'
            ? 'rateLimited'
            : classified.kind === 'network'
              ? 'network'
              : 'server';
      // A challenge works once: after a refusal or a limit the next try needs a new one.
      if (key === 'verification' || key === 'rateLimited') check.restart();
      setFailure({ key, wait: classified.retryAfterSeconds });
      alertRef.current?.focus();
    }
  };

  return (
    <>
      <div className="flex items-start gap-3">
        <ListChecks aria-hidden className="mt-1 size-6 shrink-0 text-muted-foreground" />
        <div>
          <h1 className="text-[1.7333rem] leading-tight font-light text-foreground-strong">
            {invalidLink ? t('portal.myRequests.invalidTitle') : t('portal.myRequests.title')}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {invalidLink ? t('portal.myRequests.invalidHint') : t('portal.myRequests.lead')}
          </p>
        </div>
      </div>

      {phase === 'sent' ? (
        <Alert tone="success" title={t('portal.myRequests.sent')}>
          {t('portal.myRequests.sentHint')}
        </Alert>
      ) : (
        <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
          <div ref={alertRef} tabIndex={-1} className="empty:hidden">
            {failure ? (
              <Alert
                tone="error"
                title={t(FAILURE_KEYS[failure.key], {
                  time: formatWait(failure.wait ?? 60, locale),
                })}
              />
            ) : null}
          </div>
          <FormField
            id={emailId}
            label={t('portal.myRequests.email')}
            error={error ? t(error) : undefined}
          >
            <Input
              id={emailId}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy(emailId, false, error !== null)}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setError(null);
              }}
            />
          </FormField>

          {/* Honeypot: invisible and unreachable for people, tempting for form-filling bots. */}
          <div aria-hidden="true" className="sr-only" data-testid="portal-honeypot">
            <label>
              Website
              <input
                type="text"
                name="website"
                tabIndex={-1}
                autoComplete="off"
                value={website}
                onChange={(event) => {
                  setWebsite(event.target.value);
                }}
              />
            </label>
          </div>

          <HumanCheckStatus
            state={checkState}
            onRetry={() => {
              check.restart();
            }}
          />

          <Button
            type="submit"
            variant="primary"
            className="w-full sm:w-auto sm:self-start"
            disabled={phase === 'sending'}
            aria-busy={phase === 'sending'}
          >
            {phase === 'sending' ? t('portal.myRequests.sending') : t('portal.myRequests.send')}
          </Button>
        </form>
      )}

      <Link
        href="/portal"
        className={buttonVariants({
          variant: 'ghost',
          className: 'w-full sm:w-auto sm:self-start',
        })}
      >
        {t('portal.myRequests.newRequest')}
      </Link>
    </>
  );
}
