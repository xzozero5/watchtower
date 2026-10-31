'use client';

import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { OPEN_STATUSES, type TicketSummary } from '@watchtower/shared';
import { Button, cn, Skeleton } from '@watchtower/ui';
import { RefreshCw } from 'lucide-react';
import { useMemo } from 'react';

import { AccessDenied, LoadError, PageHeader } from '@/components/admin/admin-page';
import { RelativeTime } from '@/components/relative-time';
import { useI18n } from '@/i18n/provider';
import {
  adminKeys,
  useAutonomy,
  useReadiness,
  useSlaRiskTickets,
  useTicketStats,
  useUnassignedTickets,
  useUsers,
} from '@/lib/admin/queries';
import { HOME_PERMISSION } from '@/lib/admin/sections';
import { useSession, useUserId } from '@/lib/auth/session';
import { queueHref } from '@/lib/tickets/filters';
import { isStaffTicket } from '@/lib/tickets/model';
import { useNow } from '@/lib/use-now';

import { AiStatus, BotMark, SystemHealth } from './home-status';
import {
  CountsUnavailable,
  type LoadRowData,
  LIST_CAP,
  LoadList,
  oldestAge,
  QueueBreakdown,
  riskRows,
  ShowAllLink,
  SlaRiskList,
  StatusBreakdown,
  type Tile,
  TileStrip,
  HomeSection,
} from './home-sections';

const staffOnly = (items: readonly unknown[]): TicketSummary[] =>
  items.filter((item): item is TicketSummary => isStaffTicket(item as TicketSummary));

/**
 * Head home (docs/06-UI-SPEC.md section 18.2, trimmed by docs/design/ai-first-workspace.md section
 * 4): what needs the head's decision first, as a strip of numbers that link to the queue (SLA at
 * risk, unassigned, new, needs triage), then the at-risk list, the AI state, the open load and the
 * system health. Numbers and short labels only, no charts (Phase 2, T-206). Head and lead see it.
 */
export function HomePage() {
  const { can } = useSession();
  if (!can(HOME_PERMISSION)) return <AccessDenied role="lead" />;
  return <HomeBody />;
}

