'use client';

import { DASHBOARD_DEFAULT_DAYS } from '@watchtower/shared';
import { cn, IconButton, SegmentedControl, Skeleton } from '@watchtower/ui';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { AccessDenied, LoadError, PageHeader } from '@/components/admin/admin-page';
import { RelativeTime } from '@/components/relative-time';
import { useT } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { useDashboardOps } from '@/lib/dashboard/queries';

import {
  AiSection,
  NowSection,
  QualitySection,
  ReliabilitySection,
  ServicesSection,
  SlaSection,
  TeamSection,
  UsageSection,
  VolumeSection,
} from './sections';

/** The windows the api offers as presets (`days` 1 to 90). */
export const DASHBOARD_WINDOWS = [7, 30, 90] as const;
export type DashboardWindow = (typeof DASHBOARD_WINDOWS)[number];

/** Placeholder with the page's own shape (tiles, a chart), so nothing jumps when the figures arrive. */
function DashboardSkeleton() {
  const t = useT();
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">{t('dashboard.loading')}</span>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-[5.5rem] rounded-card" />
        ))}
      </div>
      <Skeleton className="h-40 rounded-card" />
    </div>
  );
}

/**
 * The ops dashboard (PRD section 9.1, T-206a/c). A window control on one row above everything it
 * scopes, then the sections in the order of the spec: Now, Volume, SLA, Quality, Reliability, AI,
 * Team, Product usage, Service status. The api decides what each role sees: a figure it cannot
 * compute says why and a figure the role may not see says so, never a zero (N5).
 */
export function DashboardPage() {
  const { can } = useSession();
  if (!can('dashboard.ops.read')) return <AccessDenied role="lead" />;
  return <DashboardBody />;
}

function DashboardBody() {
  const t = useT();
  const [days, setDays] = useState<DashboardWindow>(DASHBOARD_DEFAULT_DAYS as DashboardWindow);
  const query = useDashboardOps(days, true);
  const ops = query.data;
  // A new window shows the last one dimmed until its own figures arrive: no skeleton, no jump.
  const refreshing = query.isPlaceholderData;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={t('dashboard.title')}
        actions={
          <>
            {ops ? (
              <span className="text-xs text-muted-foreground">
                <span className="sr-only">{t('dashboard.updated', { time: '' })}</span>
                <RelativeTime iso={ops.generatedAt} />
              </span>
            ) : null}
            <IconButton
              variant="secondary"
              label={t('dashboard.refresh')}
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
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl<'7' | '30' | '90'>
              aria-label={t('dashboard.window.label')}
              value={String(days) as '7' | '30' | '90'}
              onValueChange={(next) => {
                setDays(Number(next) as DashboardWindow);
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
          </div>
          {query.isError && !ops ? (
            <LoadError
              message={t('dashboard.loadError')}
              onRetry={() => void query.refetch()}
              className="px-0"
            />
          ) : !ops ? (
            <DashboardSkeleton />
          ) : (
            <>
              {query.isError ? (
                <LoadError
                  message={t('dashboard.loadError')}
                  onRetry={() => void query.refetch()}
                  className="px-0 py-0"
                />
              ) : null}
              <div
                aria-busy={refreshing || undefined}
                className={cn(
                  'flex flex-col motion-safe:transition-opacity',
                  refreshing && 'opacity-60',
                )}
              >
                <NowSection ops={ops} />
                <VolumeSection ops={ops} />
                <SlaSection ops={ops} />
                <QualitySection ops={ops} />
                <ReliabilitySection ops={ops} />
                <AiSection ops={ops} />
                <TeamSection ops={ops} />
                <UsageSection ops={ops} />
                <ServicesSection ops={ops} />
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
