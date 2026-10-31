import { Avatar, cn, SeverityBadge } from '@watchtower/ui';

import { ChannelIcon } from '@/components/ticket/channel-icon';
import { SlaBadge } from '@/components/ticket/sla-badge';
import { StatusLabel } from '@/components/ticket/status-label';
import { useI18n } from '@/i18n/provider';
import { formatDateTime, formatRelative } from '@/lib/format';
import { type RowModel, severityOf } from '@/lib/tickets/model';

export const rowDomId = (key: string) => `queue-row-${key}`;

/** The id of the queue's listbox, the element that holds keyboard focus while the queue is in use. */
export const QUEUE_LISTBOX_ID = 'queue-listbox';

export interface QueueRowProps {
  row: RowModel;
  selected: boolean;
  now: number;
  onSelect: (key: string) => void;
}

/**
 * One ticket in the queue, an `option` of the queue's listbox. Keyboard focus stays on the listbox
 * and `aria-activedescendant` names the current row, so arrow keys, J/K and clicks all move the
 * same pointer. There is no card: the row is a hairline-separated strip (avatar, who wrote in,
 * when; the subject; a meta line). The selected row has a 2px navy bar on its left, a tint and
 * `aria-selected="true"`. A new ticket (nobody has touched it yet) has a bold subject and a dot.
 * Priority is an icon + code, the status a dot + words, the SLA an icon + words: nothing relies
 * on colour.
 */
export function QueueRow({ row, selected, now, onSelect }: QueueRowProps) {
  const { t, locale } = useI18n();
  const isNew = row.status === 'new';
  const who = row.requesterName ?? row.key;
  return (
    <li
      id={rowDomId(row.key)}
      role="option"
      aria-selected={selected}
      data-ticket-key={row.key}
      onClick={() => {
        onSelect(row.key);
      }}
      className={cn(
        'relative flex w-full cursor-pointer gap-2.5 border-b border-border px-3 py-2.5 text-left transition-colors duration-(--wt-motion-duration-fast) ease-out hover:bg-surface-muted',
        'before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-transparent',
        selected && 'bg-primary-subtle before:bg-primary hover:bg-primary-subtle',
      )}
    >
      <Avatar name={who} id={row.requesterId} size={24} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-sm">
            <span className={cn('text-foreground', isNew ? 'font-semibold' : 'font-medium')}>
              {who}
            </span>
            {row.orgName ? <span className="text-muted-foreground"> · {row.orgName}</span> : null}
          </span>
          <time
            dateTime={row.updatedAt}
            title={formatDateTime(row.updatedAt, locale)}
            className="tabular ml-auto shrink-0 text-xs whitespace-nowrap text-muted-foreground"
          >
            {formatRelative(row.updatedAt, now, locale)}
          </time>
        </span>
        <span className="flex items-center gap-1.5">
          {isNew ? (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
          ) : null}
          <span
            className={cn(
              'truncate text-sm text-foreground',
              isNew ? 'font-semibold' : 'font-normal',
            )}
          >
            {row.subject}
          </span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono text-xs">{row.key}</span>
          <SeverityBadge
            severity={severityOf(row.priority)}
            label={t(`severity.${severityOf(row.priority)}`)}
            hideLabel
          />
          <StatusLabel status={row.status} className="text-muted-foreground" />
          {row.channel ? <ChannelIcon channel={row.channel} /> : null}
          {row.assigneeName ? (
            <Avatar
              name={row.assigneeName}
              size={20}
              aria-label={t('queue.row.assignedTo', { name: row.assigneeName })}
            />
          ) : row.unassigned ? (
            <span className="sr-only">{t('queue.unassigned')}</span>
          ) : null}
          <SlaBadge sla={row.sla} className="ml-auto" />
        </span>
      </span>
    </li>
  );
}
