import { Avatar, cn, Pill, SeverityBadge } from '@watchtower/ui';

import { AiStateChip } from '@/components/ai/ai-state-chip';
import { ChannelIcon } from '@/components/ticket/channel-icon';
import { SlaBadge } from '@/components/ticket/sla-badge';
import { StatusLabel } from '@/components/ticket/status-label';
import { useI18n } from '@/i18n/provider';
import { type RowModel, severityOf } from '@/lib/tickets/model';

export const rowDomId = (key: string) => `queue-row-${key}`;

/** The id of the active listbox of the queue, the element that holds keyboard focus while it is used. */
export const QUEUE_LISTBOX_ID = 'queue-listbox';

export interface QueueRowProps {
  row: RowModel;
  selected: boolean;
  /** One line (40px) instead of two (56px). */
  compact?: boolean;
  onSelect: (key: string) => void;
}

/** Statuses the row does not spell out: "open" is the normal case and the group says the rest. */
const QUIET_STATUSES = new Set(['new', 'triage', 'open']);

/**
 * One ticket on the triage board, an `option` of a section's listbox
 * (docs/design/ai-first-workspace.md section 2). Keyboard focus stays on the listbox and
 * `aria-activedescendant` names the current row, so arrow keys, J/K and clicks move one pointer.
 *  - line 1: what the AI says is going on, in one line (the subject, muted, when it has said
 *    nothing), and the SLA;
 *  - line 2: priority, intent, the AI's state, then who it is for (organisation avatar) and the
 *    channel. A status is spelled out only when it is not "open".
 * Compact density keeps one line: priority, summary, the AI icon and the SLA.
 * A ticket nobody has touched yet is bold with a dot. The selected row has a 2px navy bar and
 * `aria-selected="true"`. Nothing relies on colour: icons, codes and words carry every state.
 */
export function QueueRow({ row, selected, compact = false, onSelect }: QueueRowProps) {
  const { t } = useI18n();
  const isNew = row.status === 'new';
  const summary = row.ai?.summary?.trim() || null;
  const aiState = row.ai?.state ?? 'none';
  const who = row.requesterName ?? row.key;
  const severity = severityOf(row.priority);
  const title = (
    <span className="flex min-w-0 items-center gap-1.5">
      {isNew ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
      <span
        className={cn(
          'truncate text-sm',
          summary ? 'text-foreground' : 'text-muted-foreground',
          isNew ? 'font-semibold' : 'font-normal',
        )}
        title={summary ? row.subject : undefined}
      >
        {summary ?? row.subject}
      </span>
    </span>
  );
  const identity = (
    <span className="sr-only">
      {row.key}, {who}
      {row.orgName ? `, ${row.orgName}` : ''}
    </span>
  );

  return (
    <li
      id={rowDomId(row.key)}
      role="option"
      aria-selected={selected}
      data-ticket-key={row.key}
      data-ai-state={aiState}
      onClick={() => {
        onSelect(row.key);
      }}
      className={cn(
        'relative flex w-full cursor-pointer flex-col justify-center gap-1 border-b border-border px-3 text-left transition-colors duration-(--wt-motion-duration-fast) ease-out hover:bg-surface-muted',
        'before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-transparent',
        compact ? 'min-h-10 py-1.5' : 'min-h-14 py-2',
        selected && 'bg-primary-subtle before:bg-primary hover:bg-primary-subtle',
      )}
    >
      {identity}
      {compact ? (
        <span className="flex min-w-0 items-center gap-2">
          <SeverityBadge severity={severity} label={t(`severity.${severity}`)} hideLabel />
          <span className="min-w-0 flex-1">{title}</span>
          <AiStateChip state={aiState} iconOnly />
          <SlaBadge sla={row.sla} />
        </span>
      ) : (
        <>
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1">{title}</span>
            <SlaBadge sla={row.sla} />
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <SeverityBadge severity={severity} label={t(`severity.${severity}`)} hideLabel />
            {row.intentName ? (
              <Pill className="min-w-0 max-w-[9rem] shrink font-normal text-muted-foreground">
                <span className="truncate">{row.intentName}</span>
              </Pill>
            ) : null}
            <AiStateChip state={aiState} />
            {QUIET_STATUSES.has(row.status) ? null : (
              <StatusLabel status={row.status} className="text-muted-foreground" />
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
              {row.orgName ? (
                <span title={row.orgName}>
                  <Avatar name={row.orgName} size={20} aria-hidden />
                </span>
              ) : null}
              {row.channel ? <ChannelIcon channel={row.channel} /> : null}
            </span>
          </span>
        </>
      )}
    </li>
  );
}
