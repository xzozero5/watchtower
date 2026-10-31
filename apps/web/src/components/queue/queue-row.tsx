import { cn, SeverityBadge } from '@watchtower/ui';
import { UserRound } from 'lucide-react';

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
 * same pointer. Priority is an icon + code, the status an icon + words, and the SLA state an icon
 * + words: nothing relies on colour. The selected row has a bar, a background and
 * `aria-selected="true"`.
 */
export function QueueRow({ row, selected, now, onSelect }: QueueRowProps) {
  const { t, locale } = useI18n();
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
        'flex min-h-row w-full cursor-pointer flex-col gap-1 border-b border-l-4 border-l-transparent px-pane py-2 text-left hover:bg-surface-muted',
        selected && 'border-l-primary bg-surface-muted',
      )}
    >
      <span className="flex items-center gap-2">
        <SeverityBadge
          severity={severityOf(row.priority)}
          label={t(`severity.${severityOf(row.priority)}`)}
          hideLabel
        />
        <span className="font-mono text-xs text-muted-foreground">{row.key}</span>
        <SlaBadge sla={row.sla} className="ml-auto" />
      </span>
      <span className="truncate text-sm font-medium text-foreground">{row.subject}</span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <StatusLabel status={row.status} />
        {row.orgName ? <span className="truncate">{row.orgName}</span> : null}
        {row.assigneeName ? (
          <span className="inline-flex items-center gap-1">
            <UserRound aria-hidden className="size-3.5" />
            {row.assigneeName}
          </span>
        ) : row.unassigned ? (
          <span className="inline-flex items-center gap-1">
            <UserRound aria-hidden className="size-3.5" />
            {t('queue.unassigned')}
          </span>
        ) : null}
        <time
          dateTime={row.updatedAt}
          title={formatDateTime(row.updatedAt, locale)}
          className="ml-auto whitespace-nowrap"
        >
          {formatRelative(row.updatedAt, now, locale)}
        </time>
      </span>
    </li>
  );
}
