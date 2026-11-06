'use client';

import { AskAiElement } from '@/components/assistant/ask-ai-element';

import type { IntentGradeMetrics, ResolutionClass } from '@watchtower/shared';
import {
  BarList,
  type BarListDatum,
  Card,
  EmptyState,
  HelpHint,
  Skeleton,
  TintChip,
} from '@watchtower/ui';
import { ClipboardCheck } from 'lucide-react';

import { LoadError } from '@/components/admin/admin-page';
import { CLASS_LOOK } from '@/components/ai/ai-grade';
import { useSession } from '@/lib/auth/session';
import { useI18n } from '@/i18n/provider';
import { useIntentGradeMetrics } from '@/lib/ai/grade-queries';
import { humanizeKey } from '@/lib/ai/prose';
import { formatCount, formatRate, formatScore } from '@/lib/dashboard/format';

import { DashboardSection } from './figure';

const CLASSES = ['verified', 'contained', 'assumed'] as const satisfies readonly ResolutionClass[];

/** The bar colour of each class: an icon-tint token, so the theme owns the hue. Icon and words repeat it. */
const CLASS_COLOR: Record<ResolutionClass, string> = {
  verified: 'var(--wt-color-tint-green-icon)',
  contained: 'var(--wt-color-tint-sky-icon)',
  assumed: 'var(--wt-color-tint-amber-icon)',
};

function IntentCard({ row }: { row: IntentGradeMetrics }) {
  const { t, locale } = useI18n();
  const count = (n: number) => formatCount(n, locale);
  const intent =
    row.intentKey === null ? t('grade.dashboard.noIntent') : humanizeKey(row.intentKey);
  const rates: Record<ResolutionClass, number> = {
    verified: row.verifiedRate,
    contained: row.containedRate,
    assumed: row.assumedRate,
  };
  const data: BarListDatum[] = CLASSES.map((cls) => {
    const Icon = CLASS_LOOK[cls].icon;
    const name = t('grade.dashboard.share', {
      name: t(`grade.class.${cls}`),
      percent: formatRate(rates[cls], locale),
    });
    return {
      key: cls,
      label: (
        <span className="inline-flex items-center gap-1.5" title={t(`grade.classTip.${cls}`)}>
          <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span>{name}</span>
        </span>
      ),
      name,
      value: row[cls],
      color: CLASS_COLOR[cls],
    };
  });
  const facts = [
    t('grade.dashboard.graded', { count: count(row.graded) }),
    row.avgDraftQuality === null
      ? t('grade.dashboard.qualityNone')
      : t('grade.dashboard.quality', { value: formatRate(row.avgDraftQuality, locale) }),
    t('grade.dashboard.violations', { count: count(row.policyViolations) }),
    t('grade.dashboard.kbGaps', { count: count(row.kbGaps) }),
    t('grade.dashboard.reopened', { count: count(row.reopened) }),
    row.csatAvg === null
      ? t('grade.dashboard.csatNone')
      : t('grade.dashboard.csat', { value: formatScore(row.csatAvg, locale) }),
  ];
  return (
    <Card as="article" aria-label={intent} className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-foreground-strong">{intent}</h3>
        {row.mock ? (
          <TintChip tone="slate" title={t('grade.demoTip')}>
            {t('grade.dashboard.demo')}
          </TintChip>
        ) : null}
      </div>
      <BarList
        data={data}
        title={t('grade.dashboard.chart', { intent })}
        valueLabel={t('grade.dashboard.valueLabel')}
        categoryLabel={t('grade.dashboard.categoryLabel')}
        labels={{
          showTable: t('dashboard.volume.chart.showTable'),
          showChart: t('dashboard.volume.chart.showChart'),
        }}
        formatValue={count}
      />
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Verified or assumed, per intent (T-301d, PRD 6.2): how the tickets the grader looked at in the window
 * ended, from `GET /v1/ai/grades/metrics`. Counts and shares only: it never says an intent is ready for a
 * higher stage (that is the gate, T-304). Each class is a bar with an icon and its name, so the colour is
 * never the only cue. Lead and head (`metric.read`).
 */
/** The metrics route requires metric.read; the element control follows its separate registry rule. */
export function IntentGradesSection({ days }: { days: number }) {
  const { can } = useSession();
  const { t } = useI18n();
  if (can('metric.read')) return <IntentGradeMetricsBody days={days} />;
  return (
    <DashboardSection
      id="grades"
      icon={ClipboardCheck}
      tone="teal"
      title={t('grade.dashboard.title')}
    >
      <AskAiElement element="dashboard.ops.grades" period={`d${String(days)}`} />
    </DashboardSection>
  );
}

function IntentGradeMetricsBody({ days }: { days: number }) {
  const { t } = useI18n();
  const query = useIntentGradeMetrics(days, true);
  const intents = query.data?.intents ?? [];
  const refreshing = query.isPlaceholderData;
  return (
    <DashboardSection
      id="grades"
      icon={ClipboardCheck}
      tone="teal"
      title={t('grade.dashboard.title')}
    >
      <AskAiElement element="dashboard.ops.grades" period={`d${String(days)}`} />
      <div className="flex items-center gap-2">
        <HelpHint label={t('grade.dashboard.helpLabel')}>{t('grade.dashboard.help')}</HelpHint>
      </div>
      {query.isError && !query.data ? (
        <LoadError
          message={t('grade.dashboard.loadError')}
          onRetry={() => void query.refetch()}
          className="px-0"
        />
      ) : !query.data ? (
        <div role="status" aria-busy="true" className="grid gap-3 md:grid-cols-2">
          <span className="sr-only">{t('dashboard.loading')}</span>
          <Skeleton className="h-40 rounded-card" />
          <Skeleton className="h-40 rounded-card" />
        </div>
      ) : intents.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck />}
          title={t('grade.dashboard.empty')}
          description={t('grade.dashboard.emptyHint')}
        />
      ) : (
        <div
          aria-busy={refreshing || undefined}
          className={`grid gap-3 md:grid-cols-2 ${refreshing ? 'opacity-60' : ''}`}
        >
          {intents.map((row) => (
            <IntentCard key={row.intentKey ?? '(none)'} row={row} />
          ))}
        </div>
      )}
    </DashboardSection>
  );
}
