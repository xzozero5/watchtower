'use client';

import { AskAiElement } from '@/components/assistant/ask-ai-element';
import { ElementInsight } from '@/components/insights/element-insight';

import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { OPEN_STATUSES, type TicketSummary } from '@watchtower/shared';
import { BirddayIcon, Button, type ChipIcon, cn, Skeleton } from '@watchtower/ui';
import {
  Activity,
  Hourglass,
  Inbox,
  ListChecks,
  ListTree,
  RefreshCw,
  UserRoundX,
  Users,
  Layers,
} from 'lucide-react';
import { useMemo } from 'react';

import { AccessDenied, LoadError } from '@/components/admin/admin-page';
import { RelativeTime } from '@/components/relative-time';
import { useI18n } from '@/i18n/provider';
import {
  adminKeys,
  useAutonomy,
  useReadiness,
  useSlaRiskTickets,
  useTicketStats,
  useOldestUnassigned,
  useUnassignedByQueue,
  useUsers,
} from '@/lib/admin/queries';
import { openInStatus } from '@/lib/admin/contracts';
import { HOME_PERMISSION } from '@/lib/admin/sections';
import { useSession, useUserId } from '@/lib/auth/session';
import { queueHref } from '@/lib/tickets/filters';
import { isStaffTicket } from '@/lib/tickets/model';
import { useShiftOverview } from '@/lib/shifts/queries';
import { useQueues } from '@/lib/tickets/queries';
import { useNow } from '@/lib/use-now';

import { AiStatus, BotMark, SystemHealth } from './home-status';
import { TeamNow, UnclaimedByQueue } from './home-team';
import { AiDraftsHighlight, VolumeCard } from './home-volume';
import {
  CountsUnavailable,
  type LoadRowData,
  LoadList,
  oldestAge,
  QueueBreakdown,
  riskRows,
  ShowAllLink,
  SlaRiskList,
  StatusBreakdown,
  type Tile,
  OpenTicketsCard,
  HomeSection,
} from './home-sections';

const staffOnly = (items: readonly unknown[]): TicketSummary[] =>
  items.filter((item): item is TicketSummary => isStaffTicket(item as TicketSummary));

