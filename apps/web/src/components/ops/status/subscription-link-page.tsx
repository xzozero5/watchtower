'use client';

import { Alert, Button } from '@watchtower/ui';
import { useEffect, useState } from 'react';

import NotFoundPage from '@/app/not-found';
import { useI18n } from '@/i18n/provider';
import { parseSubscriptionFragment } from '@/lib/ops/model';
import { formatWait } from '@/lib/portal/portal-format';
import { classifyStatusError } from '@/lib/status/status-client';
import { useStatusApi } from '@/lib/status/use-status';

type Phase =
  | { readonly name: 'reading' }
  | { readonly name: 'ready'; readonly token: string }
  | { readonly name: 'working'; readonly token: string }
  | { readonly name: 'done' }
  | { readonly name: 'invalid' }
  | { readonly name: 'closed' }
  | { readonly name: 'failed'; readonly token: string; readonly message: string };

/**
 * `/status/confirm` and `/status/unsubscribe` (R-6.2). The email link carries a signed token in
 * the URL fragment, which no server sees. The page takes it out of the address bar, shows what it is
 * about to do, and only a button press sends it (a mail scanner that opens every link in an email
 * subscribes or unsubscribes nobody). Link invalid or expired: one plain sentence, the same for
 * every cause. The page switched off: the not-found page.
 */
export function SubscriptionLinkPage({ mode }: { mode: 'confirm' | 'unsubscribe' }) {
  const { t, locale } = useI18n();
  const api = useStatusApi();
  const [phase, setPhase] = useState<Phase>({ name: 'reading' });

  useEffect(() => {
    const token = parseSubscriptionFragment(window.location.hash);
    if (token !== null) window.history.replaceState(null, '', window.location.pathname);
    // Every state change happens after a promise settles, never synchronously in the effect.
    void Promise.resolve().then(() => {
      setPhase(token === null ? { name: 'invalid' } : { name: 'ready', token });
    });
  }, []);

  const send = (token: string) => {
    setPhase({ name: 'working', token });
    const run = mode === 'confirm' ? api.confirm(token) : api.unsubscribe(token);
    run.then(
      () => {
        setPhase({ name: 'done' });
      },
      (error: unknown) => {
        const failure = classifyStatusError(error);
        if (failure.kind === 'closed') setPhase({ name: 'closed' });
        else if (failure.kind === 'invalidLink' || failure.kind === 'validation') {
          setPhase({ name: 'invalid' });
        } else {
          setPhase({
            name: 'failed',
            token,
            message:
              failure.kind === 'rateLimited'
                ? t('ops.status.link.rateLimited', {
                    wait: formatWait(failure.retryAfterSeconds ?? 60, locale),
                  })
                : failure.kind === 'network'
                  ? t('ops.status.link.network')
                  : t('ops.status.link.failed'),
          });
        }
      },
    );
  };

  if (phase.name === 'closed') return <NotFoundPage />;
  const prefix = `ops.status.link.${mode}` as const;
  return (
    <section aria-labelledby="link-heading" className="flex flex-col gap-3">
      <h1 id="link-heading" className="text-lg font-semibold">
        {t(`${prefix}.title`)}
      </h1>
      {phase.name === 'reading' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('ops.status.loading')}
        </p>
      ) : phase.name === 'done' ? (
        <Alert tone="success" title={t(`${prefix}.done`)}>
          {t(`${prefix}.doneBody`)}
        </Alert>
      ) : phase.name === 'invalid' ? (
        <Alert tone="error" title={t('ops.status.link.invalid')}>
          {t('ops.status.link.invalidBody')}
        </Alert>
      ) : (
        <>
          <p className="text-sm">{t(`${prefix}.body`)}</p>
          {phase.name === 'failed' ? <Alert tone="error" title={phase.message} /> : null}
          <div>
            <Button
              variant="primary"
              disabled={phase.name === 'working'}
              onClick={() => {
                send(phase.token);
              }}
            >
              {phase.name === 'working' ? t('ops.common.saving') : t(`${prefix}.button`)}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
