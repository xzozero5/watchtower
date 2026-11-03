'use client';

import type { CustomerStatus, PortalTimelineEntry } from '@watchtower/shared';
import { cn } from '@watchtower/ui';
import { Paperclip } from 'lucide-react';

import { useI18n } from '@/i18n/provider';
import { formatBytes } from '@/lib/portal/attachments';
import { formatPortalTime } from '@/lib/portal/portal-format';

import { customerStatusKey } from './customer-status-label';

/**
 * The public timeline (R-9.2): the customer's own messages, replies from the team with the agent's
 * first name, and status changes as one-line rows. Text is shown as plain text with its line
 * breaks, never as HTML. The api never sends internal notes, AI or system events.
 */
export function PortalTimeline({
  entries,
  truncated,
}: {
  entries: readonly PortalTimelineEntry[];
  truncated: boolean;
}) {
  const { t, locale } = useI18n();

  if (entries.length === 0) {
    return <p className="text-muted-foreground">{t('portal.tracking.emptyTimeline')}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {truncated ? (
        <p className="text-sm text-muted-foreground">{t('portal.tracking.truncated')}</p>
      ) : null}
      <ol className="flex flex-col gap-3">
        {entries.map((entry) => {
          if (entry.kind === 'status') {
            const status: CustomerStatus = entry.status;
            return (
              <li
                key={entry.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground"
              >
                <span>
                  {t('portal.tracking.statusChanged', {
                    status:
                      status === 'merged' && entry.mergedIntoKey
                        ? t('portal.status.mergedInto', { key: entry.mergedIntoKey })
                        : t(customerStatusKey(status)),
                  })}
                </span>
                <time dateTime={entry.createdAt} className="tabular-nums">
                  {formatPortalTime(entry.createdAt, locale)}
                </time>
              </li>
            );
          }
          const mine = entry.from === 'customer';
          const author = mine
            ? t('portal.tracking.you')
            : (entry.authorName ?? t('portal.tracking.team'));
          return (
            <li
              key={entry.id}
              data-from={entry.from}
              className={cn(
                'rounded-lg border px-3 py-2',
                mine ? 'border-border bg-surface-muted' : 'border-border-strong bg-surface',
              )}
            >
              <p className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <span className="font-semibold">{author}</span>
                <time dateTime={entry.createdAt} className="text-muted-foreground tabular-nums">
                  {formatPortalTime(entry.createdAt, locale)}
                </time>
              </p>
              <p className="mt-1 break-words whitespace-pre-wrap">{entry.body}</p>
              {entry.attachments && entry.attachments.length > 0 ? (
                <ul
                  aria-label={t('portal.attachments.label')}
                  className="mt-1 flex flex-col gap-0.5 text-sm text-muted-foreground"
                >
                  {entry.attachments.map((file, index) => (
                    <li key={`${file.name}-${String(index)}`} className="flex gap-2">
                      <Paperclip aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                      <span className="min-w-0 break-all">{file.name}</span>
                      <span className="shrink-0 tabular-nums">{formatBytes(file.size)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
