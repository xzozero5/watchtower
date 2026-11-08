'use client';

import { AskAiElement } from '@/components/assistant/ask-ai-element';
import { ElementInsight } from '@/components/insights/element-insight';

import type { AiCost, AiCostLine } from '@watchtower/shared';
import {
  BarChart,
  type BarChartDatum,
  BarList,
  type BarListDatum,
  cn,
  IconButton,
  SectionHeading,
  Skeleton,
  StatTile,
} from '@watchtower/ui';
import { Coins, Cpu, Layers, RefreshCw, Ticket, Wallet } from 'lucide-react';
import { useState } from 'react';

import { AccessDenied, LoadError, PageHeader } from '@/components/admin/admin-page';
import { AppLink } from '@/components/app-link';
import { RelativeTime } from '@/components/relative-time';
import { useI18n } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { formatCount, formatDay, formatUsd } from '@/lib/dashboard/format';
import { useAiCost } from '@/lib/reports/queries';
import { changeOf } from '@/lib/reports/trend';

import { ChangeChip, type ReportWindow, WindowControl } from './report-bits';

const TOP = 10;
const KNOWN_AGENTS = [
  'classifier',
  'summarizer',
  'drafter',
  'investigator',
  'grader',
  'assistant',
] as const;
type KnownAgent = (typeof KNOWN_AGENTS)[number];
const isKnownAgent = (agent: string): agent is KnownAgent =>
  (KNOWN_AGENTS as readonly string[]).includes(agent);

const tokensOf = (line: AiCostLine) => line.inputTokens + line.outputTokens;
const CHART_LABELS = (
  t: (key: 'reports.cost.chart.showTable' | 'reports.cost.chart.showChart') => string,
) => ({
  showTable: t('reports.cost.chart.showTable'),
  showChart: t('reports.cost.chart.showChart'),
});

function CostSkeleton() {
  const { t } = useI18n();
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">{t('reports.cost.loading')}</span>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-[5.5rem] rounded-card" />
        ))}
      </div>
      <Skeleton className="h-40 rounded-card" />
    </div>
  );
}

/**
 * What the AI cost (PRD section 9.1, T-305a): per agent, per intent, per ticket and per day, from `ai_run`,
 * against the period before. Money counts only calls that have a price; the others are counted apart
 * (N5). Today against the daily caps is the AI controls page's card (T-142): linked, not repeated.
 */
export function AiCostPage() {
  const { can } = useSession();
  if (!can('ai.run.read')) return <AccessDenied role="lead" />;
  return <AiCostBody />;
}

