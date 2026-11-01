'use client';

import {
  SETTABLE_STATUSES,
  TICKET_PRIORITIES,
  ticketPrioritySchema,
  ticketStatusSchema,
  type BulkAction,
} from '@watchtower/shared';
import { Button, IconButton, Input, Select } from '@watchtower/ui';
import { X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

import { useT } from '@/i18n/provider';
import { useTicketKeyExample } from '@/lib/runtime-config-context';
import { severityOf } from '@/lib/tickets/model';
import { statusKey } from '@/lib/tickets/status-key';

export interface BulkAssignee {
  id: string;
  name: string;
}

export interface BulkBarProps {
  /** How many tickets are selected. */
  count: number;
  /** A request is in flight: the controls wait. */
  busy: boolean;
  assignees: readonly BulkAssignee[];
  /** The person using the queue, offered first as "Me". */
  me: BulkAssignee | null;
  onApply: (action: BulkAction) => void;
  onClear: () => void;
  /** What the last request did, shown under the bar. */
  outcome?: ReactNode;
}

/** The sentinel of the "Unassigned" option (a real user id is a uuid). */
const NOBODY = '__nobody__';

type Pending = { action: BulkAction; summary: string };

/**
 * The bulk bar (docs/06-UI-SPEC.md section 4.2): replaces the filter bar while tickets are selected.
 * "{count} selected" and four actions: assign, status, priority, merge. Picking a value does not act
 * at once: it says what would happen to how many tickets and waits for Apply, so a slip of the hand
 * does not close thirty tickets. There is no reply here; nothing a bulk action does reaches a customer.
 */
export function BulkBar({ count, busy, assignees, me, onApply, onClear, outcome }: BulkBarProps) {
  const t = useT();
  const example = useTicketKeyExample();
  const ids = useId();
  const [pending, setPending] = useState<Pending | null>(null);
  const [merging, setMerging] = useState(false);
  const [target, setTarget] = useState('');

  const others = assignees.filter((person) => person.id !== me?.id);

  const choose = (action: BulkAction, label: string) => {
    setMerging(false);
    setPending({ action, summary: `${label} (${t('bulk.selected', { count })})` });
  };

  const run = (action: BulkAction) => {
    setPending(null);
    setMerging(false);
    setTarget('');
    onApply(action);
  };

  return (
    <div
      role="region"
      aria-label={t('bulk.region')}
      className="border-b border-border/60 bg-primary-subtle"
    >
      <div className="flex min-h-[48px] flex-wrap items-center gap-2 px-3 py-1.5">
        <span className="tabular text-sm font-semibold" role="status">
          {t('bulk.selected', { count })}
        </span>
        <IconButton
          label={t('bulk.clear')}
          icon={<X aria-hidden className="size-4" />}
          onClick={onClear}
          disabled={busy}
        />
        <Select
          aria-label={t('bulk.assign')}
          value=""
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            if (value === '') return;
            const person = assignees.find((entry) => entry.id === value);
            if (value === NOBODY) {
              choose({ type: 'assign', assigneeId: null }, `${t('bulk.assign')}: ${t('bulk.unassign')}`);
            } else if (person) {
              choose({ type: 'assign', assigneeId: person.id }, `${t('bulk.assign')}: ${person.name}`);
            }
          }}
        >
          <option value="">{t('bulk.assignTo')}</option>
          {me ? <option value={me.id}>{t('bulk.assignToMe', { name: me.name })}</option> : null}
          {others.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
          <option value={NOBODY}>{t('bulk.unassign')}</option>
        </Select>
        <Select
          aria-label={t('bulk.status')}
          value=""
          disabled={busy}
          onChange={(event) => {
            const status = ticketStatusSchema.safeParse(event.target.value);
            if (status.success && status.data !== 'merged') {
              choose(
                { type: 'status', status: status.data },
                `${t('bulk.status')}: ${t(statusKey(status.data))}`,
              );
            }
          }}
        >
          <option value="">{t('bulk.statusTo')}</option>
          {SETTABLE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(statusKey(status))}
            </option>
          ))}
        </Select>
        <Select
          aria-label={t('bulk.priority')}
          value=""
          disabled={busy}
          onChange={(event) => {
            const priority = ticketPrioritySchema.safeParse(event.target.value);
            if (priority.success) {
              choose(
                { type: 'priority', priority: priority.data },
                `${t('bulk.priority')}: ${priority.data} ${t(`severity.${severityOf(priority.data)}`)}`,
              );
            }
          }}
        >
          <option value="">{t('bulk.priorityTo')}</option>
          {TICKET_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {priority} {t(`severity.${severityOf(priority)}`)}
            </option>
          ))}
        </Select>
        <Button
          variant="secondary"
          disabled={busy}
          aria-expanded={merging}
          aria-controls={`${ids}-merge`}
          onClick={() => {
            setPending(null);
            setMerging((open) => !open);
          }}
        >
          {t('bulk.merge')}
        </Button>
      </div>

      {pending ? (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-sm">
          <span>{pending.summary}</span>
          <Button
            disabled={busy}
            onClick={() => {
              run(pending.action);
            }}
          >
            {busy ? t('bulk.working') : t('bulk.apply')}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setPending(null);
            }}
          >
            {t('bulk.mergeCancel')}
          </Button>
        </div>
      ) : null}

      <form
        id={`${ids}-merge`}
        hidden={!merging}
        className="flex flex-wrap items-center gap-2 px-3 pb-2 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          const intoTicketId = target.trim();
          if (intoTicketId === '') return;
          run({ type: 'merge', intoTicketId });
        }}
      >
        {merging ? (
          <>
            <label htmlFor={`${ids}-into`} className="font-medium">
              {t('bulk.mergeInto')}
            </label>
            <Input
              id={`${ids}-into`}
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
              }}
              placeholder={example}
              aria-describedby={`${ids}-hint`}
              autoComplete="off"
              className="w-36"
            />
            <Button type="submit" disabled={busy || target.trim() === ''}>
              {t('bulk.mergeSubmit', { count })}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setMerging(false);
              }}
            >
              {t('bulk.mergeCancel')}
            </Button>
            <p id={`${ids}-hint`} className="w-full text-xs text-muted-foreground">
              {t('bulk.mergeHint', { example })}
            </p>
          </>
        ) : null}
      </form>

      {outcome ? <div className="px-3 pb-2 text-sm">{outcome}</div> : null}
    </div>
  );
}
