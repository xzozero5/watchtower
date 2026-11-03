'use client';

import { BarChart, type BarChartDatum } from '@watchtower/ui';

import { useI18n } from '@/i18n/provider';
import { formatCount, formatDay } from '@/lib/dashboard/format';
import { useDashboardOps } from '@/lib/dashboard/queries';

const VOLUME_DAYS = 7;

/**
 * Tickets created per day over the last week, from the ops dashboard read model (the same figures as
 * the Dashboard's Volume section). The comparison with the week before waits for a history API, so
 * no trend chip yet (owner, 2026-11-03). Only for people who may read the dashboard.
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
  }));
  return (
    <section
      aria-labelledby="home-volume"
      className="flex min-w-0 flex-col gap-3 rounded-card bg-surface p-5 shadow-card lg:p-6"
    >
      <div>
        <h2 id="home-volume" className="text-title font-medium text-foreground-strong">
          {t('home.volume')}
        </h2>
        {volume ? (
          <p className="tabular text-sm text-muted-foreground">
            {t('home.volumeCreated', { count: formatCount(volume.created, locale) })}
          </p>
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