function AiCostBody() {
  const { t } = useI18n();
  const { can } = useSession();
  const [days, setDays] = useState<ReportWindow>(7);
  const query = useAiCost(days, TOP, true);
  const cost = query.data;
  const refreshing = query.isPlaceholderData;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={t('reports.cost.title')}
        actions={
          <>
            {cost ? (
              <span className="text-xs text-muted-foreground">
                <span className="sr-only">{t('reports.updated')} </span>
                <RelativeTime iso={cost.generatedAt} />
              </span>
            ) : null}
            <IconButton
              variant="secondary"
              label={t('reports.refresh')}
              aria-busy={query.isFetching || undefined}
              icon={
                <RefreshCw
                  aria-hidden
                  className={cn('size-4', query.isFetching && 'motion-safe:animate-spin')}
                />
              }
              onClick={() => void query.refetch()}
            />
          </>
        }
      />
      <main
        id="main-content"
        aria-busy={query.isPending || undefined}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 lg:p-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <WindowControl days={days} onChange={setDays} />
            <AskAiElement element="reports.ai_cost" period={`d${String(days)}`} />
            <p className="text-sm text-muted-foreground">
              {t('reports.cost.budgetLead')}{' '}
              {can('ai.autonomy.set') ? (
                <AppLink href="/admin/ai" className="font-medium text-link underline">
                  {t('reports.cost.budgetLink')}
                </AppLink>
              ) : null}
            </p>
          </div>
          <ElementInsight element="reports.ai_cost" period={`d${String(days)}`} />
          {query.isError && !cost ? (
            <LoadError
              message={t('reports.cost.loadError')}
              onRetry={() => void query.refetch()}
              className="px-0"
            />
          ) : !cost ? (
            <CostSkeleton />
          ) : (
            <div
              aria-busy={refreshing || undefined}
              className={cn(
                'flex flex-col gap-6 motion-safe:transition-opacity',
                refreshing && 'opacity-60',
              )}
            >
              {query.isError ? (
                <LoadError
                  message={t('reports.cost.loadError')}
                  onRetry={() => void query.refetch()}
                  className="px-0 py-0"
                />
              ) : null}
              <CostTiles cost={cost} />
              <CostByDay cost={cost} />
              <div className="grid gap-6 lg:grid-cols-2">
                <CostByAgent cost={cost} />
                <CostByIntent cost={cost} />
              </div>
              <TopTickets cost={cost} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function CostTiles({ cost }: { cost: AiCost }) {
  const { t, locale } = useI18n();
  const { totals, previousTotals } = cost;
  const unpriced = totals.unpricedRuns;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">
      <StatTile
        label={t('reports.cost.tiles.cost')}
        icon={Wallet}
        tone="teal"
        value={formatUsd(totals.costUsd, locale)}
        detail={
          <span className="flex flex-col items-start gap-1">
            <ChangeChip
              change={changeOf(
                totals.costUsd,
                previousTotals.runs === 0 ? null : previousTotals.costUsd,
                'relative',
                'neutral',
              )}
            />
            <span>
              {unpriced > 0
                ? t('reports.cost.tiles.unpriced', { count: formatCount(unpriced, locale) })
                : t('reports.cost.tiles.allPriced')}
            </span>
          </span>
        }
        info={t('reports.cost.tiles.costInfo')}
        infoLabel={t('reports.cost.tiles.costInfoLabel')}
      />
      <StatTile
        label={t('reports.cost.tiles.tokens')}
        icon={Coins}
        tone="blue"
        value={formatCount(tokensOf(totals), locale)}
        detail={
          <span className="flex flex-col items-start gap-1">
            <ChangeChip
              change={changeOf(
                tokensOf(totals),
                previousTotals.runs === 0 ? null : tokensOf(previousTotals),
                'relative',
                'neutral',
              )}
            />
            <span>
              {t('reports.cost.tiles.tokensDetail', {
                input: formatCount(totals.inputTokens, locale),
                output: formatCount(totals.outputTokens, locale),
              })}
            </span>
          </span>
        }
      />
      <StatTile
        label={t('reports.cost.tiles.runs')}
        icon={Cpu}
        tone="slate"
        value={formatCount(totals.runs, locale)}
        detail={
          <ChangeChip
            change={changeOf(
              totals.runs,
              previousTotals.runs === 0 ? null : previousTotals.runs,
              'relative',
              'neutral',
            )}
          />
        }
      />
      <StatTile
        label={t('reports.cost.tiles.tickets')}
        icon={Ticket}
        tone="amber"
        value={formatCount(totals.tickets, locale)}
        detail={t('reports.cost.tiles.ticketsDetail')}
      />
    </div>
  );
}

function CostByDay({ cost }: { cost: AiCost }) {
  const { t, locale } = useI18n();
  const data: BarChartDatum[] = cost.byDay.map((entry) => ({
    key: entry.day,
    label: formatDay(entry.day, locale, 'long'),
    axisLabel: formatDay(entry.day, locale, 'short'),
    value: entry.costUsd,
  }));
  return (
    <section aria-labelledby="cost-by-day" className="flex flex-col gap-3">
      <h2 id="cost-by-day" className="text-title font-medium text-foreground-strong">
        <SectionHeading tone="teal" icon={Wallet} plain>
          {t('reports.cost.byDay.title')}
        </SectionHeading>
      </h2>

      <BarChart
        data={data}
        title={t('reports.cost.byDay.title')}
        valueLabel={t('reports.cost.byDay.value')}
        categoryLabel={t('reports.cost.byDay.category')}
        labels={CHART_LABELS(t)}
        emptyText={t('reports.cost.byDay.empty')}
        keyboardHint={t('reports.cost.byDay.keys')}
        formatValue={(value) => formatUsd(value, locale)}
      />
    </section>
  );
}

const COLOR = 'var(--wt-color-chart-ordinal-1)';

function CostByAgent({ cost }: { cost: AiCost }) {
  const { t, locale } = useI18n();
  const data: BarListDatum[] = cost.byAgent.map((row) => {
    const name = isKnownAgent(row.agent) ? t(`reports.cost.agents.${row.agent}`) : row.agent;
    return { key: row.agent, label: name, name, value: row.costUsd, color: COLOR };
  });
  return (
    <section aria-labelledby="cost-by-agent" className="flex min-w-0 flex-col gap-3">
      <h2 id="cost-by-agent" className="text-title font-medium text-foreground-strong">
        <SectionHeading tone="blue" icon={Cpu} plain>
          {t('reports.cost.byAgent.title')}
        </SectionHeading>
      </h2>
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('reports.cost.byAgent.empty')}</p>
      ) : (
        <BarList
          data={data}
          title={t('reports.cost.byAgent.lead')}
          valueLabel={t('reports.cost.byAgent.value')}
          categoryLabel={t('reports.cost.byAgent.category')}
          labels={CHART_LABELS(t)}
          formatValue={(value) => formatUsd(value, locale)}
        />
      )}
    </section>
  );
}

