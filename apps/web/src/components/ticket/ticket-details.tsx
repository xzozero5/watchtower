'use client';

import {
  TICKET_PRIORITIES,
  type TicketPriority,
  type TicketStatus,
  type TicketSummary,
} from '@watchtower/shared';
import { Alert, Avatar, Combobox, type ComboboxOption, Pill, SeverityBadge } from '@watchtower/ui';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';

import { useI18n } from '@/i18n/provider';
import type { MessageKey, Translate } from '@/i18n';
import { isApiError } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { useAssignees } from '@/lib/shifts/queries';
import { isStaffTicket, isDetail, severityOf, type TicketItem } from '@/lib/tickets/model';
import { useSlaPolicies } from '@/lib/admin/queries';
import { dueNote, type DueNote } from '@/lib/tickets/sla';
import { useIntents, useTicketMutations, useTimeline, useWorkflow } from '@/lib/tickets/queries';
import { statusKey } from '@/lib/tickets/status-key';
import { allowedNextStatuses } from '@/lib/tickets/templates';

import { ChannelIcon } from './channel-icon';
import { StatusLabel } from './status-label';
import { awaitsFirstAnswer } from './waiting-on-customer';
import { WaitingCustomerConfirm } from './waiting-customer-confirm';
import { useOptimisticEdit } from './use-optimistic-edit';

/** The id of the status field, so the S shortcut can move focus to it. */
export const STATUS_FIELD_ID = 'ticket-field-status';

const UNASSIGNED = '';
const NO_INTENT = '';

function saveErrorKey(error: unknown): MessageKey {
  if (isApiError(error)) {
    if (error.code === 'invalid_transition') return 'details.errors.invalidTransition';
    if (error.code === 'ticket_not_open') return 'details.errors.ticketNotOpen';
    if (error.code === 'forbidden') return 'details.errors.forbidden';
    if (error.code === 'network') return 'details.errors.network';
  }
  return 'details.errors.generic';
}

/** One label and its value. The value is plain text or an inline field that looks like text. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-row grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-2 px-4">
      <dt className="pt-[7px] text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 py-[3px] text-sm">{children}</dd>
    </div>
  );
}

function noDueText(note: DueNote | null, t: Translate): string {
  if (note?.kind === 'noPolicy') return t('details.noPolicy');
  if (note?.kind === 'noTarget') {
    return t('details.noTarget', { priority: note.priority, policy: note.policyName });
  }
  return t('details.none');
}

const Empty = ({ children }: { children: ReactNode }) => (
  <span className="text-muted-foreground">{children}</span>
);

/**
 * Status, priority, assignee, intent and tags of the open ticket, as label and value rows. Anyone
 * who can handle tickets edits a value in place (it looks like text until hovered, then opens a
 * searchable list); everyone else, a customer included, sees the same facts read-only. A change is
 * shown at once and saved in the background; a toast offers Undo.
 */
