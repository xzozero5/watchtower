'use client';

import type { AiBudget } from '@watchtower/shared';
import { cn, Skeleton, TINT_CLASSES, type TintId, TintChip } from '@watchtower/ui';
import { CircleCheck, CircleStop, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { LoadError } from '@/components/admin/admin-page';
import { useI18n } from '@/i18n/provider';
import { useAiBudget } from '@/lib/admin/queries';
import { formatDateTime } from '@/lib/format';

const LEVELS: Readonly<Record<AiBudget['level'], { tone: TintId; icon: LucideIcon }>> = {
  ok: { tone: 'teal', icon: CircleCheck },
  alert: { tone: 'amber', icon: TriangleAlert },
  stop: { tone: 'red', icon: CircleStop },
};

const percentOf = (spent: number, cap: number) =>
  cap <= 0 ? 100 : Math.min(100, Math.round((spent / cap) * 100));

/**
 * What the app's own AI has spent today against the daily caps, what happens at the cap, and the
 * assistant's per-person use (T-142, PRD section 6.6). The level is a chip with an icon and words,
 * never colour alone.
 */
export function AiBudgetCard() {
  const { t } = useI18n();
  const budget = useAiBudget(true);
  return (
    <section aria-labelledby="ai-budget-title" className="px-4 pb-2">
      <div className="rounded-2xl bg-surface px-5 py-4 ring-1 ring-border/60 ring-inset">
        {budget.isPending ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">{t('admin.common.loading')}</span>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-10" />
          </div>
        ) : budget.isError ? (
          <LoadError
            message={t('admin.ai.budget.loadError')}
            onRetry={() => void budget.refetch()}
          />
        ) : (
          <BudgetBody budget={budget.data} />
        )}
      </div>
    </section>
  );
}

function BudgetBody({ budget }: { budget: AiBudget }) {
  const { t, locale } = useI18n();
  const number = new Intl.NumberFormat(locale);
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' });
  const level = LEVELS[budget.level];
  const meters = [
    {
      id: 'cost',
      label: t('admin.ai.budget.cost'),
      spent: budget.cost.spentUsd,
      cap: budget.cost.capUsd,
      text: t('admin.ai.budget.used', {
        spent: money.format(budget.cost.spentUsd),
        cap: money.format(budget.cost.capUsd),
      }),
    },
    {
      id: 'tokens',
      label: t('admin.ai.budget.tokens'),
      spent: budget.tokens.spent,
      cap: budget.tokens.cap,
      text: t('admin.ai.budget.used', {
        spent: number.format(budget.tokens.spent),
        cap: number.format(budget.tokens.cap),
      }),
    },
  ];
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ai-budget-title" className="text-sm font-semibold">
          {t('admin.ai.budget.title')}
        </h2>
        <TintChip tone={level.tone} icon={level.icon} strong={budget.level !== 'ok'}>
          {t(`admin.ai.budget.level.${budget.level}`)}
        </TintChip>
      </div>
      <ul className="mt-3 flex flex-col gap-3">
        {meters.map((meter) => {
          const percent = percentOf(meter.spent, meter.cap);
          return (
            <li key={meter.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <span className="font-medium">{meter.label}</span>
                <span className="tabular text-muted-foreground">
                  {meter.text} · {t('admin.ai.budget.percent', { percent })}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={meter.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={`${meter.text} · ${t('admin.ai.budget.percent', { percent })}`}
                className="mt-1 h-2 overflow-hidden rounded-full bg-surface-muted"
              >
                <div
                  className={cn('h-full bg-current', TINT_CLASSES[level.tone].icon)}
                  style={{ width: `${String(percent)}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 max-w-prose text-sm text-muted-foreground">
        {t('admin.ai.budget.whenReached')}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('admin.ai.budget.alertAt', { percent: budget.alertPercent })}{' '}
        {t('admin.ai.budget.resets', { time: formatDateTime(budget.resetsAt, locale) })}{' '}
        {t('admin.ai.budget.mockNote')}
      </p>

      <h3 className="mt-4 text-sm font-semibold">{t('admin.ai.budget.assistantTitle')}</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">
        {t('admin.ai.budget.assistantCap', {
          cap: number.format(budget.assistant.userDailyTokens),
        })}
      </p>
      {budget.assistant.users.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('admin.ai.budget.assistantNone')}</p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-border/60 text-sm">
          {budget.assistant.users.map((user) => (
            <li
              key={user.userId}
              className="flex flex-wrap items-center justify-between gap-2 py-1.5"
            >
              <span className="font-medium">{user.name}</span>
              <span className="flex items-center gap-2 tabular text-muted-foreground">
                {t('admin.ai.budget.assistantRow', {
                  tokens: number.format(user.tokens),
                  messages: number.format(user.messages),
                })}
                {user.tokens >= budget.assistant.userDailyTokens ? (
                  <TintChip tone="red" icon={CircleStop}>
                    {t('admin.ai.budget.assistantFull')}
                  </TintChip>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