const HomeAiBirdIcon: ChipIcon = ({ className, ...rest }) => (
  <BirddayIcon {...rest} className={className} />
);

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
  const { can } = useSession();
  const showVolume = can('dashboard.ops.read');
  // The Lead view's source; the same permissions that page asks for.
  const showTeam = can('roster.manage') || can('performance.read.all');
  const queryClient = useQueryClient();
  const userId = useUserId();
  const now = useNow();

  const stats = useTicketStats(true);
  const slaList = useSlaRiskTickets(true);
  const oldestUnassigned = useOldestUnassigned(true);
  const ready = useReadiness(true);
  const users = useUsers(true);
  const unclaimed = useUnassignedByQueue(true);
  const team = useShiftOverview(showTeam);
  const queues = useQueues(true);
  const autonomy = useAutonomy(true);
  const fetching = useIsFetching({ queryKey: adminKeys(userId).all }) > 0;
  const updatedAt = Math.max(stats.dataUpdatedAt, slaList.dataUpdatedAt);

  const slaTickets = useMemo(() => staffOnly(slaList.data?.items ?? []), [slaList.data]);
  const rows = useMemo(() => riskRows(slaTickets, now), [slaTickets, now]);

  // The server's count when there is one; otherwise what the loaded page holds ("at least" if more).
  const sla = stats.data?.total.sla;
  const riskTotal = sla ? sla.at_risk + sla.breached : slaList.data ? rows.length : null;
  const riskCapped = !sla && slaList.data?.nextCursor != null;
  const overdue = sla ? sla.breached : rows.filter((row) => row.sla.state === 'breached').length;
  const countText = (value: number | null, capped = false) =>
    value === null ? null : capped ? t('home.atLeast', { count: value }) : String(value);

  const unassignedCount = stats.data
    ? (stats.data.byAssignee.find((entry) => entry.assigneeId === null)?.open ?? 0)
    : null;
  const oldest = oldestAge(oldestUnassigned.data?.items[0]?.createdAt, now, locale, (time) =>
    t('home.oldest', { time }),
  );
  const newCount = stats.data ? openInStatus(stats.data, 'new') : null;
  const triageCount = stats.data ? openInStatus(stats.data, 'triage') : null;

  const tiles: Tile[] = [
    {
      id: 'sla',
      label: t('home.slaRisk'),
      value: countText(riskTotal, riskCapped),
      ...(riskTotal !== null && overdue > 0
        ? { sub: t('home.overdueCount', { count: overdue }) }
        : {}),
      href: queueHref({
        sort: 'sla_due_asc',
        status: OPEN_STATUSES,
        slaState: ['at_risk', 'breached'],
      }),
      tone: 'amber',
      icon: Hourglass,
    },
    {
      id: 'unassigned',
      label: t('home.unassigned'),
      value: unassignedCount,
      ...(oldest && unassignedCount ? { sub: oldest } : {}),
      href: queueHref({ assignee: 'unassigned', status: OPEN_STATUSES }),
      tone: 'sky',
      icon: UserRoundX,
    },
    {
      id: 'new',
      label: t('home.new'),
      value: newCount,
      href: queueHref({ status: ['new'] }),
      tone: 'teal',
      icon: Inbox,
    },
    {
      id: 'triage',
      label: t('home.triage'),
      value: triageCount,
      href: queueHref({ status: ['triage'] }),
      tone: 'violet',
      icon: ListChecks,
    },
  ];

  const queueNames = useMemo(
    () => new Map((queues.data?.queues ?? []).map((queue) => [queue.id, queue.name])),
    [queues.data],
  );

  const load = useMemo<LoadRowData[]>(() => {
    if (!stats.data || !users.data) return [];
    const byPerson = new Map(stats.data.byAssignee.map((entry) => [entry.assigneeId, entry]));
    return users.data.users
      .filter(
        (user) =>
          user.status === 'active' &&
          (user.role === 'agent' || user.role === 'lead' || user.role === 'head'),
      )
      .map((user) => {
        const entry = byPerson.get(user.id);
        return {
          id: user.id,
          name: user.name,
          open: entry?.open ?? 0,
          atRisk: (entry?.sla.at_risk ?? 0) + (entry?.sla.breached ?? 0),
        };
      })
      .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
  }, [stats.data, users.data]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).all });
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).autonomy });
  };

  const openTotal = stats.data
    ? stats.data.byStatus
        .filter((entry) => OPEN_STATUSES.includes(entry.status))
        .reduce((sum, entry) => sum + entry.count, 0)
    : null;

  return (
    <main
      id="main-content"
      aria-busy={slaList.isPending || undefined}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      {/* Soft Beacon page head: a large light title, one quiet line, the refresh button. */}
      <header className="flex flex-wrap items-end justify-between gap-3 px-4 pt-5 pb-4 lg:px-7 lg:pt-7">
        <div className="min-w-0">
          <h1 className="text-display font-light text-foreground-strong">{t('home.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('home.refreshHint')}
            {updatedAt > 0 ? (
              <>
                {' · '}
                <RelativeTime iso={new Date(updatedAt).toISOString()} />
              </>
            ) : null}
          </p>
        </div>
        <Button
          variant="secondary"
          aria-busy={fetching || undefined}
          title={t('home.refreshHint')}
          className="rounded-full bg-surface shadow-card"
          onClick={refresh}
        >
          <RefreshCw aria-hidden className={cn('size-4', fetching && 'motion-safe:animate-spin')} />
          {t('home.refresh')}
        </Button>
      </header>

      <div className="flex flex-col gap-4 px-4 pb-6 lg:gap-5 lg:px-7">
        <div
          className={cn(
            'grid gap-4 lg:gap-5 motion-safe:animate-rise-in',
            showVolume && 'lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]',
          )}
        >
          <OpenTicketsCard total={openTotal} tiles={tiles} />
          {showVolume ? <VolumeCard /> : null}
        </div>

        <HomeSection
          id="home-sla"
          title={t('home.slaRisk')}
          tone="amber"
          icon={Hourglass}
          className="motion-safe:animate-rise-in"
        >
          {slaList.isPending ? (
            <ListSkeleton />
          ) : slaList.isError ? (
            <LoadError onRetry={() => void slaList.refetch()} className="px-0" />
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('home.empty.slaRisk')}</p>
          ) : (
            <>
              <SlaRiskList rows={rows} />
              {(riskTotal ?? rows.length) > 10 || riskCapped ? (
                <ShowAllLink count={riskTotal ?? rows.length} capped={riskCapped} />
              ) : null}
            </>
          )}
        </HomeSection>

        <div className="grid gap-4 lg:grid-cols-2 lg:gap-5 motion-safe:animate-rise-in">
          {showTeam ? (
            <HomeSection id="home-team" title={t('home.team.title')} tone="green" icon={Users}>
              <AskAiElement element="home.team" />
              <ElementInsight element="home.team" period="-" />
              <TeamNow query={team} />
            </HomeSection>
          ) : null}
          <HomeSection
            id="home-unclaimed"
            title={t('home.team.unclaimed')}
            tone="sky"
            icon={UserRoundX}
          >
            <UnclaimedByQueue query={unclaimed} names={queueNames} />
          </HomeSection>
        </div>

        <div className="grid gap-4 lg:grid-cols-2 lg:gap-5 motion-safe:animate-rise-in">
          <HomeSection
            id="home-ai"
            title={t('home.ai.title')}
            tone="teal"
            icon={HomeAiBirdIcon}
            aside={<BotMark />}
          >
            <AiStatus query={autonomy} />
          </HomeSection>
          <HomeSection id="home-load" title={t('home.load')} tone="green" icon={Users}>
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
        </div>

        <div className="grid gap-4 md:grid-cols-3 lg:gap-5 motion-safe:animate-rise-in">
          <HomeSection id="home-status" title={t('home.byStatus')} tone="sky" icon={Layers}>
            {stats.isPending ? (
              <Skeleton className="h-5" />
            ) : stats.isError ? (
              <CountsUnavailable onRetry={() => void stats.refetch()} />
            ) : (
              <StatusBreakdown stats={stats.data} />
            )}
          </HomeSection>
          <HomeSection id="home-queue" title={t('home.byQueue')} tone="indigo" icon={ListTree}>
            {stats.isPending ? (
              <Skeleton className="h-5" />
            ) : stats.isError ? (
              <CountsUnavailable onRetry={() => void stats.refetch()} />
            ) : (
              <QueueBreakdown stats={stats.data} names={queueNames} />
            )}
          </HomeSection>
          <HomeSection id="home-health" title={t('home.healthTitle')} tone="slate" icon={Activity}>
            <SystemHealth query={ready} />
          </HomeSection>
        </div>

        {showVolume ? (
          <div className="motion-safe:animate-rise-in">
            <AiDraftsHighlight />
          </div>
        ) : null}
      </div>
    </main>
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