export function TicketDetails({ ticket }: { ticket: TicketItem }) {
  const { t, locale } = useI18n();
  const { can, session } = useSession();
  const ids = useId();
  const canEdit = can('ticket.handle');
  const staff = isStaffTicket(ticket);

  const mutations = useTicketMutations(ticket.key);
  const intents = useIntents(canEdit);
  // Every active agent, lead and head, the ticket's queue members first (the api marks them `inQueue`).
  const people = useAssignees(canEdit, staff ? ticket.queue?.id : undefined);
  const workflow = useWorkflow(canEdit);
  const edit = useOptimisticEdit(ticket);
  // Only staff move a ticket to Waiting on customer; the thread tells whether the customer was asked.
  const timeline = useTimeline(canEdit && staff ? ticket.key : null);
  const [confirmWaiting, setConfirmWaiting] = useState(false);
  const policies = useSlaPolicies(staff);

  const failure = [mutations.changeStatus, mutations.assign, mutations.update].find(
    (mutation) => mutation.isError,
  );
  const busy =
    mutations.changeStatus.isPending || mutations.assign.isPending || mutations.update.isPending;

  const assignees = useMemo(() => {
    const byId = new Map<string, string>();
    const members = new Set<string>();
    const listed = [...(people.data?.assignees ?? [])].sort(
      (a, b) => Number(b.inQueue) - Number(a.inQueue) || a.name.localeCompare(b.name),
    );
    for (const person of listed) {
      byId.set(person.id, person.name);
      if (person.inQueue) members.add(person.id);
    }
    if (staff && ticket.assignee && !byId.has(ticket.assignee.id)) {
      byId.set(ticket.assignee.id, ticket.assignee.name);
    }
    // Me stays in the list even if the api left me out; the others keep the api's order.
    if (session && !byId.has(session.user.id)) byId.set(session.user.id, session.user.name);
    return [...byId].map(([id, name]) => ({ id, name, inQueue: members.has(id) }));
  }, [people.data, session, staff, ticket]);

  const activeIntents = (intents.data?.intents ?? []).filter(
    (intent) => !('isActive' in intent) || intent.isActive,
  );

  const summary: TicketSummary | null = staff ? ticket : null;
  const policy = summary
    ? policies.data?.policies.find((entry) => entry.id === summary.slaPolicyId)
    : undefined;
  const note = summary ? dueNote(summary, policy) : null;
  /** The clock the due time counts on; the policy's target says it, the running target's view backs it up. */
  const businessHours = (target: 'first_response' | 'resolution') => {
    if (!summary) return false;
    const fromPolicy = policy?.targets[summary.priority]?.calendar;
    const calendar =
      fromPolicy ?? (summary.sla?.target === target ? summary.sla.calendar : undefined);
    return calendar === 'business';
  };
  const label = (value: TicketPriority) => `${value} ${t(`severity.${severityOf(value)}`)}`;

  // ---- status ----
  const changeStatus = (status: string, silent = false, confirmed = false) => {
    const next = allowedNextStatuses(workflow.data, ticket.status).find(
      (value) => value === status,
    );
    if (!next) return;
    // Warn, never block: the customer would see "waiting for your reply" with no question.
    if (
      next === 'waiting_on_customer' &&
      !silent &&
      !confirmed &&
      timeline.data &&
      awaitsFirstAnswer(timeline.data.pages.flatMap((page) => page.entries))
    ) {
      setConfirmWaiting(true);
      return;
    }
    const previous = ticket.status;
    // Going back is only offered when the workflow allows the move from the new status.
    const canGoBack = allowedNextStatuses(workflow.data, next).includes(previous);
    edit.run({
      optimistic: { ...ticket, status: next },
      message: silent
        ? t('details.undone')
        : t('details.changed.status', { value: t(statusKey(next)) }),
      undo:
        silent || !canGoBack
          ? undefined
          : () => {
              latest.current.changeStatus(previous, true);
            },
      send: (callbacks) => {
        mutations.changeStatus.mutate({ status: next }, callbacks);
      },
    });
  };

  // ---- priority ----
  const changePriority = (value: string, silent = false) => {
    const priority = TICKET_PRIORITIES.find((entry) => entry === value);
    if (!priority || priority === ticket.priority) return;
    const previous = ticket.priority;
    edit.run({
      optimistic: { ...ticket, priority },
      message: silent
        ? t('details.undone')
        : t('details.changed.priority', { value: label(priority) }),
      undo: silent
        ? undefined
        : () => {
            latest.current.changePriority(previous, true);
          },
      send: (callbacks) => {
        mutations.update.mutate({ priority }, callbacks);
      },
    });
  };

  // ---- assignee ----
  const changeAssignee = (value: string, silent = false) => {
    if (!summary) return;
    const person = assignees.find((entry) => entry.id === value);
    const assigneeId = value === UNASSIGNED ? null : value;
    if (assigneeId === (summary.assignee?.id ?? null)) return;
    const previous = summary.assignee?.id ?? UNASSIGNED;
    edit.run({
      optimistic: {
        ...ticket,
        assignee: assigneeId && person ? { id: assigneeId, name: person.name } : null,
      },
      message: silent
        ? t('details.undone')
        : person
          ? t('details.changed.assignee', { value: person.name })
          : t('details.changed.unassigned'),
      undo: silent
        ? undefined
        : () => {
            latest.current.changeAssignee(previous, true);
          },
      send: (callbacks) => {
        mutations.assign.mutate({ assigneeId }, callbacks);
      },
    });
  };

  // ---- intent ----
  const changeIntent = (value: string, silent = false) => {
    if (!summary || value === (summary.intent?.id ?? NO_INTENT)) return;
    const picked = activeIntents.find((entry) => entry.id === value);
    const previous = summary.intent?.id ?? NO_INTENT;
    edit.run({
      optimistic: {
        ...summary,
        intent: picked ? { id: picked.id, key: picked.key, name: picked.name } : null,
      },
      message: silent
        ? t('details.undone')
        : t('details.changed.intent', { value: picked?.name ?? t('details.noIntent') }),
      undo: silent
        ? undefined
        : () => {
            latest.current.changeIntent(previous, true);
          },
      send: (callbacks) => {
        mutations.update.mutate({ intentId: value === NO_INTENT ? null : value }, callbacks);
      },
    });
  };

  // ---- tags ----
  const setTags = (tags: string[], silent = false) => {
    if (!summary) return;
    const previous = summary.tags;
    edit.run({
      optimistic: { ...ticket, tags },
      message: silent ? t('details.undone') : t('details.changed.tags'),
      undo: silent
        ? undefined
        : () => {
            latest.current.setTags(previous, true);
          },
      send: (callbacks) => {
        mutations.update.mutate({ tags }, callbacks);
      },
    });
  };

  // Undo runs later, after the ticket changed, so it must call the newest handlers, not these.
  const latest = useRef({ changeStatus, changePriority, changeAssignee, changeIntent, setTags });
  useEffect(() => {
    latest.current = { changeStatus, changePriority, changeAssignee, changeIntent, setTags };
  });

  const statusOptions: ComboboxOption[] = [
    ticket.status,
    ...allowedNextStatuses(workflow.data, ticket.status),
  ].map((status: TicketStatus) => ({ value: status, label: t(statusKey(status)) }));

  const priorityOptions: ComboboxOption[] = TICKET_PRIORITIES.map((priority) => ({
    value: priority,
    label: label(priority),
    keywords: [priority],
  }));

  const assigneeOptions: ComboboxOption[] = [
    { value: UNASSIGNED, label: t('details.unassigned') },
    ...assignees.map((person) => ({
      value: person.id,
      label:
        person.id === session?.user.id
          ? t('details.assigneeMe', { name: person.name })
          : person.name,
      keywords: [person.name],
    })),
  ];

  const intentOptions: ComboboxOption[] = [
    { value: NO_INTENT, label: t('details.noIntent') },
    ...(ticket.intent && !activeIntents.some((intent) => intent.id === ticket.intent?.id)
      ? [{ value: ticket.intent.id, label: ticket.intent.name }]
      : []),
    ...activeIntents.map((intent) => ({ value: intent.id, label: intent.name })),
  ];

  const common = {
    searchPlaceholder: t('details.search'),
    emptyText: t('details.noMatches'),
    selectedText: t('details.selected'),
    disabled: busy,
  };

  const assigneeName = summary?.assignee
    ? summary.assignee.id === session?.user.id
      ? t('details.assigneeMe', { name: summary.assignee.name })
      : summary.assignee.name
    : t('details.unassigned');

  return (
    <section aria-label={t('details.title')} className="flex flex-col gap-1 py-2">
      <dl aria-label={t('details.listLabel')} className="flex flex-col">
        <Row label={t('details.status')}>
          {canEdit ? (
            <Combobox
              {...common}
              fieldLabel={t('details.status')}
              listLabel={t('details.status')}
              options={statusOptions}
              value={ticket.status}
              onValueChange={changeStatus}
              id={STATUS_FIELD_ID}
            >
              <StatusLabel status={ticket.status} className="text-sm font-normal" />
            </Combobox>
          ) : (
            <StatusLabel status={ticket.status} className="text-sm font-normal" />
          )}
        </Row>

        <Row label={t('details.priority')}>
          {canEdit ? (
            <Combobox
              {...common}
              fieldLabel={t('details.priority')}
              listLabel={t('details.priority')}
              options={priorityOptions}
              value={ticket.priority}
              onValueChange={changePriority}
            >
              <SeverityBadge
                severity={severityOf(ticket.priority)}
                label={t(`severity.${severityOf(ticket.priority)}`)}
              />
            </Combobox>
          ) : (
            <SeverityBadge
              severity={severityOf(ticket.priority)}
              label={t(`severity.${severityOf(ticket.priority)}`)}
            />
          )}
        </Row>

        {summary ? (
          <Row label={t('details.assignee')}>
            {canEdit ? (
              <Combobox
                {...common}
                fieldLabel={t('details.assignee')}
                listLabel={t('details.assignee')}
                options={assigneeOptions}
                value={summary.assignee?.id ?? UNASSIGNED}
                onValueChange={changeAssignee}
              >
                {summary.assignee ? (
                  <>
                    <Avatar name={summary.assignee.name} id={summary.assignee.id} size={20} />
                    <span className="truncate">{assigneeName}</span>
                  </>
                ) : (
                  <Empty>{t('details.unassigned')}</Empty>
                )}
              </Combobox>
            ) : summary.assignee ? (
              <span className="inline-flex items-center gap-2">
                <Avatar name={summary.assignee.name} id={summary.assignee.id} size={20} />
                {summary.assignee.name}
              </span>
            ) : (
              <Empty>{t('details.unassigned')}</Empty>
            )}
            {canEdit && people.data?.scope === 'all_staff' ? (
              <span
                data-testid="assignee-scope"
                className="block px-2 text-xs text-muted-foreground"
              >
                {t('details.assigneeAllStaff')}
              </span>
            ) : null}
          </Row>
        ) : null}

        <Row label={t('details.intent')}>
          {canEdit ? (
            <Combobox
              {...common}
              fieldLabel={t('details.intent')}
              listLabel={t('details.intent')}
              options={intentOptions}
              value={ticket.intent?.id ?? NO_INTENT}
              onValueChange={changeIntent}
            >
              {ticket.intent ? (
                <span className="truncate">{ticket.intent.name}</span>
              ) : (
                <Empty>{t('details.noIntent')}</Empty>
              )}
            </Combobox>
          ) : ticket.intent ? (
            <span>{ticket.intent.name}</span>
          ) : (
            <Empty>{t('details.noIntent')}</Empty>
          )}
        </Row>

        {summary ? (
          <Row label={t('details.tags')}>
            {canEdit ? (
              <Combobox
                {...common}
                multiple
                fieldLabel={t('details.tags')}
                listLabel={t('details.tags')}
                searchPlaceholder={t('details.searchTag')}
                options={summary.tags.map((tag) => ({ value: tag, label: tag }))}
                values={summary.tags}
                onToggle={(tag) => {
                  setTags(
                    summary.tags.includes(tag)
                      ? summary.tags.filter((entry) => entry !== tag)
                      : [...summary.tags, tag],
                  );
                }}
                onCreate={(tag) => {
                  if (!summary.tags.includes(tag)) setTags([...summary.tags, tag]);
                }}
                createLabel={(tag) => t('details.createTag', { tag })}
              >
                <TagList tags={summary.tags} empty={t('details.noTags')} />
              </Combobox>
            ) : (
              <TagList tags={summary.tags} empty={t('details.noTags')} />
            )}
          </Row>
        ) : null}
      </dl>

      {summary ? (
        <dl className="mt-1 flex flex-col border-t border-border pt-2">
          <Row label={t('details.organization')}>{summary.org.name}</Row>
          {isDetail(summary) && summary.requester ? (
            <Row label={t('details.requester')}>
              <span>{summary.requester.name}</span>
              {summary.requester.email ? (
                <span className="block truncate text-xs text-muted-foreground">
                  {summary.requester.email}
                </span>
              ) : null}
            </Row>
          ) : null}
          <Row label={t('details.channel')}>
            <span className="inline-flex items-center gap-1.5">
              <ChannelIcon channel={summary.channel} />
              {t(`channel.${summary.channel}`)}
            </span>
          </Row>
          <Row label={t('details.firstResponseDue')}>
            <span className="tabular">
              {summary.firstRespondedAt
                ? t('details.done')
                : summary.firstResponseDueAt
                  ? formatDateTime(summary.firstResponseDueAt, locale)
                  : noDueText(note, t)}
            </span>
            {!summary.firstRespondedAt &&
            summary.firstResponseDueAt &&
            businessHours('first_response') ? (
              <span className="block text-xs text-muted-foreground">
                {t('details.businessHours')}
              </span>
            ) : null}
          </Row>
          <Row label={t('details.resolutionDue')}>
            <span className="tabular">
              {summary.slaPausedAt
                ? t('details.slaPaused')
                : summary.resolutionDueAt
                  ? formatDateTime(summary.resolutionDueAt, locale)
                  : noDueText(note, t)}
            </span>
            {!summary.slaPausedAt && summary.resolutionDueAt && businessHours('resolution') ? (
              <span className="block text-xs text-muted-foreground">
                {t('details.businessHours')}
              </span>
            ) : null}
          </Row>
          <Row label={t('details.created')}>
            <span className="tabular">{formatDateTime(ticket.createdAt, locale)}</span>
          </Row>
        </dl>
      ) : (
        <dl className="flex flex-col">
          <Row label={t('details.created')}>
            <span className="tabular">{formatDateTime(ticket.createdAt, locale)}</span>
          </Row>
        </dl>
      )}

      {summary?.mergedIntoKey ? (
        <p className="px-4 pt-1 text-sm text-muted-foreground">
          {t('details.mergedInto', { key: summary.mergedIntoKey })}
        </p>
      ) : null}

      <WaitingCustomerConfirm
        open={confirmWaiting}
        onOpenChange={setConfirmWaiting}
        onConfirm={() => {
          changeStatus('waiting_on_customer', false, true);
        }}
      />

      <div
        id={`${ids}-status`}
        role="status"
        className="min-h-5 px-4 text-xs text-muted-foreground"
      >
        {busy ? t('details.saving') : edit.saved && !failure ? t('details.saved') : null}
      </div>
      {failure ? (
        <div className="px-4">
          <Alert tone="error" title={t('details.errors.title')}>
            {t(saveErrorKey(failure.error))}
          </Alert>
        </div>
      ) : null}
    </section>
  );
}

function TagList({ tags, empty }: { tags: readonly string[]; empty: string }) {
  if (tags.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <li key={tag}>
          <Pill className="font-normal">{tag}</Pill>
        </li>
      ))}
    </ul>
  );
}
