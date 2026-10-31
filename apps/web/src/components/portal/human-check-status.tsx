'use client';

import { Alert, Button } from '@watchtower/ui';
import { CircleCheck, LoaderCircle } from 'lucide-react';

import { useI18n } from '@/i18n/provider';
import type { CheckState } from '@/lib/portal/human-check';
import { classifyPortalError } from '@/lib/portal/portal-client';
import { formatWait } from '@/lib/portal/portal-format';

/**
 * What the human check is doing, placed above the submit button. It is a status region, so a
 * screen reader hears "Checking you're human…" and then "Verified" without moving focus. The form
 * stays usable the whole time; only a failed check offers a button.
 */
export function HumanCheckStatus({ state, onRetry }: { state: CheckState; onRetry: () => void }) {
  const { t, locale } = useI18n();

  if (state.phase === 'failed') {
    const failure = classifyPortalError(state.error);
    const text =
      failure.kind === 'rateLimited'
        ? t('portal.verify.rateLimited', {
            time: formatWait(failure.retryAfterSeconds ?? 60, locale),
          })
        : t('portal.verifyFailed');
    return (
      <Alert tone="error" title={text}>
        <Button className="mt-2" onClick={onRetry}>
          {t('portal.verify.retry')}
        </Button>
      </Alert>
    );
  }

  if (state.phase === 'ready') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <CircleCheck aria-hidden className="size-4 text-success" />
        {t('portal.verify.done')}
      </p>
    );
  }

  const progress = state.phase === 'solving' ? state.progress : 0;
  return (
    <div role="status" className="flex flex-col gap-1.5 text-sm text-muted-foreground">
      <p className="flex items-center gap-2">
        <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
        {t('portal.verify.checking')}
      </p>
      <progress
        aria-label={t('portal.verify.progress')}
        max={1}
        value={progress}
        className="h-1.5 w-full accent-primary"
      />
    </div>
  );
}
