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

/** Placeholder while a shift page loads; announced once. */
export function ShiftSkeleton({ rows = 4 }: { rows?: number }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-2 p-4">
      <span className="sr-only">{t('shift.common.loading')}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-9" />
      ))}
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