function CostByIntent({ cost }: { cost: AiCost }) {
  const { t, locale } = useI18n();
  const rows: BarListDatum[] = cost.byIntent.map((row) => {
    const name = row.intent ?? t('reports.cost.byIntent.none');
    return { key: row.intent ?? '~none', label: name, name, value: row.costUsd, color: COLOR };
  });
  if (cost.byIntentOthers !== null) {
    const name = t('reports.cost.byIntent.others');
    rows.push({
      key: '~others',
      label: name,
      name,
      value: cost.byIntentOthers.costUsd,
      color: COLOR,
    });
  }
  return (
    <section aria-labelledby="cost-by-intent" className="flex min-w-0 flex-col gap-3">
      <h2 id="cost-by-intent" className="text-title font-medium text-foreground-strong">
        <SectionHeading tone="amber" icon={Layers} plain>
          {t('reports.cost.byIntent.title')}
        </SectionHeading>
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('reports.cost.byIntent.empty')}</p>
      ) : (
        <BarList
          data={rows}
          title={t('reports.cost.byIntent.title')}
          valueLabel={t('reports.cost.byIntent.value')}
          categoryLabel={t('reports.cost.byIntent.category')}
          labels={CHART_LABELS(t)}
          formatValue={(value) => formatUsd(value, locale)}
        />
      )}
    </section>
  );
}

function TopTickets({ cost }: { cost: AiCost }) {
  const { t, locale } = useI18n();
  return (
    <section aria-labelledby="cost-top-tickets" className="flex flex-col gap-3">
      <h2 id="cost-top-tickets" className="text-title font-medium text-foreground-strong">
        <SectionHeading tone="sky" icon={Ticket} plain>
          {t('reports.cost.topTickets.title')}
        </SectionHeading>
      </h2>
      {cost.topTickets.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('reports.cost.topTickets.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-card bg-surface shadow-card">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('reports.cost.topTickets.title')}</caption>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('reports.cost.topTickets.ticket')}
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  {t('reports.cost.topTickets.calls')}
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  {t('reports.cost.topTickets.tokens')}
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  {t('reports.cost.topTickets.cost')}
                </th>
              </tr>
            </thead>
            <tbody>
              {cost.topTickets.map((row) => (
                <tr key={row.ticketId} className="border-t border-border/60">
                  <th scope="row" className="px-4 py-2 text-left font-medium">
                    <AppLink
                      href={`/?ticket=${encodeURIComponent(row.key)}`}
                      aria-label={t('reports.cost.topTickets.open', { key: row.key })}
                      className="text-link underline"
                    >
                      {row.key}
                    </AppLink>
                  </th>
                  <td className="tabular px-4 py-2 text-right">{formatCount(row.runs, locale)}</td>
                  <td className="tabular px-4 py-2 text-right">
                    {formatCount(tokensOf(row), locale)}
                  </td>
                  <td className="tabular px-4 py-2 text-right">{formatUsd(row.costUsd, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