function HomeBody() {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const userId = useUserId();
  const now = useNow();

  const stats = useTicketStats(true);
  const slaList = useSlaRiskTickets(true);
  const unassigned = useUnassignedTickets(true);
  const ready = useReadiness(true);
  const users = useUsers(true);
  const autonomy = useAutonomy(true);
  const fetching = useIsFetching({ queryKey: adminKeys(userId).all }) > 0;
  const updatedAt = Math.max(stats.dataUpdatedAt, slaList.dataUpdatedAt);

  const slaTickets = useMemo(() => staffOnly(slaList.data?.items ?? []), [slaList.data]);
  const rows = useMemo(() => riskRows(slaTickets, now), [slaTickets, now]);
  const unassignedTickets = useMemo(
    () => staffOnly(unassigned.data?.items ?? []),
    [unassigned.data],
  );

  // The server's count when it has one; otherwise what the loaded page shows, "at least" if full.
  const slaFull = slaTickets.length >= LIST_CAP;
  const riskTotal = stats.data
    ? stats.data.bySlaState.at_risk + stats.data.bySlaState.breached
    : slaList.data
      ? rows.length
      : null;
  const overdue = stats.data
    ? stats.data.bySlaState.breached
    : rows.filter((row) => row.sla.state === 'breached').length;
  const countText = (value: number | null, capped = false) =>
    value === null ? null : capped ? t('home.atLeast', { count: value }) : String(value);

  const unassignedCount = stats.data
    ? (stats.data.byAssignee.find((entry) => entry.userId === null)?.n ?? 0)
    : null;
  const oldest = oldestAge(unassignedTickets, now, locale, (time) => t('home.oldest', { time }));

  const tiles: Tile[] = [
    {
      id: 'sla',
      label: t('home.slaRisk'),
      value: countText(riskTotal, !stats.data && slaFull),
      ...(riskTotal !== null && overdue > 0
        ? { sub: t('home.overdueCount', { count: overdue }) }
        : {}),
      href: queueHref({ sort: 'due_asc', status: OPEN_STATUSES }),
      phrase: t('home.countPhrase', { label: t('home.slaRisk'), count: riskTotal ?? 0 }),
    },
    {
      id: 'unassigned',
      label: t('home.unassigned'),
      value: unassignedCount,
      ...(oldest && unassignedCount ? { sub: oldest } : {}),
      href: queueHref({ assignee: 'unassigned', status: ['new', 'triage', 'open'] }),
      phrase: t('home.countPhrase', { label: t('home.unassigned'), count: unassignedCount ?? 0 }),
    },
    {
      id: 'new',
      label: t('home.new'),
      value: stats.data ? (stats.data.byStatus.new ?? 0) : null,
      href: queueHref({ status: ['new'] }),
      phrase: t('home.countPhrase', { label: t('home.new'), count: stats.data?.byStatus.new ?? 0 }),
    },
    {
      id: 'triage',
      label: t('home.triage'),
      value: stats.data ? (stats.data.byStatus.triage ?? 0) : null,
      href: queueHref({ status: ['triage'] }),
      phrase: t('home.countPhrase', {
        label: t('home.triage'),
        count: stats.data?.byStatus.triage ?? 0,
      }),
    },
  ];

  const load = useMemo<LoadRowData[]>(() => {
    if (!stats.data || !users.data) return [];
    const open = new Map(stats.data.byAssignee.map((entry) => [entry.userId, entry.n]));
    const atRisk = new Map<string, number>();
    for (const row of rows) {
      const id = row.ticket.assignee?.id;
      if (id) atRisk.set(id, (atRisk.get(id) ?? 0) + 1);
    }
    return users.data.users
      .filter(
        (user) => user.status === 'active' && user.role !== 'client' && user.role !== 'system',
      )
      .map((user) => ({
        id: user.id,
        name: user.name,
        open: open.get(user.id) ?? 0,
        atRisk: atRisk.get(user.id) ?? 0,
      }))
      .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
  }, [stats.data, users.data, rows]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).all });
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).autonomy });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={t('home.title')}
        actions={
          <>
            {updatedAt > 0 ? (
              <span className="text-xs text-muted-foreground" title={t('home.refreshHint')}>
                <RelativeTime iso={new Date(updatedAt).toISOString()} />
              </span>
            ) : null}
            <Button size="sm" onClick={refresh} aria-busy={fetching || undefined}>
              <RefreshCw
                aria-hidden
                className={cn('size-3.5', fetching && 'motion-safe:animate-spin')}
              />
              {t('home.refresh')}
            </Button>
          </>
        }
      />
      <main
        id="main-content"
        aria-busy={slaList.isPending || undefined}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <TileStrip tiles={tiles} />

        <div className="grid divide-border border-b border-border lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:divide-x">
          <HomeSection id="home-sla" title={t('home.slaRisk')}>
            {slaList.isPending ? (
              <ListSkeleton />
            ) : slaList.isError ? (
              <LoadError onRetry={() => void slaList.refetch()} className="px-0" />
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('home.empty.slaRisk')}</p>
            ) : (
              <>
                <SlaRiskList rows={rows} />
                {rows.length > 10 ? <ShowAllLink count={rows.length} /> : null}
              </>
            )}
          </HomeSection>
          <HomeSection id="home-ai" title={t('home.ai.title')} aside={<BotMark />}>
            <AiStatus query={autonomy} />
          </HomeSection>
        </div>

        <div className="grid divide-border border-b border-border md:grid-cols-2 md:divide-x">
          <HomeSection id="home-status" title={t('home.byStatus')}>
            {stats.isPending ? (
              <Skeleton className="h-5" />
            ) : stats.isError ? (
              <CountsUnavailable onRetry={() => void stats.refetch()} />
            ) : (
              <StatusBreakdown stats={stats.data} />
            )}
          </HomeSection>
          <HomeSection id="home-queue" title={t('home.byQueue')}>
            {stats.isPending ? (
              <Skeleton className="h-5" />
            ) : stats.isError ? (
              <CountsUnavailable onRetry={() => void stats.refetch()} />
            ) : (
              <QueueBreakdown stats={stats.data} />
            )}
          </HomeSection>
        </div>

        <div className="grid divide-border md:grid-cols-2 md:divide-x">
          <HomeSection id="home-load" title={t('home.load')}>
            {stats.isPending || users.isPending ? (
              <ListSkeleton />
            ) : stats.isError ? (
              <CountsUnavailable onRetry={() => void stats.refetch()} />
            ) : users.isError ? (
              <LoadError onRetry={() => void users.refetch()} className="px-0" />
            ) : (
              <LoadList rows={load} />
            )}
          </HomeSection>
          <HomeSection id="home-health" title={t('home.healthTitle')}>
            <SystemHealth query={ready} />
          </HomeSection>
        </div>
      </main>
    </div>
  );
}

function ListSkeleton() {
  const { t } = useI18n();
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-1.5">
      <span className="sr-only">{t('home.loading')}</span>
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-7" />
      ))}
    </div>
  );
}
