'use client';

import type { TicketStatus } from '@watchtower/shared';
import { Alert, Button, Kbd, Select, Textarea, cn } from '@watchtower/ui';
import { Lock, Send } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

import { QUEUE_LISTBOX_ID } from '@/components/queue/queue-row';
import { useI18n } from '@/i18n/provider';
import type { MessageKey } from '@/i18n';
import { isApiError } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';
import { useShortcut } from '@/lib/keyboard';
import { isClosedForReplies, isDetail, type TicketItem } from '@/lib/tickets/model';
import { useIntents, useTicketMutations, useWorkflow } from '@/lib/tickets/queries';
import { statusKey } from '@/lib/tickets/status-key';
import {
  allowedNextStatuses,
  draftStore,
  findPlaceholders,
  renderTemplate,
  type TemplateValues,
} from '@/lib/tickets/templates';

type Mode = 'reply' | 'note';

function errorKey(error: unknown): MessageKey {
  if (!isApiError(error)) return 'composer.errors.generic';
  switch (error.code) {
    case 'invalid_transition':
      return 'composer.errors.invalidTransition';
    case 'ticket_not_open':
      return 'composer.errors.ticketNotOpen';
    case 'forbidden':
      return 'composer.errors.forbidden';
    case 'network':
      return 'composer.errors.network';
    default:
      return 'composer.errors.generic';
  }
}

/**
 * Reply and internal-note composer. The two modes are told apart by words, an icon and the border
 * (solid for something the customer will read, dashed for the team only), so a note cannot be
 * mistaken for a reply. Staff can pick a reply template and send "reply and set status".
 */
