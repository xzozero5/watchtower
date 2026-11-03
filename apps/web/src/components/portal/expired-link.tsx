'use client';

import { emailSchema } from '@watchtower/shared';
import { Alert, Button, buttonVariants, Input } from '@watchtower/ui';
import { Link2Off } from 'lucide-react';
import Link from 'next/link';
import { type SyntheticEvent, useId, useRef, useState } from 'react';

import type { MessageKey } from '@/i18n';
import { useI18n } from '@/i18n/provider';
import { classifyPortalError } from '@/lib/portal/portal-client';
import { formatWait } from '@/lib/portal/portal-format';
import { usePortalApi } from '@/lib/portal/use-portal';

import { describedBy, FormField } from './form-field';

type Errors = Partial<Record<'ticket' | 'email', MessageKey>>;

/**
 * "This link has expired" (UI spec section 10, R-9.2). The api answers a resend request with 202
 * whether or not the ticket and address match, so this page says only "If this matches our
 * records, we've sent a new link": it never confirms that an address has a ticket.
 */
export function ExpiredLink({ ticketKey }: { ticketKey: string }) {
  const { t, locale } = useI18n();
  const api = usePortalApi();
  const uid = useId();
  const ticketId = `${uid}-ticket`;
  const emailId = `${uid}-email`;
  const [ticket, setTicket] = useState(ticketKey);
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [failure, setFailure] = useState<{ key: MessageKey; wait: number | null } | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const onSubmit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (phase === 'sending') return;
    const nextErrors: Errors = {};
    if (ticket.trim().length < 3) nextErrors.ticket = 'portal.expired.errors.ticketRequired';
    if (email.trim() === '') nextErrors.email = 'portal.expired.errors.emailRequired';
    else if (!emailSchema.safeParse(email).success) {
      nextErrors.email = 'portal.expired.errors.emailInvalid';
    }
    setErrors(nextErrors);
    setFailure(null);
    if (Object.keys(nextErrors).length > 0) {
      document.getElementById(nextErrors.ticket ? ticketId : emailId)?.focus();
      return;
    }
    setPhase('sending');
    try {
      await api.resend({ ticketKey: ticket.trim(), email: emailSchema.parse(email) });
      setPhase('sent');
    } catch (error) {
      const classified = classifyPortalError(error);
      setPhase('idle');
      setFailure({
        key:
          classified.kind === 'rateLimited'
            ? 'portal.expired.errors.rateLimited'
            : classified.kind === 'network'
              ? 'portal.expired.errors.network'
              : 'portal.expired.errors.server',
        wait: classified.retryAfterSeconds,
      });
      alertRef.current?.focus();
    }
  };

  return (
    <>
      <div className="flex items-start gap-3">
        <Link2Off aria-hidden className="mt-1 size-6 shrink-0 text-muted-foreground" />
        <div>
          <h1 className="text-[1.7333rem] leading-tight font-light text-foreground-strong">
            {t('portal.expired.title')}
          </h1>
          <p className="mt-1 text-muted-foreground">{t('portal.linkExpired')}</p>
        </div>
      </div>

      {phase === 'sent' ? (
        <Alert tone="success" title={t('portal.expired.sent')}>
          {t('portal.expired.sentHint')}
        </Alert>
      ) : (
        <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
          <div ref={alertRef} tabIndex={-1} className="empty:hidden">
            {failure ? (
              <Alert
                tone="error"
                title={t(failure.key, { time: formatWait(failure.wait ?? 60, locale) })}
              />
            ) : null}
          </div>
          <FormField
            id={ticketId}
            label={t('portal.expired.ticket')}
            error={errors.ticket ? t(errors.ticket) : undefined}
          >
            <Input
              id={ticketId}
              name="ticket"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="font-mono"
              aria-invalid={errors.ticket ? true : undefined}
              aria-describedby={describedBy(ticketId, false, errors.ticket !== undefined)}
              value={ticket}
              onChange={(event) => {
                setTicket(event.target.value);
              }}
            />
          </FormField>
          <FormField
            id={emailId}
            label={t('portal.expired.email')}
            error={errors.email ? t(errors.email) : undefined}
          >
            <Input
              id={emailId}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={describedBy(emailId, false, errors.email !== undefined)}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          </FormField>
          <Button
            type="submit"
            variant="primary"
            className="w-full sm:w-auto sm:self-start"
            disabled={phase === 'sending'}
            aria-busy={phase === 'sending'}
          >
            {phase === 'sending' ? t('portal.expired.sending') : t('portal.expired.send')}
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
        {t('portal.expired.newRequest')}
      </Link>
    </>
  );
}
