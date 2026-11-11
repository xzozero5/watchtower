import { Avatar, cn, IntentChip, SeverityBadge } from '@watchtower/ui';
import { Check, UserRound, Sparkles } from 'lucide-react';

import { AiStateChip } from '@/components/ai/ai-state-chip';
import { ChannelIcon } from '@/components/ticket/channel-icon';
import { SlaBadge } from '@/components/ticket/sla-badge';
import { StatusChip, useStatusWords } from '@/components/ticket/status-label';
import { useI18n, useT } from '@/i18n/provider';
import type { RowGroup } from '@/lib/ai/model';
import { type RowModel, severityOf } from '@/lib/tickets/model';

export const rowDomId = (key: string) => `queue-row-${key}`;

/** The id of the active listbox of the queue, the element that holds keyboard focus while it is used. */
export const QUEUE_LISTBOX_ID = 'queue-listbox';

export interface QueueRowProps {
  row: RowModel;
  selected: boolean;
  /** One line (40px) instead of two (56px). */
  compact?: boolean;
  /** The section the row is drawn in: a status that only repeats it is not drawn again. */
  group?: RowGroup['id'];
  onSelect: (key: string) => void;
  /** Staff can tick rows for a bulk action (T-119d); a customer's queue has no checkbox. */
  selectable?: boolean;
  /** The row is ticked. Not the same as `selected`, which is the ticket open in the conversation. */
  checked?: boolean;
  /** At least one row is ticked anywhere: every checkbox shows, not only on hover. */
  selecting?: boolean;
  onToggleChecked?: (key: string) => void;
}

/** Statuses the row does not spell out: "open" is the normal case and the group says the rest. */
const QUIET_STATUSES = new Set(['new', 'triage', 'open']);

/**
 * The one status slot of a row: the workflow status when it says something (waiting on whom,
 * resolved), else the AI's state. It is the only filled pill on the row. A status that merely
 * repeats the section the row sits in ("Needs you" under Needs you) is not drawn, but its words
 * stay for screen readers.
 */
function RowStatus({ row, group }: { row: RowModel; group: RowGroup['id'] | undefined }) {
  const t = useT();
  const workflow = useStatusWords(row.status);
  const aiState = row.ai?.state ?? 'none';
  if (!QUIET_STATUSES.has(row.status)) {
    return group === 'done' && row.status === 'resolved' ? (
      <span className="sr-only">{workflow.words}</span>
    ) : (
      <StatusChip status={row.status} className="max-w-full" />
    );
  }
  if (aiState === 'none') return null;
  const redundant =
    (group === 'needsYou' && aiState === 'needs_human') ||
    (group === 'aiWorking' && aiState === 'investigating');
  return redundant ? (
    <span className="sr-only">{t(`ai.state.${aiState}`)}</span>
  ) : (
    <AiStateChip state={aiState} className="max-w-full" />
  );
}

/**
 * The SLA slot of a row: always there, so the column does not jump. The running SLA as the badge
 * shows it, or a muted "No SLA" when none applies (docs/06-UI-SPEC.md section 4.4). A customer's
 * row has no SLA to speak of and keeps the slot empty.
 */
function SlaSlot({ row }: { row: RowModel }) {
  const t = useT();
  if (row.sla.state !== 'none') return <SlaBadge sla={row.sla} />;
  if (row.channel === null) return null;
  return (
    <span data-sla="none" className="shrink-0 text-xs text-muted-foreground">
      {t('sla.none')}
    </span>
  );
}

