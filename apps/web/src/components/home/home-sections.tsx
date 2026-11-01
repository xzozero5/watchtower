'use client';

import {
  OPEN_STATUSES,
  type TicketStats,
  type TicketStatus,
  type TicketSummary,
} from '@watchtower/shared';
import { Avatar, cn, SeverityBadge } from '@watchtower/ui';
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

/** `section` with an `h2` of plain 14px/600 text, divided from the next one by a hairline. */
export function HomeSection({
  id,
  title,
  aside,
  children,
  className,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn('min-w-0 px-4 py-3', className)}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-sm font-semibold">
          {title}
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
}

/**
 * The numbers the head decides on, as one strip of tiles divided by hairlines: a big number, a
 * short label, a link to the queue with the matching filter. No sentences.
 */
export function TileStrip({ tiles }: { tiles: readonly Tile[] }) {
  const t = useT();
  return (
    <ul className="grid grid-cols-2 divide-x divide-y divide-border border-b border-border md:grid-cols-4 md:divide-y-0">
      {tiles.map((tile) => (
        <li key={tile.id}>
          <AppLink
            href={tile.href}
            className="flex h-full flex-col gap-0.5 px-4 py-3 transition-colors duration-(--wt-motion-duration-fast) ease-out hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            {/* Read in this order (label, number, note); drawn with the number on top. */}
            <span className="order-2 text-xs text-muted-foreground">{tile.label}</span>
            <span className="tabular order-1 text-xl leading-tight font-semibold">
              {tile.value ?? <span title={t('home.unavailable')}>—</span>}
            </span>
            {tile.sub ? (
              <span className="tabular order-3 text-xs text-foreground">{tile.sub}</span>
            ) : null}
          </AppLink>
        </li>
      ))}
    </ul>
  );
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
            className="rounded-md border border-border-strong px-2 py-0.5 text-xs font-medium hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t('home.changedPill', { count: stable.changed })}
          </button>
        </p>
      ) : null}
      <ul aria-label={t('home.slaRisk')} className="divide-y divide-border">
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
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
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
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {groups.map((queue) => (
        <li key={queue.queueId ?? 'none'}>
          <CountLink
            href={
              queue.queueId
                ? queueHref({ queueId: queue.queueId, status: OPEN_STATUSES })
                : queueHref({})
            }
            label={queue.queueId ? (names.get(queue.queueId) ?? '…') : t('home.noQueue')}
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
      className="inline-flex items-baseline gap-1.5 rounded-sm text-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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

export function LoadList({ rows }: { rows: readonly LoadRowData[] }) {
  const t = useT();
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">{t('home.empty.load')}</p>;
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <li key={row.id}>
          <AppLink
            href={queueHref({ assignee: row.id, status: OPEN_STATUSES })}
            className="flex min-h-row items-center gap-2 rounded-sm hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            <Avatar name={row.name} id={row.id} size={20} />
            <span className="min-w-0 flex-1 truncate text-sm">{row.name}</span>
            <span className="tabular text-sm font-semibold">{row.open}</span>
            {row.atRisk > 0 ? (
              <span className="tabular w-16 text-right text-xs text-foreground">
                {t('home.atRiskShort', { count: row.atRisk })}
              </span>
            ) : (
              <span aria-hidden className="w-16" />
            )}
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
