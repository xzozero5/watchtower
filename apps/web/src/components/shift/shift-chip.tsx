'use client';

import { cn } from '@watchtower/ui';
import { Clock3, TriangleAlert } from 'lucide-react';

import { AppLink } from '@/components/app-link';
import { useI18n } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { chipLabel } from '@/lib/shifts/model';
import { useShiftStatus } from '@/lib/shifts/queries';

/**
 * The shift chip (docs/06-UI-SPEC.md section 9.1) in the navigation rail: off shift (a way to clock
 * in), on shift with the time left, late or past the end (a warning with an icon and words). Words
 * show when the rail is wide; the icon and the full sentence (name and tooltip) are always there.
 * Nothing renders for someone who cannot clock in, or while the status is unknown.
 */
export function ShiftChip({ expanded }: { expanded: boolean }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const allowed = can('shift.clock');
  const status = useShiftStatus(allowed);
  if (!allowed || !status.data) return null;
  const label = chipLabel(status.data, t, locale);
  const Icon = label.warning ? TriangleAlert : Clock3;
  const unread = status.data.unreadNotes + status.data.pendingAcks;
  const full = [
    label.text,
    status.data.unreadNotes > 0
      ? t('shift.status.unreadNotes', { count: status.data.unreadNotes })
      : null,
    status.data.pendingAcks > 0
      ? t('shift.status.pendingAcks', { count: status.data.pendingAcks })
      : null,
  ]
    .filter((part) => part !== null)
    .join(', ');
  return (
    <AppLink
      href="/shift"
      aria-label={full}
      title={full}
      data-shift-state={label.state}
      className={cn(
        'flex min-h-control items-center gap-2 rounded-xl px-2 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring',
        'max-md:size-control max-md:justify-center max-md:px-0',
        label.warning
          ? 'bg-surface-muted font-medium text-foreground'
          : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span aria-hidden className={cn('truncate', !expanded && 'sr-only', 'max-md:sr-only')}>
        {label.text}
      </span>
      {unread > 0 ? (
        <span
          aria-hidden
          className={cn(
            'tabular ml-auto rounded-full bg-primary-subtle px-1.5 text-foreground',
            !expanded && 'sr-only',
          )}
        >
          {unread}
        </span>
      ) : null}
    </AppLink>
  );
}
