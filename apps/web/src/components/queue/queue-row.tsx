import { Avatar, cn, IntentChip, SeverityBadge } from '@watchtower/ui';

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
 * One ticket on the triage board, an `option` of a section's listbox
 * (docs/design/ai-first-workspace.md section 2). Keyboard focus stays on the listbox and
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
export function QueueRow({ row, selected, compact = false, group, onSelect }: QueueRowProps) {
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
        'relative mx-2 my-px flex cursor-pointer flex-col justify-center gap-1 rounded-xl px-2.5 text-left transition-colors duration-(--wt-motion-duration-fast) ease-out hover:bg-surface-muted',
        compact ? 'min-h-10 py-1.5' : 'min-h-14 py-2',
        selected && 'bg-primary-subtle hover:bg-primary-subtle',
      )}
    >
      {identity}
      {compact ? (
        <span className="flex min-w-0 items-center gap-2">
          <SeverityBadge severity={severity} label={t(`severity.${severity}`)} hideLabel plain />
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
