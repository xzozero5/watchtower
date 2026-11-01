'use client';

import type { LineQuota } from '@watchtower/shared';
import { TintChip } from '@watchtower/ui';
import { CircleAlert, MessageCircle, TriangleAlert } from 'lucide-react';

import { useI18n } from '@/i18n/provider';
import { quotaFor } from '@/lib/outbound/queries';

type Account = NonNullable<ReturnType<typeof quotaFor>>;

const formatNumber = (value: number, locale: string) => value.toLocaleString(locale);

/**
 * How much of the monthly LINE push allowance is used (R-2.10), next to the send button of a LINE
 * reply. A chip with an icon and words (never colour alone) from the first message; from 80 % it
 * also says what to do, and when the allowance is gone it says a push will be refused and email is
 * the way (PRD section 8.3). If the api cannot say, nothing is shown: an unknown allowance is not
 * drawn as a full one.
 */
export function LineQuotaNote({ quota }: { quota: LineQuota | undefined }) {
  const { t, locale } = useI18n();
  const account: Account | null = quotaFor(quota);
  if (!account || account.level === 'unknown') return null;

  const used =
    account.limit === null
      ? t('outbound.quota.usedNoLimit', { used: formatNumber(account.used, locale) })
      : t('outbound.quota.used', {
          used: formatNumber(account.used, locale),
          limit: formatNumber(account.limit, locale),
        });
  const Icon =
    account.level === 'exhausted'
      ? CircleAlert
      : account.level === 'warn'
        ? TriangleAlert
        : MessageCircle;
  const tone = account.level === 'ok' ? 'green' : account.level === 'warn' ? 'amber' : 'orange';

  return (
    <div
      data-testid="line-quota"
      data-level={account.level}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted-foreground"
    >
      <TintChip tone={tone} icon={Icon} title={t('outbound.quota.label')}>
        {used}
      </TintChip>
      {account.level === 'warn' ? <p role="status">{t('outbound.quota.warn')}</p> : null}
      {account.level === 'exhausted' ? <p role="alert">{t('outbound.quota.exhausted')}</p> : null}
    </div>
  );
}