export function Composer({ ticket }: { ticket: TicketItem }) {
  const { t } = useI18n();
  const { can, session } = useSession();
  const ids = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canReply = can('ticket.reply') || can('ticket.reply.own');
  const canNote = can('ticket.handle');
  const isStaff = can('ticket.reply');

  const [mode, setMode] = useState<Mode>(canReply ? 'reply' : 'note');
  const [bodies, setBodies] = useState<Record<Mode, string>>(() => ({
    reply: draftStore.get(ticket.key, 'reply'),
    note: draftStore.get(ticket.key, 'note'),
  }));
  const [nextStatus, setNextStatus] = useState<TicketStatus | ''>('');
  const [sent, setSent] = useState<Mode | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  const intents = useIntents(isStaff);
  const workflow = useWorkflow(isStaff);
  const { reply, note } = useTicketMutations(ticket.key);
  const mutation = mode === 'reply' ? reply : note;

  useEffect(() => {
    if (focusTick > 0) textareaRef.current?.focus();
  }, [focusTick]);

  const focusComposer = (target: Mode) => {
    setMode(target);
    setFocusTick((tick) => tick + 1);
  };
  useShortcut(
    'c',
    () => {
      focusComposer('reply');
    },
    canReply,
  );
  useShortcut(
    'n',
    () => {
      focusComposer('note');
    },
    canNote,
  );

  if (!canReply && !canNote) return null;

  if (isClosedForReplies(ticket.status)) {
    return (
      <div className="border-t border-border p-pane">
        <Alert tone="info" title={t('composer.closed.title')}>
          {t('composer.closed.body')}
        </Alert>
      </div>
    );
  }

  const body = bodies[mode];
  const staffTicket = isDetail(ticket) ? ticket : null;
  const values: TemplateValues = {
    'ticket.key': ticket.key,
    'ticket.subject': ticket.subject,
    ...(staffTicket?.requester ? { 'requester.name': staffTicket.requester.name } : {}),
    ...(staffTicket ? { 'org.name': staffTicket.org.name } : {}),
    ...(session ? { 'agent.name': session.user.name } : {}),
  };
  const intentRecord = intents.data?.intents.find((entry) => entry.id === ticket.intent?.id);
  const templates =
    intentRecord && 'replyTemplates' in intentRecord ? intentRecord.replyTemplates : [];
  const unresolved = findPlaceholders(body);
  const nextOptions = allowedNextStatuses(workflow.data, ticket.status);
  const showTemplates = mode === 'reply' && isStaff;
  const showStatus = mode === 'reply' && isStaff;

  const setBody = (text: string) => {
    setBodies((current) => ({ ...current, [mode]: text }));
    draftStore.set(ticket.key, mode, text);
    setSent(null);
  };

  const insertTemplate = (key: string) => {
    const template = templates.find((entry) => entry.key === key);
    if (!template) return;
    const { text } = renderTemplate(template.body, values);
    const area = textareaRef.current;
    if (!area || body === '') {
      setBody(text);
    } else {
      const start = area.selectionStart;
      const end = area.selectionEnd;
      setBody(`${body.slice(0, start)}${text}${body.slice(end)}`);
    }
    setFocusTick((tick) => tick + 1);
  };

  const canSend = body.trim() !== '' && unresolved.length === 0 && !mutation.isPending;

  const submit = () => {
    if (!canSend) return;
    const text = body.trim();
    const done = () => {
      setBody('');
      setNextStatus('');
      setSent(mode);
    };
    if (mode === 'reply') {
      reply.mutate(
        { body: text, ...(nextStatus ? { setStatus: nextStatus } : {}) },
        { onSuccess: done },
      );
    } else {
      note.mutate({ body: text }, { onSuccess: done });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      // Hand the keyboard back to the queue so J/K work again.
      event.currentTarget.blur();
      document.getElementById(QUEUE_LISTBOX_ID)?.focus();
    }
  };

  const modeLabel = mode === 'reply' ? t('composer.modes.reply') : t('composer.modes.note');
  const hintKey: MessageKey =
    mode === 'reply'
      ? isStaff
        ? 'composer.hints.replyStaff'
        : 'composer.hints.replyClient'
      : 'composer.hints.note';
  const channelName = 'channel' in ticket ? t(`channel.${ticket.channel}`) : null;
  const ModeIcon = mode === 'reply' ? Send : Lock;
  const textareaId = `${ids}-body`;
  const hintId = `${ids}-hint`;

  return (
    <form
      aria-label={t('composer.label')}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className={cn(
        'flex flex-col gap-2 border-t p-pane',
        mode === 'note' ? 'border-dashed border-border-strong bg-surface-muted' : 'border-border',
      )}
    >
      {canReply && canNote ? (
        <div role="group" aria-label={t('composer.modeGroup')} className="flex gap-2">
          {(['reply', 'note'] as const).map((value) => (
            <Button
              key={value}
              variant={mode === value ? 'primary' : 'secondary'}
              aria-pressed={mode === value}
              onClick={() => {
                setMode(value);
                setSent(null);
              }}
            >
              {value === 'reply' ? (
                <Send aria-hidden className="size-4" />
              ) : (
                <Lock aria-hidden className="size-4" />
              )}
              {t(`composer.modes.${value}`)}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label htmlFor={textareaId} className="flex items-center gap-1.5 text-sm font-semibold">
          <ModeIcon aria-hidden className="size-4" />
          {modeLabel}
        </label>
        {showTemplates ? (
          <>
            <label htmlFor={`${ids}-template`} className="sr-only">
              {t('composer.template.label')}
            </label>
            <Select
              id={`${ids}-template`}
              value=""
              disabled={templates.length === 0}
              onChange={(event) => {
                insertTemplate(event.target.value);
              }}
              className="max-w-56"
            >
              <option value="">
                {templates.length === 0
                  ? t('composer.template.none')
                  : t('composer.template.choose')}
              </option>
              {templates.map((template) => (
                <option key={template.key} value={template.key}>
                  {template.name}
                </option>
              ))}
            </Select>
          </>
        ) : null}
      </div>

      <Textarea
        ref={textareaRef}
        id={textareaId}
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
        }}
        onKeyDown={onKeyDown}
        rows={5}
        aria-describedby={hintId}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        className={cn('w-full', mode === 'note' && 'border-dashed')}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        {t(hintKey, { channel: channelName ?? '' })}
      </p>

      {unresolved.length > 0 ? (
        <Alert tone="error" title={t('composer.unresolved.title')}>
          {t('composer.unresolved.body', { names: unresolved.join(', ') })}
        </Alert>
      ) : null}

      {mutation.isError ? (
        <Alert tone="error" title={t('composer.errors.title')}>
          {t(errorKey(mutation.error))}
        </Alert>
      ) : null}

      <div role="status" className="text-sm text-muted-foreground">
        {sent ? (sent === 'reply' ? t('composer.sent.reply') : t('composer.sent.note')) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {showStatus ? (
          <label className="inline-flex items-center gap-1.5 text-sm">
            {t('composer.setStatus.label')}
            <Select
              value={nextStatus}
              onChange={(event) => {
                const match = nextOptions.find((status) => status === event.target.value);
                setNextStatus(match ?? '');
              }}
            >
              <option value="">{t('composer.setStatus.keep')}</option>
              {nextOptions.map((status) => (
                <option key={status} value={status}>
                  {t(statusKey(status))}
                </option>
              ))}
            </Select>
          </label>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd>
          </span>
          <Button type="submit" variant="primary" disabled={!canSend}>
            {mutation.isPending
              ? t('composer.sending')
              : mode === 'note'
                ? t('composer.submit.note')
                : nextStatus
                  ? t('composer.submit.replyAndSet', { status: t(statusKey(nextStatus)) })
                  : t('composer.submit.reply')}
          </Button>
        </div>
      </div>
    </form>
  );
}
