'use client';

import {
  OPEN_STATUSES,
  type TicketStats,
  type TicketStatus,
  type TicketSummary,
} from '@watchtower/shared';
import {
  Avatar,
  type ChipIcon,
  cn,
  SectionHeading,
  SeverityBadge,
  TINT_CLASSES,
  type TintId,
} from '@watchtower/ui';
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { LoadError } from '@/components/admin/admin-page';
import { AppLink } from '@/components/app-link';
import { SlaBadge } from '@/components/ticket/sla-badge';
import { useT } from '@/i18n/provider';
import { formatDuration } from '@/lib/format';
import { useStableList } from '@/lib/use-stable-list';
import { queueHref } from '@/lib/tickets/filters';
import { severityOf } from '@/lib/tickets/model';
import { slaView, type SlaView } from '@/lib/tickets/sla';
import { statusKey } from '@/lib/tickets/status-key';

/** A page of 200 is the most one request returns: a count taken from it is "at least". */
export const LIST_CAP = 200;

/**
 * A Soft Beacon card with an `h2`: a quiet icon and an 18px/500 title (docs/design/redesign-2026-11).
 * The icon stays neutral: colour on this page means state only (QA-20).
 */
export function HomeSection({
  id,
  title,
  tone,
  icon,
  aside,
  children,
  className,
}: {
  id: string;
  title: string;
  tone: TintId;
  icon: ChipIcon;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn('min-w-0 rounded-card bg-surface px-5 py-4 shadow-card', className)}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id={id} className="text-title font-medium text-foreground-strong">
          <SectionHeading tone={tone} icon={icon} plain>
            {title}
          </SectionHeading>
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** One quiet line where counts cannot be shown yet (the counts endpoint is not on this server). */
export function CountsUnavailable({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <LoadError
      message={t('home.statsUnavailable')}
      onRetry={onRetry}
      className="px-0 text-muted-foreground"
    />
  );
}

export interface Tile {
  id: string;
  label: string;
  /** `null`: the number is not available. */
  value: number | string | null;
  sub?: string;
  href: string;
  /** The hue and icon of the tile: the number is the message, these make it findable. */
  tone: TintId;
  icon: ChipIcon;
}

/**
 * The hero card (Soft Beacon): the total of open tickets in a large light number, then the numbers
 * the head decides on as neutral wells, each a link to the queue with the matching filter. Only the
 * icon takes its hue, and only when there is something to do (a count above zero); zero or no
 * figure stays grey (QA-20).
 */
export function OpenTicketsCard({
  total,
  tiles,
}: {
  /** `null`: the counts are not available. */
  total: number | null;
  tiles: readonly Tile[];
}) {
  const t = useT();
  return (
    <section
      aria-labelledby="home-open"
      className="flex min-w-0 flex-col gap-4 rounded-card bg-surface p-5 shadow-card lg:p-6"
    >
      <h2 id="home-open" className="text-title font-medium text-foreground-strong">
        {t('home.openTickets')}
      </h2>
      <p className="tabular text-hero font-light text-foreground-strong">
        {total ?? <span title={t('home.unavailable')}>—</span>}
      </p>
      <ul className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          const tone: TintId = needsAction(tile.value) ? tile.tone : 'slate';
          return (
            <li key={tile.id}>
              <AppLink
                href={tile.href}
                data-tone={tone}
                className={cn(
                  'flex h-full flex-col gap-0.5 rounded-inner px-3.5 py-3 transition-[box-shadow,transform] duration-(--wt-motion-duration-fast) ease-out hover:shadow-lift motion-safe:hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  'bg-surface-muted text-foreground',
                )}
              >
                {/* Read in this order (label, number, note); the icon leads the label. */}
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <Icon
                    aria-hidden
                    className={cn(
                      'size-3.5 shrink-0',
                      tone === 'slate' ? 'text-muted-foreground' : TINT_CLASSES[tone].icon,
                    )}
                  />
                  {tile.label}
                </span>
                <span className="tabular text-[1.6rem] leading-tight font-light">
                  {tile.value ?? <span title={t('home.unavailable')}>—</span>}
                </span>
                {tile.sub ? <span className="tabular text-xs">{tile.sub}</span> : null}
              </AppLink>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A count above zero is something to act on; zero, or a figure that is not there, is not. */
function needsAction(value: Tile['value']): boolean {
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') return /[1-9]/.test(value);
  return false;
}

export interface RiskRow {
  ticket: TicketSummary;
  sla: SlaView;
}

/** The tickets the server says are at risk or past due, with the badge the queue shows for them. */
export function riskRows(tickets: readonly TicketSummary[], now: number): RiskRow[] {
  return tickets.map((ticket) => ({ ticket, sla: slaView(ticket, now) }));
}

const RISK_ROWS_SHOWN = 10;

export function SlaRiskList({ rows }: { rows: readonly RiskRow[] }) {
  const t = useT();
  const stable = useStableList(rows, (row) => row.ticket.id);
  const shown = stable.shown.slice(0, RISK_ROWS_SHOWN);
  return (
    <div {...stable.handlers}>
      {stable.changed > 0 ? (
        <p role="status" className="mb-1">
          <button
            type="button"
            onClick={stable.apply}
            className="rounded-full bg-primary-subtle px-3 py-1 text-xs font-medium hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t('home.changedPill', { count: stable.changed })}
          </button>
        </p>
      ) : null}
      <ul aria-label={t('home.slaRisk')} className="divide-y divide-border/60">
        {shown.map(({ ticket, sla }) => (
          <li key={ticket.id} className="flex min-h-row items-center gap-2 py-1">
            <SeverityBadge
              severity={severityOf(ticket.priority)}
              label={t(`severity.${severityOf(ticket.priority)}`)}
              hideLabel
            />
            <AppLink
              href={`/?ticket=${encodeURIComponent(ticket.key)}`}
              className="font-mono text-xs underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {ticket.key}
            </AppLink>
            <SlaBadge sla={sla} />
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              {ticket.org.name}
            </span>
            {ticket.assignee ? (
              <span title={ticket.assignee.name}>
                <Avatar name={ticket.assignee.name} id={ticket.assignee.id} size={20} />
                <span className="sr-only">{ticket.assignee.name}</span>
              </span>
            ) : (
              <span className="text-xs font-medium">{t('home.unassigned')}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ShowAllLink({ count }: { count: number }) {
  const t = useT();
  return (
    <AppLink
      href={queueHref({ sort: 'due_asc' })}
      className="mt-2 inline-flex items-center gap-1 rounded-sm text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {t('home.showAll', { count })}
      <ArrowRight aria-hidden className="size-3.5" />
    </AppLink>
  );
}

/** "New 4 · Triage 2 · Open 31": one labelled number per status, each a link to the queue. */
export function StatusBreakdown({ stats }: { stats: TicketStats }) {
  const t = useT();
  const counted = stats.byStatus.filter(
    (entry) => OPEN_STATUSES.includes(entry.status) && entry.count > 0,
  );
  if (counted.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('home.empty.open')}</p>;
  }
  // New and Needs triage are already tiles at the top of the page.
  const shown = counted.filter((entry) => entry.status !== 'new' && entry.status !== 'triage');
  return (
    <ul className="flex flex-wrap gap-2">
      {shown.map((entry) => (
        <li key={entry.status}>
          <CountLink
            href={queueHref({ status: [entry.status satisfies TicketStatus] })}
            label={t(statusKey(entry.status))}
            count={entry.count}
          />
        </li>
      ))}
    </ul>
  );
}

export function QueueBreakdown({
  stats,
  names,
}: {
  stats: TicketStats;
  /** Queue names by id: the counts carry ids only. */
  names: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const groups = stats.byQueue.filter((queue) => queue.count > 0);
  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('home.empty.open')}</p>;
  }
  return (
    <ul className="flex flex-wrap gap-2">
      {groups.map((queue) => (
        <li key={queue.queueId ?? 'none'}>
          <CountLink
            href={
              queue.queueId
                ? queueHref({ queueId: queue.queueId, status: OPEN_STATUSES })
                : queueHref({})
            }
            label={
              queue.queueId
                ? (names.get(queue.queueId) ?? t('home.unknownQueue'))
                : t('home.noQueue')
            }
            count={queue.count}
          />
        </li>
      ))}
    </ul>
  );
}

/** A label and a number, one link: read as "Unassigned, 3 tickets". */
export function CountLink({ href, label, count }: { href: string; label: string; count: number }) {
  return (
    <AppLink
      href={href}
      className="inline-flex items-baseline gap-1.5 rounded-full bg-surface-muted px-3.5 py-1.5 text-sm transition-colors duration-(--wt-motion-duration-fast) ease-out hover:bg-primary-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular font-semibold">{count}</span>
    </AppLink>
  );
}

export interface LoadRowData {
  id: string;
  name: string;
  open: number;
  atRisk: number;
}

/**
 * Open tickets per person, each with a bar against the busiest person. The at-risk share of the
 * bar is hatched amber and also written out, so the colour never carries it alone.
 */
export function LoadList({ rows }: { rows: readonly LoadRowData[] }) {
  const t = useT();
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">{t('home.empty.load')}</p>;
  const most = Math.max(1, ...rows.map((row) => row.open));
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((row) => (
        <li key={row.id}>
          <AppLink
            href={queueHref({ assignee: row.id, status: OPEN_STATUSES })}
            className="grid min-h-row grid-cols-[auto_minmax(0,1fr)_auto_4rem] items-center gap-x-2.5 gap-y-1 rounded-inner px-1.5 py-1 hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            <Avatar name={row.name} id={row.id} size={32} className="row-span-2" />
            <span className="min-w-0 truncate text-sm font-medium">{row.name}</span>
            <span className="tabular text-sm font-semibold">{row.open}</span>
            {row.atRisk > 0 ? (
              <span className="tabular w-16 text-right text-xs text-foreground">
                {t('home.atRiskShort', { count: row.atRisk })}
              </span>
            ) : (
              <span aria-hidden className="w-16" />
            )}
            <span
              aria-hidden
              className="col-span-3 col-start-2 flex h-1.5 overflow-hidden rounded-full bg-surface-muted"
            >
              <span
                className="h-full bg-chart-email"
                style={{ width: `${String(((row.open - row.atRisk) / most) * 100)}%` }}
              />
              <span
                className="h-full bg-[repeating-linear-gradient(135deg,var(--color-tint-amber-icon)_0_3px,transparent_3px_5px)]"
                style={{ width: `${String((row.atRisk / most) * 100)}%` }}
              />
            </span>
          </AppLink>
        </li>
      ))}
    </ul>
  );
}

/** "oldest 18m" for the unassigned tile, from the oldest unassigned ticket. */
export function oldestAge(
  createdAt: string | undefined,
  now: number,
  locale: 'en' | 'th',
  words: (time: string) => string,
): string | undefined {
  if (createdAt === undefined) return undefined;
  return words(formatDuration(Math.max(0, now - Date.parse(createdAt)), locale));
}
