'use client';

import { AskAiElement } from '@/components/assistant/ask-ai-element';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type CurrentHandoff,
  HANDOFF_ITEM_KINDS,
  type Handoff,
  type HandoffBlocker,
  type HandoffIncomplete,
  type HandoffItemKind,
  isHandoffRequiredPriority,
} from '@watchtower/shared';
import { Button, EmptyState, Input, Select, Textarea, toast } from '@watchtower/ui';
import { CalendarCheck, CircleX, ClipboardList, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import {
  AttachmentDropZone,
  AttachmentGallery,
  AttachmentPicker,
  useAttachmentUpload,
} from '@/components/attachments';

import { LoadError, RequirePermission } from '@/components/admin/admin-page';
import { AppLink } from '@/components/app-link';
import { FormField } from '@/components/portal/form-field';
import {
  PriorityBadge,
  ShiftSection,
  ShiftSkeleton,
  TicketLink,
  useShiftFormat,
} from '@/components/shift/shift-bits';
import { useI18n } from '@/i18n/provider';
import { isApiError } from '@/lib/api/errors';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import {
  BLOCKER_CAUSE_KEYS,
  BLOCKER_REASON_KEYS,
  draftFromHandoff,
  draftIssues,
  draftItemForBlocker,
  type DraftItem,
  gateFromError,
  gateSentence,
  type HandoffDraft,
  missingFromDraft,
  nextActionFieldId,
  sameDraft,
  describeShiftError,
  toSaveBody,
} from '@/lib/shifts/model';
import { shiftKeys, useCurrentHandoff, useShiftStatus } from '@/lib/shifts/queries';

export function HandoffPage() {
  return (
    <RequirePermission permission="handoff.write" role="lead">
      <HandoffBody />
    </RequirePermission>
  );
}

function HandoffBody() {
  const { t } = useI18n();
  const status = useShiftStatus();
  const current = useCurrentHandoff();
  if (status.isPending || current.isPending) {
    // A 409 from `current` means no open session: the status tells the same, so wait for it.
    if (!(current.isError && isApiError(current.error) && current.error.status === 409)) {
      return <ShiftSkeleton rows={6} />;
    }
  }
  const open = status.data?.session != null && status.data.session.clockedOutAt === null;
  if (status.isSuccess && !open) {
    return (
      <EmptyState
        icon={<CalendarCheck />}
        title={t('shift.handoff.needClockIn')}
        action={
          <Button asChild variant="primary">
            <AppLink href="/shift">{t('shift.clockIn.button')}</AppLink>
          </Button>
        }
      />
    );
  }
  if (current.isError || status.isError) {
    return (
      <LoadError
        message={t('shift.common.loadError')}
        onRetry={() => {
          void current.refetch();
          void status.refetch();
        }}
      />
    );
  }
  return <HandoffView current={current.data} />;
}

function HandoffView({ current }: { current: CurrentHandoff }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const prefill = useMutation({
    mutationFn: () => api.prefillHandoff(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: shiftKeys(userId).all });
    },
  });
  if (current.handoff === null) {
    return (
      <EmptyState
        icon={<ClipboardList />}
        title={t('shift.handoff.start')}
        description={t('shift.handoff.startBody')}
        action={
          <div className="flex flex-col items-center gap-2">
            <Button
              variant="primary"
              disabled={prefill.isPending}
              onClick={() => {
                prefill.mutate();
              }}
            >
              {prefill.isPending ? t('shift.handoff.starting') : t('shift.handoff.start')}
            </Button>
            {prefill.isError ? (
              <p role="alert" className="text-sm font-medium text-danger">
                {describeShiftError(prefill.error, t).message}
              </p>
            ) : null}
          </div>
        }
      />
    );
  }
  const { handoff } = current;
  return (
    <HandoffEditor
      key={`${handoff.id}:${handoff.updatedAt}:${handoff.status}`}
      handoff={handoff}
      current={current}
    />
  );
}

const MANUAL_KINDS = HANDOFF_ITEM_KINDS.filter(
  (kind): kind is Exclude<HandoffItemKind, 'pending' | 'note'> =>
    kind !== 'pending' && kind !== 'note',
);

let localCounter = 0;

