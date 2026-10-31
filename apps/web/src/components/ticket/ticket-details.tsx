'use client';

import { TICKET_PRIORITIES, type TicketPriority, type TicketStatus } from '@watchtower/shared';
import { Alert, Button, Input, Select } from '@watchtower/ui';
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import { type SyntheticEvent, type ReactNode, useId, useMemo, useRef, useState } from 'react';

import { useI18n } from '@/i18n/provider';
import type { MessageKey } from '@/i18n';
import { isApiError } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { useShortcut } from '@/lib/keyboard';
import { isStaffTicket, isDetail, severityOf, type TicketItem } from '@/lib/tickets/model';
import { useIntents, useQueues, useTicketMutations, useWorkflow } from '@/lib/tickets/queries';
import { statusKey } from '@/lib/tickets/status-key';
import { allowedNextStatuses } from '@/lib/tickets/templates';

import { StatusLabel } from './status-label';

const UNASSIGNED = '';

function saveErrorKey(error: unknown): MessageKey {
  if (isApiError(error)) {
    if (error.code === 'invalid_transition') return 'details.errors.invalidTransition';
    if (error.code === 'ticket_not_open') return 'details.errors.ticketNotOpen';
    if (error.code === 'forbidden') return 'details.errors.forbidden';
    if (error.code === 'network') return 'details.errors.network';
  }
  return 'details.errors.generic';
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/**
 * Status, priority, assignee, intent and tags of the open ticket. Anyone who can handle tickets
 * edits them in place (each change is saved at once and the result replaces the ticket
 * everywhere); everyone else, a customer included, sees the same facts read-only.
 */
export function TicketDetails({ ticket }: { ticket: TicketItem }) {
  const { t, locale } = useI18n();
  const { can, session } = useSession();
  const ids = useId();
  const canEdit = can('ticket.handle');
  const staff = isStaffTicket(ticket);
  const [open, setOpen] = useState(true);
  const [saved, setSaved] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const statusRef = useRef<HTMLSelectElement>(null);

  const mutations = useTicketMutations(ticket.key);
  const intents = useIntents(canEdit);
  const queues = useQueues(canEdit);
  const workflow = useWorkflow(canEdit);

  const failure = [mutations.changeStatus, mutations.assign, mutations.update].find(
    (mutation) => mutation.isError,
  );
  const busy =
    mutations.changeStatus.isPending || mutations.assign.isPending || mutations.update.isPending;

  useShortcut(
    's',
    () => {
      setOpen(true);
      // Wait for the section to render before moving focus into it.
      setTimeout(() => statusRef.current?.focus(), 0);
    },
    canEdit,
  );

  const assignees = useMemo(() => {
    const byId = new Map<string, string>();
    if (session) byId.set(session.user.id, session.user.name);
    for (const queue of queues.data?.queues ?? []) {
      for (const member of queue.members) byId.set(member.userId, member.name);
    }
    if (staff && ticket.assignee) byId.set(ticket.assignee.id, ticket.assignee.name);
    return [...byId].map(([id, name]) => ({ id, name }));
  }, [queues.data, session, staff, ticket]);

  const activeIntents = (intents.data?.intents ?? []).filter(
    (intent) => !('isActive' in intent) || intent.isActive,
  );

  const after = {
    onSuccess: () => {
      setSaved(true);
    },
  };
  const changeStatus = (status: string) => {
    const next = allowedNextStatuses(workflow.data, ticket.status).find(
      (value) => value === status,
    );
    if (!next) return;
    setSaved(false);
    mutations.changeStatus.mutate({ status: next }, after);
  };
  const changePriority = (value: string) => {
    const priority = TICKET_PRIORITIES.find((entry) => entry === value);
    if (!priority || priority === ticket.priority) return;
    setSaved(false);
    mutations.update.mutate({ priority }, after);
  };
  const changeAssignee = (value: string) => {
    setSaved(false);
    mutations.assign.mutate({ assigneeId: value === UNASSIGNED ? null : value }, after);
  };
  const changeIntent = (value: string) => {
    setSaved(false);
    mutations.update.mutate({ intentId: value === '' ? null : value }, after);
  };
  const setTags = (tags: string[]) => {
    setSaved(false);
    mutations.update.mutate({ tags }, after);
  };
  const addTag = (event: SyntheticEvent) => {
    event.preventDefault();
    const tag = tagDraft.trim();
    if (!staff || tag === '' || ticket.tags.includes(tag)) {
      setTagDraft('');
      return;
    }
    setTags([...ticket.tags, tag]);
    setTagDraft('');
  };

  const statusOptions: TicketStatus[] = [
    ticket.status,
    ...allowedNextStatuses(workflow.data, ticket.status),
  ];
  const regionId = `${ids}-details`;

  return (
    <section aria-label={t('details.title')} className="border-b border-border">
      <h3 className="px-pane py-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          aria-keyshortcuts={canEdit ? 's' : undefined}
          onClick={() => {
            setOpen((value) => !value);
          }}
          className="flex w-full items-center gap-1 text-sm font-semibold"
        >
          {open ? (
            <ChevronDown aria-hidden className="size-4" />
          ) : (
            <ChevronRight aria-hidden className="size-4" />
          )}
          {t('details.title')}
        </button>
      </h3>

      <div id={regionId} hidden={!open} className="px-pane pb-3">
        {open ? (
          <>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Field label={t('details.status')}>
                {canEdit ? (
                  <Select
                    ref={statusRef}
                    aria-label={t('details.status')}
                    value={ticket.status}
                    disabled={busy}
                    onChange={(event) => {
                      changeStatus(event.target.value);
                    }}
                    className="w-full"
                  >
                    {statusOptions.map((status) => (
                      <option key={status} value={status}>
                        {t(statusKey(status))}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <StatusLabel status={ticket.status} />
                )}
              </Field>

              <Field label={t('details.priority')}>
                {canEdit ? (
                  <Select
                    aria-label={t('details.priority')}
                    value={ticket.priority}
                    disabled={busy}
                    onChange={(event) => {
                      changePriority(event.target.value);
                    }}
                    className="w-full"
                  >
                    {TICKET_PRIORITIES.map((priority: TicketPriority) => (
                      <option key={priority} value={priority}>
                        {priority} {t(`severity.${severityOf(priority)}`)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span>
                    {ticket.priority} {t(`severity.${severityOf(ticket.priority)}`)}
                  </span>
                )}
              </Field>

              {staff ? (
                <Field label={t('details.assignee')}>
                  {canEdit ? (
                    <Select
                      aria-label={t('details.assignee')}
                      value={ticket.assignee?.id ?? UNASSIGNED}
                      disabled={busy}
                      onChange={(event) => {
                        changeAssignee(event.target.value);
                      }}
                      className="w-full"
                    >
                      <option value={UNASSIGNED}>{t('details.unassigned')}</option>
                      {assignees.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.id === session?.user.id
                            ? t('details.assigneeMe', { name: person.name })
                            : person.name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span>{ticket.assignee?.name ?? t('details.unassigned')}</span>
                  )}
                </Field>
              ) : null}

              <Field label={t('details.intent')}>
                {canEdit ? (
                  <Select
                    aria-label={t('details.intent')}
                    value={ticket.intent?.id ?? ''}
                    disabled={busy}
                    onChange={(event) => {
                      changeIntent(event.target.value);
                    }}
                    className="w-full"
                  >
                    <option value="">{t('details.noIntent')}</option>
                    {ticket.intent &&
                    !activeIntents.some((intent) => intent.id === ticket.intent?.id) ? (
                      <option value={ticket.intent.id}>{ticket.intent.name}</option>
                    ) : null}
                    {activeIntents.map((intent) => (
                      <option key={intent.id} value={intent.id}>
                        {intent.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span>{ticket.intent?.name ?? t('details.noIntent')}</span>
                )}
              </Field>

              {staff ? (
                <>
                  <Field label={t('details.organization')}>{ticket.org.name}</Field>
                  {isDetail(ticket) && ticket.requester ? (
                    <Field label={t('details.requester')}>
                      <span>{ticket.requester.name}</span>
                      {ticket.requester.email ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {ticket.requester.email}
                        </span>
                      ) : null}
                    </Field>
                  ) : null}
                  <Field label={t('details.channel')}>{t(`channel.${ticket.channel}`)}</Field>
                  <Field label={t('details.firstResponseDue')}>
                    {ticket.firstRespondedAt
                      ? t('details.done')
                      : ticket.firstResponseDueAt
                        ? formatDateTime(ticket.firstResponseDueAt, locale)
                        : t('details.none')}
                  </Field>
                  <Field label={t('details.resolutionDue')}>
                    {ticket.slaPausedAt
                      ? t('details.slaPaused')
                      : ticket.resolutionDueAt
                        ? formatDateTime(ticket.resolutionDueAt, locale)
                        : t('details.none')}
                  </Field>
                </>
              ) : null}

              <Field label={t('details.created')}>{formatDateTime(ticket.createdAt, locale)}</Field>
            </dl>

            {staff ? (
              <div className="mt-3">
                <p id={`${ids}-tags`} className="text-xs font-medium text-muted-foreground">
                  {t('details.tags')}
                </p>
                <ul
                  aria-labelledby={`${ids}-tags`}
                  className="mt-1 flex flex-wrap items-center gap-1.5"
                >
                  {ticket.tags.length === 0 ? (
                    <li className="text-sm text-muted-foreground">{t('details.noTags')}</li>
                  ) : null}
                  {ticket.tags.map((tag) => (
                    <li
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2 py-0.5 text-xs"
                    >
                      {tag}
                      {canEdit ? (
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={t('details.removeTag', { tag })}
                          onClick={() => {
                            setTags(ticket.tags.filter((entry) => entry !== tag));
                          }}
                          className="rounded-sm hover:bg-surface-muted"
                        >
                          <X aria-hidden className="size-3.5" />
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {canEdit ? (
                  <form onSubmit={addTag} className="mt-2 flex items-center gap-2">
                    <Input
                      value={tagDraft}
                      onChange={(event) => {
                        setTagDraft(event.target.value);
                      }}
                      maxLength={64}
                      aria-label={t('details.addTag')}
                      placeholder={t('details.addTag')}
                      className="min-w-0 flex-1"
                    />
                    <Button type="submit" disabled={busy || tagDraft.trim() === ''}>
                      <Plus aria-hidden className="size-4" />
                      {t('details.addTagButton')}
                    </Button>
                  </form>
                ) : null}
              </div>
            ) : null}

            {staff && ticket.mergedIntoKey ? (
              <p className="mt-3 text-sm text-muted-foreground">
                {t('details.mergedInto', { key: ticket.mergedIntoKey })}
              </p>
            ) : null}

            <div role="status" className="mt-2 text-sm text-muted-foreground">
              {busy ? t('details.saving') : saved && !failure ? t('details.saved') : null}
            </div>
            {failure ? (
              <Alert tone="error" title={t('details.errors.title')} className="mt-2">
                {t(saveErrorKey(failure.error))}
              </Alert>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
