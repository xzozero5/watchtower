'use client';

import { AskAiElement } from '@/components/assistant/ask-ai-element';
import { ElementInsight } from '@/components/insights/element-insight';

import { BarChart, type BarChartDatum, HighlightCard, TrendChip } from '@watchtower/ui';
import { Bot } from 'lucide-react';

import { useI18n } from '@/i18n/provider';
import { formatCount, formatDay, formatRate } from '@/lib/dashboard/format';
import { useDashboardOps } from '@/lib/dashboard/queries';
import { channelSegments, legendChannel, volumeTrend } from '@/lib/dashboard/volume';

const VOLUME_DAYS = 7;

/**
 * Tickets created per day over the last week, stacked by channel, from the ops dashboard read model
 * (the same figures as the Dashboard's Volume section), with a chip against the 7 days before (T-159).
 * Only for people who may read the dashboard.
 */
export function VolumeCard() {
  const { t, locale } = useI18n();
  const query = useDashboardOps(VOLUME_DAYS, true);
  const volume = query.data?.volume;
  const data: BarChartDatum[] = (volume?.byDay ?? []).map((entry) => ({
    key: entry.day,
    label: formatDay(entry.day, locale, 'long'),
    axisLabel: formatDay(entry.day, locale, 'short'),
    value: entry.created,
    segments: channelSegments(entry.byChannel, (channel) => t(`channel.${legendChannel(channel)}`)),
  }));
  const trend = volume ? volumeTrend(volume.created, volume.previous.created) : null;
  const trendLabel =
    trend === null
      ? null
      : trend.direction === 'flat'
        ? t('home.trendFlat')
        : t(trend.direction === 'up' ? 'home.trendUp' : 'home.trendDown', {
            percent: formatRate(trend.percent / 100, locale),
          });
  return (
    <section
      aria-labelledby="home-volume"
      className="flex min-w-0 flex-col gap-3 rounded-card bg-surface p-5 shadow-card lg:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <ElementInsight
            element="home.volume"
            period="d7"
            className="mb-2"
            followUp={<AskAiElement presentation="follow-up" element="home.volume" period="d7" />}
          />
          <h2 id="home-volume" className="text-title font-medium text-foreground-strong">
            {t('home.volume')}
          </h2>
          {volume ? (
            <p className="tabular text-sm text-muted-foreground">
              {t('home.volumeCreated', { count: formatCount(volume.created, locale) })}
            </p>
          ) : null}
        </div>
        {trend && trendLabel ? (
          <TrendChip direction={trend.direction} meaning="neutral" label={trendLabel} />
        ) : null}
      </div>
      {query.isError ? (
        <p className="text-sm text-muted-foreground">{t('home.volumeUnavailable')}</p>
      ) : volume ? (
        <BarChart
          data={data}
          title={t('dashboard.volume.perDay')}
          valueLabel={t('dashboard.volume.createdValue')}
          categoryLabel={t('dashboard.volume.dayColumn')}
          labels={{
            showTable: t('dashboard.volume.chart.showTable'),
            showChart: t('dashboard.volume.chart.showChart'),
          }}
          emptyText={t('dashboard.volume.chart.empty')}
          keyboardHint={t('dashboard.volume.chart.keys')}
          formatValue={(n) => formatCount(n, locale)}
        />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {t('home.loading')}
        </p>
      )}
    </section>
  );
}

/**
 * The highlight card (Soft Beacon): one fact worth a glance, the share of AI drafts the team
 * accepted over the last week, with how many were decided and edited. Navy with a seafoam glow,
 * never gold, never a celebration. Missing figures hide the card instead of showing a zero (N5).
 */
export function AiDraftsHighlight() {
  const { t, locale } = useI18n();
  const query = useDashboardOps(VOLUME_DAYS, true);
  const ai = query.data?.ai;
  if (ai?.status !== 'ok' || ai.data.drafts.status !== 'ok') return null;
  const drafts = ai.data.drafts.data;
  return (
    <HighlightCard as="section" aria-labelledby="home-ai-drafts" className="lg:p-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 id="home-ai-drafts" className="flex items-center gap-2 text-title font-medium">
            <Bot aria-hidden className="size-5" />
            {t('dashboard.ai.acceptance')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('home.aiDraftsWindow')}</p>
        </div>
        <div className="text-right">
          <p className="tabular text-hero font-light">
            {formatRate(drafts.acceptanceRate, locale)}
          </p>
          <p className="tabular text-sm text-muted-foreground">
            {t('dashboard.ai.acceptanceDetail', {
              decided: formatCount(drafts.decided, locale),
              edited: formatCount(drafts.edited, locale),
            })}
          </p>
        </div>
      </div>
    </HighlightCard>
  );
}
