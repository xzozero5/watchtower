'use client';

import { SegmentedControl, TrendChip } from '@watchtower/ui';

import { useI18n, useT } from '@/i18n/provider';
import { formatCount } from '@/lib/dashboard/format';
import type { Change } from '@/lib/reports/trend';

/** The windows both reports offer; the api accepts 1 to 90. */
export const REPORT_WINDOWS = [7, 30, 90] as const;
export type ReportWindow = (typeof REPORT_WINDOWS)[number];

/** 7, 30 or 90 days, worded like the ops dashboard's own control. */
export function WindowControl({
  days,
  onChange,
}: {
  days: ReportWindow;
  onChange: (days: ReportWindow) => void;
}) {
  const t = useT();
  return (
    <SegmentedControl<'7' | '30' | '90'>
      aria-label={t('dashboard.window.label')}
      value={String(days) as '7' | '30' | '90'}
      onValueChange={(next) => {
        onChange(Number(next) as ReportWindow);
      }}
      options={[
        {
          value: '7',
          label: t('dashboard.window.days7'),
          ariaLabel: t('dashboard.window.aria7'),
        },
        {
          value: '30',
          label: t('dashboard.window.days30'),
          ariaLabel: t('dashboard.window.aria30'),
        },
        {
          value: '90',
          label: t('dashboard.window.days90'),
          ariaLabel: t('dashboard.window.aria90'),
        },
      ]}
    />
  );
}

/** "+12% vs previous period": words, arrow and tint together, never colour alone. */
export function ChangeChip({ change }: { change: Change | null }) {
  const { t, locale } = useI18n();
  if (change === null) return null;
  const amount =
    change.unit === 'points'
      ? t('reports.trend.points', { amount: formatCount(change.amount, locale) })
      : `${formatCount(change.amount, locale)}%`;
  const label =
    change.direction === 'flat'
      ? t('reports.trend.flat')
      : t(change.direction === 'up' ? 'reports.trend.up' : 'reports.trend.down', { amount });
  return <TrendChip direction={change.direction} meaning={change.meaning} label={label} />;
}

/** Saves bytes the api answered with as a file, through a temporary link. */
export function saveBlob(bytes: Blob, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Let the browser consume the click before releasing the bytes.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
