'use client';

import { useI18n } from '@/i18n/provider';
import { formatPortalTime } from '@/lib/portal/portal-format';

/**
 * "What happens next", written out on the page rather than behind a hint. The expected first
 * response is shown only when the api gives one for the request; otherwise a plain sentence with
 * no number (nothing is invented).
 */
export function NextSteps({
  expectedFirstResponseAt,
  showTime = true,
}: {
  expectedFirstResponseAt: string | null;
  /** False when the page already shows the target itself. */
  showTime?: boolean;
}) {
  const { t, locale } = useI18n();
  return (
    <section aria-labelledby="portal-next-title" className="flex flex-col gap-2">
      <h2 id="portal-next-title" className="text-lg font-semibold">
        {t('portal.confirmation.nextTitle')}
      </h2>
      <ol className="list-decimal pl-5">
        <li>{t('portal.confirmation.nextReceived')}</li>
        <li>{t('portal.confirmation.nextReview')}</li>
        <li>{t('portal.confirmation.nextReply')}</li>
      </ol>
      {showTime ? (
        <p>
          {expectedFirstResponseAt
            ? t('portal.confirmation.expected', {
                time: formatPortalTime(expectedFirstResponseAt, locale),
              })
            : t('portal.confirmation.usuallyReply')}
        </p>
      ) : null}
    </section>
  );
}