function HandoffEditor({ handoff, current }: { handoff: Handoff; current: CurrentHandoff }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const status = useShiftStatus();
  const format = useShiftFormat(status.data?.timezone);
  const base = useId();
  const summaryRef = useRef<HTMLDivElement>(null);
  const upload = useAttachmentUpload({ initial: handoff.attachments });
  const [baselineIds] = useState(() => handoff.attachments.map((file) => file.id).join(','));
  const [baseline] = useState<HandoffDraft>(() => draftFromHandoff(handoff));
  const [draft, setDraft] = useState<HandoffDraft>(baseline);
  const [attempted, setAttempted] = useState(false);
  const [serverGate, setServerGate] = useState<HandoffIncomplete | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const focusAfterRender = useRef<string | null>(null);
  const confirmed = handoff.status === 'confirmed';
  const dirty = !sameDraft(draft, baseline) || upload.attachmentIds.join(',') !== baselineIds;

  // The links from the clock-out gate end in `#handoff-next-<ticket>`: put the cursor in that field.
  useEffect(() => {
    const id = window.location.hash.replace(/^#/, '');
    if (id) document.getElementById(id)?.focus();
  }, []);
  useEffect(() => {
    const id = focusAfterRender.current;
    if (id === null) return;
    focusAfterRender.current = null;
    document.getElementById(id)?.focus();
  }, [draft]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: shiftKeys(userId).all });

  const save = useMutation({
    mutationFn: () =>
      api.saveHandoff(handoff.id, { ...toSaveBody(draft), attachmentIds: upload.attachmentIds }),
    onSuccess: async () => {
      setFailure(null);
      await refresh();
      toast(t('shift.handoff.saveDone'));
    },
    onError: (error) => {
      setFailure(describeShiftError(error, t).message);
    },
  });

  const confirm = useMutation({
    mutationFn: async () => {
      await api.saveHandoff(handoff.id, {
        ...toSaveBody(draft),
        attachmentIds: upload.attachmentIds,
      });
      return api.confirmHandoff(handoff.id);
    },
    onSuccess: async () => {
      setFailure(null);
      setServerGate(null);
      setAttempted(false);
      await refresh();
      toast(t('shift.handoff.confirmDone'));
    },
    onError: (error) => {
      const gate = gateFromError(error);
      if (gate) {
        setServerGate(gate);
        setFailure(null);
        setAttempted(true);
        void refresh();
        return;
      }
      setFailure(describeShiftError(error, t).message);
    },
  });

  const reopen = useMutation({
    mutationFn: () => api.reopenHandoff(handoff.id),
    onSuccess: async () => {
      setFailure(null);
      await refresh();
      toast(t('shift.handoff.reopened'));
    },
    onError: (error) => {
      setFailure(describeShiftError(error, t).message);
    },
  });

  const issues = draftIssues(draft);
  const blockers: HandoffBlocker[] = [...(serverGate?.blockers ?? current.gate.blockers)];
  const missing = missingFromDraft(draft, blockers);
  const problemCount = issues.length + missing.length;

  const setItem = (key: string, patch: Partial<DraftItem>) => {
    setDraft((value) => ({
      ...value,
      items: value.items.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    }));
  };
  const removeItem = (key: string) => {
    setDraft((value) => ({ ...value, items: value.items.filter((item) => item.key !== key) }));
  };

  const pending = draft.items.filter((item) => item.kind === 'pending');
  const others = draft.items.filter((item) => item.kind !== 'pending');
  const busy = save.isPending || confirm.isPending || reopen.isPending || upload.busy;

  function onConfirm() {
    setAttempted(true);
    if (problemCount > 0) {
      summaryRef.current?.focus();
      return;
    }
    confirm.mutate();
  }

  const toLabel = handoff.to?.name ?? t('shift.handoff.toNext');
  const range =
    handoff.scheduledStart && handoff.scheduledEnd
      ? `${format.time(handoff.scheduledStart)}–${format.time(handoff.scheduledEnd)}`
      : '';

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">
            {handoff.shiftName
              ? t('shift.handoff.heading', { shift: handoff.shiftName })
              : t('shift.handoff.headingNoShift')}
          </h2>
          <AskAiElement element="shift.handoff" />
          <p className="text-sm text-muted-foreground">
            {t('shift.handoff.shiftLine', { range, from: handoff.from.name, to: toLabel })}
          </p>
        </div>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {dirty
            ? t('shift.handoff.unsaved')
            : t('shift.handoff.saved', { time: format.time(handoff.updatedAt) })}
        </p>
      </div>

      {confirmed ? (
        <div className="flex flex-wrap items-center gap-3 rounded-card bg-surface shadow-card p-3 text-sm">
          <span>
            {t('shift.handoff.confirmedLine', {
              time: handoff.confirmedAt ? format.dateTime(handoff.confirmedAt) : '',
            })}
          </span>
          <Button
            disabled={busy}
            onClick={() => {
              reopen.mutate();
            }}
          >
            {t('shift.handoff.reopen')}
          </Button>
        </div>
      ) : null}

      <div
        ref={summaryRef}
        tabIndex={-1}
        role={attempted && problemCount > 0 ? 'alert' : undefined}
        className="outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring"
      >
        {attempted && problemCount > 0 ? (
          <div className="flex flex-col gap-2 rounded-card border border-danger/50 bg-surface shadow-card p-3">
            <p className="flex items-center gap-1 text-sm font-semibold text-danger">
              <CircleX aria-hidden className="size-4" />
              {t('shift.handoff.errorsHeading')} —{' '}
              {t('shift.handoff.errorsLead', { count: problemCount })}
            </p>
            <ul className="flex flex-col gap-1 text-sm">
              {issues.map((issue) => (
                <li key={issue.ticketId}>
                  <a
                    href={`#${issue.fieldId}`}
                    className="font-medium underline underline-offset-2"
                    onClick={(event) => {
                      event.preventDefault();
                      document.getElementById(issue.fieldId)?.focus();
                    }}
                  >
                    {t('shift.gate.fix', { key: issue.ticketKey })}
                  </a>{' '}
                  — {t('shift.gate.missingNextAction')}
                </li>
              ))}
              {missing.map((blocker) => (
                <li key={blocker.ticketId} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{blocker.key}</span>
                  <PriorityBadge priority={blocker.priority} />
                  <span>{t(BLOCKER_REASON_KEYS[blocker.reason])}</span>
                  {blocker.cause ? (
                    <span className="text-muted-foreground">
                      — {t(BLOCKER_CAUSE_KEYS[blocker.cause])}
                    </span>
                  ) : null}
                  <Button
                    size="sm"
                    onClick={() => {
                      const item = draftItemForBlocker(blocker);
                      setDraft((value) => ({ ...value, items: [...value.items, item] }));
                      focusAfterRender.current = nextActionFieldId(blocker.ticketId);
                    }}
                  >
                    <Plus aria-hidden className="size-4" />
                    {t('shift.gate.add')}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {failure ? (
        <p role="alert" className="flex items-start gap-1 text-sm font-medium text-danger">
          <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{failure}</span>
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {gateSentence(current.gate, t) ?? t('shift.handoff.gateOpen')}
      </p>

      <ShiftSection
        id="handoff-to"
        title={t('shift.handoff.to')}
        tone="indigo"
        icon={CalendarCheck}
      >
        <FormField id={`${base}-to`} label={t('shift.handoff.toLabel')} className="max-w-sm">
          <Select
            id={`${base}-to`}
            value={draft.toUserId ?? ''}
            disabled={confirmed}
            className="w-full"
            onChange={(event) => {
              const value = event.target.value;
              setDraft((previous) => ({ ...previous, toUserId: value === '' ? null : value }));
            }}
          >
            <option value="">{t('shift.handoff.toNext')}</option>
            {current.incomingCandidates.map((person) => (
              <option key={person.userId} value={person.userId}>
                {t('shift.handoff.candidate', { name: person.name, shift: person.shiftName })}
              </option>
            ))}
            {handoff.to && !current.incomingCandidates.some((p) => p.userId === handoff.to?.id) ? (
              <option value={handoff.to.id}>{handoff.to.name}</option>
            ) : null}
          </Select>
        </FormField>
      </ShiftSection>

      <ShiftSection
        id="handoff-pending"
        title={t('shift.handoff.pendingHeading')}
        count={pending.length}
        tone="amber"
        icon={ClipboardList}
      >
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('shift.handoff.pendingEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-sm">
              <caption className="sr-only">{t('shift.handoff.pendingCaption')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t('shift.handoff.colTicket')}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t('shift.handoff.colNext')}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t('shift.handoff.colDue')}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t('shift.handoff.colCarried')}
                  </th>
                  <th scope="col" className="py-1.5 font-medium">
                    <span className="sr-only">{t('shift.handoff.colActions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pending.map((item) => {
                  const required =
                    item.priority !== undefined && isHandoffRequiredPriority(item.priority);
                  const fieldId = item.ticketId
                    ? nextActionFieldId(item.ticketId)
                    : `${base}-${item.key}-next`;
                  const bad = attempted && required && item.nextAction.trim() === '';
                  const key = item.ticketKey ?? item.title;
                  return (
                    <tr key={item.key} className="border-b border-border/60 align-top">
                      <td className="py-2 pr-3">
                        <div className="flex flex-col gap-0.5">
                          <span className="flex items-center gap-2">
                            {item.ticketKey ? <TicketLink ticketKey={item.ticketKey} /> : null}
                            {item.priority ? (
                              <PriorityBadge
                                priority={item.priority as 'P1' | 'P2' | 'P3' | 'P4'}
                              />
                            ) : null}
                          </span>
                          <span className="text-muted-foreground">{item.title}</span>
                          {item.source === 'prefill' ? (
                            <span className="text-xs text-muted-foreground">
                              {t('shift.handoff.prefilled')}
                              {item.edited ? ` · ${t('shift.handoff.edited')}` : ''}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        <Input
                          id={fieldId}
                          aria-label={t('shift.handoff.nextFor', { key })}
                          aria-required={required ? true : undefined}
                          aria-invalid={bad ? true : undefined}
                          aria-describedby={bad ? `${fieldId}-error` : undefined}
                          value={item.nextAction}
                          maxLength={500}
                          disabled={confirmed}
                          className="w-full"
                          onChange={(event) => {
                            setItem(item.key, { nextAction: event.target.value });
                          }}
                        />
                        {bad ? (
                          <p
                            id={`${fieldId}-error`}
                            className="mt-1 flex items-center gap-1 text-xs font-medium text-danger"
                          >
                            <CircleX aria-hidden className="size-3.5" />
                            {t('shift.gate.missingNextAction')}
                          </p>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">
                        <Input
                          type="datetime-local"
                          aria-label={t('shift.handoff.dueFor', { key })}
                          value={item.due}
                          disabled={confirmed}
                          onChange={(event) => {
                            setItem(item.key, { due: event.target.value });
                          }}
                        />
                      </td>
                      <td className="py-2 pr-3 tabular">
                        {item.carriedShifts === 0
                          ? t('shift.handoff.new')
                          : item.carriedShifts === 1
                            ? t('shift.handoff.carriedShift')
                            : t('shift.handoff.carriedShifts', { count: item.carriedShifts })}
                      </td>
                      <td className="py-2">
                        {required || confirmed ? (
                          required ? (
                            <span className="text-xs text-muted-foreground">
                              {t('shift.handoff.required')}
                            </span>
                          ) : null
                        ) : (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={t('shift.handoff.remove', { title: key })}
                            onClick={() => {
                              removeItem(item.key);
                            }}
                          >
                            <Trash2 aria-hidden className="size-4" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </ShiftSection>

      <ShiftSection
        id="handoff-other"
        title={t('shift.handoff.otherHeading')}
        count={others.length}
        tone="red"
        icon={ClipboardList}
      >
        <p className="text-xs text-muted-foreground">{t('shift.handoff.otherHint')}</p>
        {others.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('shift.handoff.otherEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {others.map((item) => (
              <li
                key={item.key}
                className="flex flex-wrap items-center gap-2 rounded-inner bg-surface px-3.5 py-2.5 shadow-card"
              >
                <span className="text-xs font-medium text-muted-foreground">
                  {t(`shift.handoff.kind.${item.kind}`)}
                </span>
                <Input
                  aria-label={t('shift.handoff.addTitle')}
                  value={item.title}
                  maxLength={300}
                  disabled={confirmed}
                  className="min-w-40 flex-1"
                  onChange={(event) => {
                    setItem(item.key, { title: event.target.value });
                  }}
                />
                <Input
                  aria-label={t('shift.handoff.addNext')}
                  value={item.nextAction}
                  maxLength={500}
                  disabled={confirmed}
                  className="min-w-40 flex-1"
                  onChange={(event) => {
                    setItem(item.key, { nextAction: event.target.value });
                  }}
                />
                {confirmed ? null : (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('shift.handoff.remove', { title: item.title })}
                    onClick={() => {
                      removeItem(item.key);
                    }}
                  >
                    <Trash2 aria-hidden className="size-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {confirmed ? null : (
          <AddOtherItem
            onAdd={(item) => {
              setDraft((value) => ({ ...value, items: [...value.items, item] }));
            }}
          />
        )}
      </ShiftSection>

      <ShiftSection
        id="handoff-notes"
        title={t('shift.handoff.notesHeading')}
        tone="slate"
        icon={ClipboardList}
      >
        <FormField id={`${base}-notes`} label={t('shift.handoff.notesLabel')}>
          <AttachmentDropZone upload={upload} disabled={confirmed}>
            <Textarea
              id={`${base}-notes`}
              value={draft.notes}
              maxLength={5000}
              disabled={confirmed}
              className="w-full"
              onChange={(event) => {
                setDraft((value) => ({ ...value, notes: event.target.value }));
              }}
            />
          </AttachmentDropZone>
        </FormField>
        <FormField
          id={`${base}-message`}
          label={t('shift.handoff.messageLabel')}
          hint={t('shift.handoff.messageHint')}
        >
          <Textarea
            id={`${base}-message`}
            aria-describedby={`${base}-message-hint`}
            value={draft.messageForNext}
            maxLength={2000}
            disabled={confirmed}
            className="w-full"
            onChange={(event) => {
              setDraft((value) => ({ ...value, messageForNext: event.target.value }));
            }}
          />
        </FormField>
        {confirmed ? (
          <AttachmentGallery attachments={handoff.attachments} />
        ) : (
          <AttachmentPicker upload={upload} disabled={save.isPending || confirm.isPending} />
        )}
      </ShiftSection>

      {confirmed ? null : (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
          <Button
            disabled={busy || !dirty}
            onClick={() => {
              save.mutate();
            }}
          >
            {save.isPending ? t('shift.common.saving') : t('shift.handoff.save')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={onConfirm}>
            {confirm.isPending ? t('shift.handoff.confirming') : t('shift.handoff.confirm')}
          </Button>
        </div>
      )}
    </>
  );
}

function AddOtherItem({ onAdd }: { onAdd: (item: DraftItem) => void }) {
  const { t } = useI18n();
  const base = useId();
  const [kind, setKind] = useState<(typeof MANUAL_KINDS)[number]>('incident');
  const [title, setTitle] = useState('');
  const [next, setNext] = useState('');
  const [missing, setMissing] = useState(false);
  return (
    <form
      noValidate
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() === '') {
          setMissing(true);
          return;
        }
        localCounter += 1;
        onAdd({
          key: `local-${String(localCounter)}`,
          kind,
          title: title.trim(),
          nextAction: next.trim(),
          due: '',
          severity: '',
          source: 'manual',
          edited: false,
          carriedShifts: 0,
        });
        setTitle('');
        setNext('');
        setMissing(false);
      }}
    >
      <FormField id={`${base}-kind`} label={t('shift.handoff.addKind')}>
        <Select
          id={`${base}-kind`}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as (typeof MANUAL_KINDS)[number]);
          }}
        >
          {MANUAL_KINDS.map((value) => (
            <option key={value} value={value}>
              {t(`shift.handoff.kind.${value}`)}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField
        id={`${base}-title`}
        label={t('shift.handoff.addTitle')}
        className="min-w-48 flex-1"
        {...(missing ? { error: t('shift.common.required') } : {})}
      >
        <Input
          id={`${base}-title`}
          value={title}
          maxLength={300}
          aria-invalid={missing ? true : undefined}
          aria-describedby={missing ? `${base}-title-error` : undefined}
          onChange={(event) => {
            setTitle(event.target.value);
            setMissing(false);
          }}
        />
      </FormField>
      <FormField id={`${base}-next`} label={t('shift.handoff.addNext')} className="min-w-48 flex-1">
        <Input
          id={`${base}-next`}
          value={next}
          maxLength={500}
          onChange={(event) => {
            setNext(event.target.value);
          }}
        />
      </FormField>
      <Button type="submit">
        <Plus aria-hidden className="size-4" />
        {t('shift.handoff.addButton')}
      </Button>
    </form>
  );
}
