'use client';

import type { TicketPriority } from '@watchtower/shared';
import {
  type ChipIcon,
  SectionHeading,
  SeverityBadge,
  Skeleton,
  type TintId,
} from '@watchtower/ui';
import type { ReactNode } from 'react';

import { AppLink } from '@/components/app-link';
import { useI18n } from '@/i18n/provider';
import { formatDateTime } from '@/lib/format';
import { timeInZone } from '@/lib/shifts/model';

const SEVERITY = { P1: 'p1', P2: 'p2', P3: 'p3', P4: 'p4' } as const;

/** Priority as icon + code + word (severity is never colour alone). */
export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  const { t } = useI18n();
  const severity = SEVERITY[priority];
  return <SeverityBadge severity={severity} label={t(`severity.${severity}`)} plain />;
}

/** The ticket key as a link to the queue with that ticket open. */
export function TicketLink({ ticketKey }: { ticketKey: string }) {
  const { t } = useI18n();
  return (
    <AppLink
      href={`/?ticket=${encodeURIComponent(ticketKey)}`}
      aria-label={t('shift.common.ticketLink', { key: ticketKey })}
      className="rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {ticketKey}
    </AppLink>
  );
}

/** A named block of a shift page: heading with a count, then its content (or one line when empty). */
export function ShiftSection({
  id,
  title,
  count,
  tone,
  icon,
  children,
  actions,
}: {
  id: string;
  title: string;
  count?: number;
  tone: TintId;
  icon: ChipIcon;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id={`${id}-heading`} className="text-sm font-semibold">
          <SectionHeading tone={tone} icon={icon} {...(count === undefined ? {} : { count })}>
            {title}
          </SectionHeading>
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

const SHIFT_SUMMARY_WIDTHS = ['w-3/5', 'w-4/5', 'w-2/3', 'w-1/2'] as const;

/** Placeholder while a shift page loads; announced once. */
export function ShiftSkeleton({ rows = 4 }: { rows?: number }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4 p-4">
      <span className="sr-only">{t('shift.common.loading')}</span>

      {/* Shift summary header card */}
      <div aria-hidden className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-40" />
          <Skeleton variant="pill" className="h-6 w-24" />
        </div>
        <div className="flex items-center gap-4 text-xs">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3.5 w-28" />
        </div>
      </div>

      {/* Realistic shift handoff / ticket item rows */}
      <div aria-hidden className="flex flex-col gap-2">
        {Array.from({ length: rows }, (_, index) => {
          const summaryWidth = SHIFT_SUMMARY_WIDTHS[index % SHIFT_SUMMARY_WIDTHS.length] ?? 'w-3/5';
          return (
            <div
              key={index}
              style={{ animationDelay: `${String(index * 60)}ms` }}
              className="flex items-center justify-between gap-3 rounded-inner bg-surface p-3 shadow-xs"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <Skeleton variant="pill" className="h-5 w-12 shrink-0" />
                <Skeleton className="h-4 w-16 shrink-0" />
                <Skeleton className={`h-4 ${summaryWidth}`} />
              </div>
              <Skeleton variant="circle" className="size-5 shrink-0" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Formatters for the page language and the shift's time zone. */
export function useShiftFormat(timezone: string | undefined) {
  const { locale } = useI18n();
  return {
    /** "08:00" in the shift zone. */
    time: (iso: string) => timeInZone(iso, timezone ?? 'UTC', locale),
    /** "Nov 2, 2026, 08:00" in Bangkok time (the display zone). */
    dateTime: (iso: string) => formatDateTime(iso, locale),
  };
}
