'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type AckHandoffItem, type HandoffItem, type IncomingHandoffs } from '@watchtower/shared';
import { Button, cn, Dialog, DialogContent, Select, Textarea, toast } from '@watchtower/ui';
import { CircleX, Repeat, TriangleAlert } from 'lucide-react';
import { type KeyboardEvent, useId, useRef, useState } from 'react';

import { PriorityBadge, TicketLink, useShiftFormat } from '@/components/shift/shift-bits';
import { FormField } from '@/components/portal/form-field';
import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { isShortcut } from '@/lib/keyboard';
import {
  ackProgress,
  canTakeItem,
  carriedLevel,
  describeShiftError,
  mustGoToOnShift,
} from '@/lib/shifts/model';
import { shiftKeys, useAssignees } from '@/lib/shifts/queries';

/**
 * The handoff addressed to the caller (docs/06-UI-SPEC.md section 9.4, R-7.6): progress, the
 * time the lead is alerted, and every item with Accept / Reassign / Ask a question. On a focused
 * item J and K move, 1 / 2 / 3 answer. A P1 or P2 ticket cannot go to someone who is off shift.
 */
export function AckList({ data, timezone }: { data: IncomingHandoffs; timezone: string }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const format = useShiftFormat(timezone);
  const listRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reassigning, setReassigning] = useState<HandoffItem | null>(null);
  const [asking, setAsking] = useState<{ item: HandoffItem; from: string } | null>(null);

  const progress = ackProgress(data.total, data.acknowledged);

  const ack = useMutation({
    mutationFn: ({ item, body }: { item: HandoffItem; body: AckHandoffItem }) =>
      api.ackHandoffItem(item.id, body),
    onMutate: ({ item }) => {
      setBusyId(item.id);
      setError(null);
    },
    onSuccess: async (result, { item, body }) => {
      if (body.decision === 'accept') toast(t('shift.ack.acceptDone', { title: item.title }));
      else if (body.decision === 'reassign')
        toast(t('shift.ack.reassignDone', { title: item.title }));
      if (result.warnings.includes('assignee_off_shift')) toast(t('shift.ack.offShiftWarning'));
      setReassigning(null);
      setAsking(null);
      await queryClient.invalidateQueries({ queryKey: shiftKeys(userId).all });
    },
    onError: (failure) => {
      setError(describeShiftError(failure, t).message);
    },
    onSettled: () => {
      setBusyId(null);
    },
  });

  const items = (): HTMLElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-ack-item]') ?? []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-ack-item]');
    if (!item) return;
    const native = event.nativeEvent;
    const move = (step: number) => {
      const all = items();
      const next = all[all.indexOf(item) + step];
      if (next) {
        event.preventDefault();
        next.focus();
      }
    };
    if (isShortcut(native, 'j')) {
      move(1);
      return;
    }
    if (isShortcut(native, 'k')) {
      move(-1);
      return;
    }
    const actions: Record<string, string> = { '1': 'accept', '2': 'reassign', '3': 'question' };
    for (const [key, action] of Object.entries(actions)) {
      if (!isShortcut(native, key)) continue;
      const button = item.querySelector<HTMLButtonElement>(`[data-ack-action="${action}"]`);
      if (button && !button.disabled) {
        event.preventDefault();
        button.click();
      }
      return;
    }
  }

  if (data.handoffs.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('shift.ack.empty')}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium" data-testid="ack-progress">
          {progress.total === 0
            ? t('shift.ack.empty')
            : progress.done
              ? t('shift.ack.progressDone', { total: progress.total })
              : t('shift.ack.progress', { done: progress.acknowledged, total: progress.total })}
        </p>
        {progress.total > 0 ? (
          <progress
            value={progress.acknowledged}
            max={progress.total}
            aria-label={t('shift.ack.progress', {
              done: progress.acknowledged,
              total: progress.total,
            })}
            className="h-1.5 w-full max-w-xs"
          />
        ) : null}
        {!progress.done && data.leadAlertAt ? (
          <p className="text-xs text-muted-foreground">
            {t('shift.ack.leadAlert', { time: format.time(data.leadAlertAt) })}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">{t('shift.ack.keys')}</p>
      </div>

      {error ? (
        <p role="alert" className="flex items-start gap-1 text-sm font-medium text-danger">
          <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      <div ref={listRef} onKeyDown={onKeyDown} className="flex flex-col gap-5">
        {data.handoffs.map((handoff) => (
          <section
            key={handoff.id}
            aria-label={
              handoff.shiftName
                ? t('shift.ack.from', { name: handoff.from.name, shift: handoff.shiftName })
                : t('shift.ack.fromNoShift', { name: handoff.from.name })
            }
            className="flex flex-col gap-2 rounded-card bg-surface shadow-card p-3"
          >
            <header className="flex flex-col gap-0.5">
              <p className="text-sm font-medium">
                {handoff.shiftName
                  ? t('shift.ack.from', { name: handoff.from.name, shift: handoff.shiftName })
                  : t('shift.ack.fromNoShift', { name: handoff.from.name })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('shift.ack.confirmedAt', { time: format.dateTime(handoff.confirmedAt) })}
              </p>
            </header>
            {handoff.messageForNext ? (
              <p className="rounded-md bg-surface-muted px-3 py-2 text-sm">
                <span className="font-medium">{t('shift.ack.message')}: </span>
                {handoff.messageForNext}
              </p>
            ) : null}
            {handoff.notes ? (
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{t('shift.ack.notes')}: </span>
                {handoff.notes}
              </p>
            ) : null}
            <ul aria-label={t('shift.ack.listLabel')} className="flex flex-col gap-2">
              {handoff.items.map((item, index) => (
                <AckItem
                  key={item.id}
                  item={item}
                  tabbable={
                    activeId === null
                      ? index === 0 && handoff === data.handoffs[0]
                      : activeId === item.id
                  }
                  busy={busyId === item.id}
                  onFocus={() => {
                    setActiveId(item.id);
                  }}
                  onAccept={() => {
                    ack.mutate({ item, body: { decision: 'accept' } });
                  }}
                  onReassign={() => {
                    setError(null);
                    setReassigning(item);
                  }}
                  onQuestion={() => {
                    setError(null);
                    setAsking({ item, from: handoff.from.name });
                  }}
                  format={format.dateTime}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      {reassigning ? (
        <ReassignDialog
          item={reassigning}
          pending={ack.isPending}
          error={error}
          onClose={() => {
            setReassigning(null);
          }}
          onSubmit={(assigneeId) => {
            ack.mutate({ item: reassigning, body: { decision: 'reassign', assigneeId } });
          }}
        />
      ) : null}
      {asking ? (
        <QuestionDialog
          item={asking.item}
          from={asking.from}
          pending={ack.isPending}
          error={error}
          onClose={() => {
            setAsking(null);
          }}
          onSubmit={(note) => {
            ack.mutate(
              { item: asking.item, body: { decision: 'question', note } },
              {
                onSuccess: () => {
                  toast(t('shift.ack.questionDone', { name: asking.from }));
                },
              },
            );
          }}
        />
      ) : null}
    </div>
  );
}

function AckItem({
  item,
  tabbable,
  busy,
  onFocus,
  onAccept,
  onReassign,
  onQuestion,
  format,
}: {
  item: HandoffItem;
  tabbable: boolean;
  busy: boolean;
  onFocus: () => void;
  onAccept: () => void;
  onReassign: () => void;
  onQuestion: () => void;
  format: (iso: string) => string;
}) {
  const { t } = useI18n();
  const level = carriedLevel(item.carriedShifts);
  const answered = item.ackStatus === 'accepted' || item.ackStatus === 'reassigned';
  const who = item.ackBy?.name ?? '';
  return (
    <li
      data-ack-item=""
      data-ack-status={item.ackStatus}
      tabIndex={tabbable ? 0 : -1}
      onFocus={onFocus}
      className="flex flex-col gap-1.5 rounded-inner bg-surface px-3.5 py-2.5 shadow-card focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t(`shift.handoff.kind.${item.kind}`)}
        </span>
        {item.ticket ? <TicketLink ticketKey={item.ticket.key} /> : null}
        {item.ticket ? <PriorityBadge priority={item.ticket.priority} /> : null}
        <span className="min-w-0 text-sm font-medium">{item.title}</span>
        {level !== 'none' ? (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 text-xs',
              level === 'warning'
                ? 'bg-surface-muted font-semibold text-foreground ring-1 ring-current/40 ring-inset'
                : 'text-muted-foreground',
            )}
          >
            {level === 'warning' ? (
              <TriangleAlert aria-hidden className="size-3.5" />
            ) : (
              <Repeat aria-hidden className="size-3.5" />
            )}
            {t(level === 'warning' ? 'shift.ack.carriedWarning' : 'shift.ack.carried', {
              count: item.carriedShifts,
            })}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-0.5 text-sm text-muted-foreground">
        {item.nextAction ? <p>{t('shift.brief.next', { action: item.nextAction })}</p> : null}
        {item.dueAt ? <p>{t('shift.brief.due', { at: format(item.dueAt) })}</p> : null}
        {item.ticket?.assignee ? (
          <p>{t('shift.brief.owner', { name: item.ticket.assignee.name })}</p>
        ) : null}
        {item.ackNote ? <p>{item.ackNote}</p> : null}
      </div>
      {!item.requiresAck ? (
        <p className="text-xs text-muted-foreground">{t('shift.ack.info')}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {answered ? (
            <p className="text-sm">
              {t(item.ackStatus === 'accepted' ? 'shift.ack.accepted' : 'shift.ack.reassigned', {
                name: who,
              })}
            </p>
          ) : (
            <>
              {item.ackStatus === 'question' ? (
                <p className="w-full text-xs text-muted-foreground">
                  {t('shift.ack.questioned', { name: who })}
                </p>
              ) : (
                <p className="sr-only">{t('shift.ack.pending')}</p>
              )}
              <Button size="sm" data-ack-action="accept" disabled={busy} onClick={onAccept}>
                {t('shift.ack.accept')}
              </Button>
              <Button size="sm" data-ack-action="reassign" disabled={busy} onClick={onReassign}>
                {t('shift.ack.reassign')}
              </Button>
              {item.ackStatus === 'question' ? null : (
                <Button size="sm" data-ack-action="question" disabled={busy} onClick={onQuestion}>
                  {t('shift.ack.question')}
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

function ReassignDialog({
  item,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  item: HandoffItem;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (assigneeId: string) => void;
}) {
  const { t } = useI18n();
  const base = useId();
  const assignees = useAssignees();
  const [assigneeId, setAssigneeId] = useState('');
  const [missing, setMissing] = useState(false);
  const people = assignees.data?.assignees ?? [];
  const chosen = people.find((person) => person.id === assigneeId);
  const strict = mustGoToOnShift(item);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent
        title={t('shift.ack.reassignTitle', { title: item.title })}
        description={t('shift.ack.reassignDescription')}
        closeLabel={t('shift.common.close')}
        footer={
          <>
            <Button onClick={onClose} disabled={pending}>
              {t('shift.common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => {
                if (assigneeId === '') {
                  setMissing(true);
                  return;
                }
                onSubmit(assigneeId);
              }}
            >
              {pending ? t('shift.common.saving') : t('shift.ack.reassign')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? (
            <p role="alert" className="flex items-start gap-1 text-sm font-medium text-danger">
              <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}
          <FormField
            id={`${base}-who`}
            label={t('shift.ack.assignee')}
            {...(missing ? { error: t('shift.common.required') } : {})}
            {...(strict ? { hint: t('shift.ack.offShiftRefused') } : {})}
          >
            <Select
              id={`${base}-who`}
              value={assigneeId}
              aria-invalid={missing ? true : undefined}
              aria-describedby={
                [strict ? `${base}-who-hint` : null, missing ? `${base}-who-error` : null]
                  .filter((id) => id !== null)
                  .join(' ') || undefined
              }
              className="w-full"
              onChange={(event) => {
                setAssigneeId(event.target.value);
                setMissing(false);
              }}
            >
              <option value="">{t('shift.ack.pickAssignee')}</option>
              {people.map((person) => (
                <option key={person.id} value={person.id} disabled={!canTakeItem(person, item)}>
                  {person.name} —{' '}
                  {person.onShift ? t('shift.ack.onShift') : t('shift.ack.offShift')},{' '}
                  {t('shift.ack.openTickets', { count: person.openTickets })}
                </option>
              ))}
            </Select>
          </FormField>
          {chosen && !chosen.onShift ? (
            <p className="text-xs text-muted-foreground">{t('shift.ack.offShiftNote')}</p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function QuestionDialog({
  item,
  from,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  item: HandoffItem;
  from: string;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (note: string) => void;
}) {
  const { t } = useI18n();
  const base = useId();
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent
        title={t('shift.ack.questionTitle', { name: from, title: item.title })}
        description={t('shift.ack.questionDescription')}
        closeLabel={t('shift.common.close')}
        footer={
          <>
            <Button onClick={onClose} disabled={pending}>
              {t('shift.common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => {
                if (note.trim() === '') {
                  setMissing(true);
                  return;
                }
                onSubmit(note.trim());
              }}
            >
              {pending ? t('shift.common.saving') : t('shift.ack.questionSend')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? (
            <p role="alert" className="flex items-start gap-1 text-sm font-medium text-danger">
              <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}
          <FormField
            id={`${base}-q`}
            label={t('shift.ack.questionLabel')}
            {...(missing ? { error: t('shift.common.required') } : {})}
          >
            <Textarea
              id={`${base}-q`}
              value={note}
              maxLength={1000}
              aria-invalid={missing ? true : undefined}
              aria-describedby={missing ? `${base}-q-error` : undefined}
              className="w-full"
              onChange={(event) => {
                setNote(event.target.value);
                setMissing(false);
              }}
            />
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}