/** Who holds the ticket: their avatar, or a muted person icon when nobody does. */
function AssigneeMark({ row }: { row: RowModel }) {
  const t = useT();
  if (row.channel === null) return null;
  if (row.assigneeName) {
    const label = t('queue.row.assignedTo', { name: row.assigneeName });
    return (
      <span title={label} data-assignee>
        <Avatar name={row.assigneeName} size={20} aria-hidden />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span title={t('queue.unassigned')} data-assignee="none" className="text-muted-foreground">
      <UserRound aria-hidden className="size-4" />
      <span className="sr-only">{t('queue.unassigned')}</span>
    </span>
  );
}

/**
 * One ticket on the triage board, an `option` of a section's listbox
 * (docs/design/ai-first-workspace.md section 2; QA-01: key first, SLA slot always present). Keyboard focus stays on the listbox and
 * `aria-activedescendant` names the current row, so arrow keys, J/K and clicks move one pointer.
 *  - line 1: what the AI says is going on, in one line (the subject, muted, when it has said
 *    nothing), and the SLA;
 *  - line 2, one style per role: priority as a coloured icon and code (no pill, P1 keeps its
 *    pill), the intent as muted metadata (small icon and text, no fill), then one status slot, the
 *    only filled pill, in a fixed column; who it is for (organisation avatar) and the channel
 *    close the line. The SLA timer is outlined, so it never reads as a status.
 * Compact density keeps one line: priority, summary, the AI icon and the SLA.
 * A ticket nobody has touched yet is bold with a dot. The selected row is a soft tinted pill with
 * `aria-selected="true"`. Nothing relies on colour: icons, codes and words carry every state
 * (docs/design/friendly-polish.md).
 */
export function QueueRow({
  row,
  selected,
  compact = false,
  group,
  onSelect,
  selectable = false,
  checked = false,
  selecting = false,
  onToggleChecked,
}: QueueRowProps) {
  const { t } = useI18n();
  const isNew = row.status === 'new';
  const summary = row.ai?.summary?.trim() || null;
  const aiState = row.ai?.state ?? 'none';
  const who = row.requesterName ?? row.key;
  const severity = severityOf(row.priority);
  const title = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span aria-hidden className="tabular shrink-0 text-xs text-muted-foreground">
        {row.key}
      </span>
      {isNew ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
      <span
        className={cn(
          'truncate text-sm',
          'text-foreground',
          isNew ? 'font-semibold' : 'font-normal',
        )}
      >
        {row.subject}
      </span>
    </span>
  );
  const identity = (
    <span className="sr-only">
      {row.key}, {who}
      {row.orgName ? `, ${row.orgName}` : ''}
      {checked ? `, ${t('bulk.rowSelected')}` : ''}
    </span>
  );

  return (
    <li
      id={rowDomId(row.key)}
      role="option"
      aria-selected={selected}
      data-ticket-key={row.key}
      data-ai-state={aiState}
      data-checked={selectable ? checked : undefined}
      onClick={() => {
        onSelect(row.key);
      }}
      className={cn(
        'group relative mx-2 my-px flex cursor-pointer flex-col justify-center gap-1 rounded-inner px-2.5 text-left transition-[background-color,box-shadow,transform] duration-(--wt-motion-duration-fast) ease-out hover:bg-surface-muted',
        compact ? 'min-h-10 py-1.5' : 'min-h-14 py-2',
        selectable && 'pl-8',
        // Soft Beacon: the open ticket is a lifted grey card in the list.
        selected && 'bg-surface-muted shadow-lift ring-1 ring-border hover:bg-surface-muted',
        checked && !selected && 'bg-surface-muted',
      )}
    >
      {selectable ? (
        // The mouse way to tick a row; the keyboard way is X on the open ticket. A box drawn on the
        // row, not a form control: a control inside an option cannot be reached as one (axe
        // `nested-interactive`), and the listbox is the one tab stop. Whether the row is ticked is
        // said in the option's own words (`identity`) and by `data-checked`.
        <span
          aria-hidden
          title={t('bulk.selectRow', { key: row.key })}
          data-select-toggle={row.key}
          onClick={(event) => {
            event.stopPropagation();
            onToggleChecked?.(row.key);
          }}
          className={cn(
            'absolute top-1/2 left-2.5 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm border',
            checked
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border-strong bg-surface',
            !(checked || selecting) && 'opacity-0 group-hover:opacity-100',
          )}
        >
          {checked ? <Check aria-hidden className="size-3" /> : null}
        </span>
      ) : null}
      {identity}
      {compact ? (
        <span className="flex min-w-0 items-center gap-2">
          <SeverityBadge severity={severity} label={t(`severity.${severity}`)} hideLabel plain />
          <span className="min-w-0 flex-1">{title}</span>
          <AiStateChip state={aiState} iconOnly />
          <SlaSlot row={row} />
        </span>
      ) : (
        <>
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1">{title}</span>
            <SlaSlot row={row} />
          </span>
          {summary ? (
            <span
              data-ai-summary
              className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span className="inline-flex shrink-0 items-center gap-0.5 font-medium">
                <Sparkles className="size-3" />
                {t('queue.row.aiLabel')}
              </span>
              <span className="truncate">{summary}</span>
            </span>
          ) : null}
          <span className="flex min-w-0 items-center gap-2">
            <SeverityBadge severity={severity} label={t(`severity.${severity}`)} hideLabel plain />
            {row.intentName ? (
              <IntentChip
                plain
                intentKey={row.intentKey ?? row.intentName}
                name={row.intentName}
                className="min-w-0 shrink"
              />
            ) : null}
            <span className="ml-auto flex w-[7.5rem] shrink-0 justify-end">
              <RowStatus row={row} group={group} />
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
              <AssigneeMark row={row} />
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
