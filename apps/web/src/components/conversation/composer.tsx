'use client';

import { hasOutboundChannel, type TicketStatus } from '@watchtower/shared';
import {
  Alert,
  Button,
  Combobox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  IconButton,
  Kbd,
  SegmentedControl,
  Tooltip,
  cn,
} from '@watchtower/ui';
import {
  ChevronDown,
  CornerDownLeft,
  FileText,
  Flag,
  Lock,
  MessageCircle,
  Paperclip,
  Send,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { ChannelIcon } from '@/components/ticket/channel-icon';
import { QUEUE_LISTBOX_ID } from '@/components/queue/queue-row';
import { useI18n } from '@/i18n/provider';
import type { MessageKey } from '@/i18n';
import { isApiError } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';
import { useShortcut } from '@/lib/keyboard';
import { useLineQuota, useSendUndo } from '@/lib/outbound/queries';
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
import { useIsMac } from '@/lib/use-is-mac';

import { LineQuotaNote } from './line-quota-note';

export type ComposerMode = 'reply' | 'note';
type Mode = ComposerMode;

/** What the timeline can ask of the composer. */
export interface ComposerHandle {
  /** Puts a customer's words into the reply as a quote and moves the caret there. */
  quote: (text: string) => void;
  /** Moves the caret into the box, optionally switching to the reply or the note tab. */
  focus: (mode?: ComposerMode) => void;
}

const MIN_ROWS = 3;
const MAX_ROWS = 12;

const KNOWN_ERROR_CODES: readonly string[] = [
  'invalid_transition',
  'ticket_not_open',
  'forbidden',
  'network',
  'channel_no_outbound',
];

/**
 * What to tell the person when a send failed: our own (translated) words for the codes we know,
 * the api's own message for any other code it explained, and the generic line only when the api
 * said nothing useful.
 */
export function sendErrorText(error: unknown, t: (key: MessageKey) => string): string {
  if (
    isApiError(error) &&
    error.code !== 'unknown' &&
    error.code !== 'invalid_response' &&
    !KNOWN_ERROR_CODES.includes(error.code) &&
    error.message
  ) {
    return error.message;
  }
  return t(errorKey(error));
}

function errorKey(error: unknown): MessageKey {
  if (!isApiError(error)) return 'composer.errors.generic';
  switch (error.code) {
    case 'channel_no_outbound':
      return 'composer.errors.channelNoOutbound';
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

/** "> " in front of every line, then a blank line so the answer starts below the quote. */
function asQuote(text: string): string {
  return `${text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n')}\n\n`;
}

/**
 * Reply and internal-note composer: one rounded box with a Reply / Internal note switch, a textarea
 * that grows from 3 to 12 rows, a toolbar (template; attach and AI draft are placeholders until
 * Phase 1) and the send button. The Ctrl/Cmd+Enter hint lives in the footer line, not in the button. The two modes are told apart by
 * words, an icon, the surface and the border (solid for something the customer will read, dashed
 * on a muted surface for the team only), so a note cannot be mistaken for a reply.
 */
export function Composer({
  ticket,
  handleRef,
  initialMode,
  autoFocus = false,
  initialQuote,
}: {
  ticket: TicketItem;
  handleRef?: Ref<ComposerHandle>;
  /** Which tab opens first; reply unless the person cannot reply. */
  initialMode?: Mode;
  /** Put the caret in the box when it appears (the person asked for it with "Write myself" or C). */
  autoFocus?: boolean;
  /** A customer's words to quote as soon as the box appears. */
  initialQuote?: string;
}) {
  const { t } = useI18n();
  const { can, session } = useSession();
  const ids = useId();
  const isMac = useIsMac();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canReply = can('ticket.reply') || can('ticket.reply.own');
  const canNote = can('ticket.handle');
  const isStaff = can('ticket.reply');

  // A phone, walk-in, chat, other or internal ticket has nowhere to send a reply: the api would
  // answer 409 channel_no_outbound, so the reply side is switched off up front.
  const ticketChannel = 'channel' in ticket ? ticket.channel : null;
  const noOutbound = ticketChannel !== null && !hasOutboundChannel(ticketChannel);
  const replyAllowed = canReply && !noOutbound;

  const [mode, setMode] = useState<Mode>(
    initialMode === 'note' || !replyAllowed ? 'note' : 'reply',
  );
  const [bodies, setBodies] = useState<Record<Mode, string>>(() => ({
    reply: draftStore.get(ticket.key, 'reply'),
    note: draftStore.get(ticket.key, 'note'),
  }));
  const [nextStatus, setNextStatus] = useState<TicketStatus | ''>('');
  const [sent, setSent] = useState<Mode | null>(null);
  const [focusTick, setFocusTick] = useState(autoFocus ? 1 : 0);

  const intents = useIntents(isStaff);
  const workflow = useWorkflow(isStaff);
  const { reply, note } = useTicketMutations(ticket.key);
  const { offer } = useSendUndo(ticket.key);
  const viaLine = 'channel' in ticket && ticket.channel === 'line';
  const quota = useLineQuota(isStaff && mode === 'reply' && viaLine);
  const mutation = mode === 'reply' ? reply : note;

  useEffect(() => {
    if (focusTick > 0) textareaRef.current?.focus();
  }, [focusTick]);

  const body = bodies[mode];

  // The box grows with the text, from 3 rows to 12, then scrolls.
  useLayoutEffect(() => {
    const area = textareaRef.current;
    if (!area) return;
    const line = parseFloat(getComputedStyle(area).lineHeight) || 21;
    area.style.height = 'auto';
    const wanted = Math.min(area.scrollHeight, line * MAX_ROWS + 16);
    area.style.height = `${String(Math.max(wanted, line * MIN_ROWS + 16))}px`;
  }, [body, mode]);

  const focusComposer = (target: Mode) => {
    setMode(target);
    setFocusTick((tick) => tick + 1);
  };
  useShortcut(
    'c',
    () => {
      focusComposer('reply');
    },
    replyAllowed,
  );
  useShortcut(
    'n',
    () => {
      focusComposer('note');
    },
    canNote,
  );

  const quote = (text: string) => {
    if (!replyAllowed) return;
    setMode('reply');
    setBodies((current) => {
      const next = `${current.reply}${current.reply && !current.reply.endsWith('\n') ? '\n\n' : ''}${asQuote(text)}`;
      draftStore.set(ticket.key, 'reply', next);
      return { ...current, reply: next };
    });
    setSent(null);
    setFocusTick((tick) => tick + 1);
  };
  useImperativeHandle(handleRef, () => ({
    quote,
    focus: (target) => {
      if (target === 'reply' && replyAllowed) setMode('reply');
      if (target === 'note' && canNote) setMode('note');
      setFocusTick((tick) => tick + 1);
    },
  }));

  const quoted = useRef(false);
  useEffect(() => {
    if (initialQuote === undefined || quoted.current) return;
    quoted.current = true;
    quote(initialQuote);
    // Runs once, when the box appears with a quote waiting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!canReply && !canNote) return null;

  if (isClosedForReplies(ticket.status)) {
    return (
      <div className="border-t border-border p-3">
        <Alert tone="info" title={t('composer.closed.title')}>
          {t('composer.closed.body')}
        </Alert>
      </div>
    );
  }

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
  const showVia = mode === 'reply' && isStaff;

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
        {
          onSuccess: (result) => {
            // The server holds a Gmail or LINE reply for its undo window; Undo cancels it there.
            offer(result.message);
            done();
          },
        },
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
  const isNote = mode === 'note';
  const submitLabel = mutation.isPending
    ? t('composer.sending')
    : isNote
      ? t('composer.submit.note')
      : nextStatus
        ? t('composer.submit.replyAndSet', { status: t(statusKey(nextStatus)) })
        : t('composer.submit.reply');
  const SubmitIcon = isNote ? Lock : Send;
  const textareaId = `${ids}-body`;
  const hintId = `${ids}-hint`;
  const placeholder = t(
    isNote
      ? 'composer.placeholders.note'
      : isStaff
        ? 'composer.placeholders.reply'
        : 'composer.placeholders.client',
  );
  const soon = t('composer.toolbar.phase1');

  return (
    <form
      aria-label={t('composer.label')}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="shrink-0 border-t border-border p-3"
    >
      <div
        data-mode={mode}
        className={cn(
          'rounded-2xl border transition-colors duration-(--wt-motion-duration-fast) ease-out focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-ring',
          isNote
            ? 'border-dashed border-border-strong bg-surface-muted'
            : 'border-border-strong bg-surface',
        )}
      >
        <div className="flex flex-wrap items-center gap-2 px-2 pt-2">
          {replyAllowed && canNote ? (
            <SegmentedControl
              aria-label={t('composer.modeGroup')}
              value={mode}
              onValueChange={(value) => {
                setMode(value);
                setSent(null);
              }}
              options={[
                {
                  value: 'reply',
                  label: t('composer.modes.reply'),
                  icon: <MessageCircle aria-hidden className="size-3.5" />,
                },
                {
                  value: 'note',
                  label: t('composer.modes.noteShort'),
                  ariaLabel: t('composer.modes.note'),
                  icon: <Lock aria-hidden className="size-3.5" />,
                },
              ]}
            />
          ) : (
            <span className="inline-flex h-7 items-center gap-1.5 px-1 text-sm font-medium">
              <ModeIcon aria-hidden className="size-3.5" />
              {modeLabel}
            </span>
          )}
          {noOutbound && canReply ? (
            <span
              data-testid="reply-off"
              aria-disabled="true"
              className="inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-sm font-medium text-muted-foreground line-through opacity-60"
            >
              <MessageCircle aria-hidden className="size-3.5" />
              {t('composer.modes.reply')}
              <span className="sr-only">{t('composer.noOutbound.off')}</span>
            </span>
          ) : null}
          {isNote ? (
            <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock aria-hidden className="size-3.5" />
              {t('composer.noteBanner')}
            </p>
          ) : null}
        </div>

        <label htmlFor={textareaId} className="sr-only">
          {t(isNote ? 'composer.fields.note' : 'composer.fields.reply')}
        </label>
        <textarea
          ref={textareaRef}
          id={textareaId}
          value={body}
          rows={MIN_ROWS}
          placeholder={placeholder}
          onChange={(event) => {
            setBody(event.target.value);
          }}
          onKeyDown={onKeyDown}
          aria-describedby={isNote ? undefined : hintId}
          aria-keyshortcuts="Control+Enter Meta+Enter"
          className="block w-full resize-none bg-transparent px-3 py-2 text-sm leading-normal text-foreground outline-hidden placeholder:text-muted-foreground"
        />

        <div
          role="group"
          aria-label={t('composer.toolbar.label')}
          className="flex flex-wrap items-center gap-1 px-2 pb-2"
        >
          {showTemplates ? (
            <Combobox
              id={`${ids}-template`}
              listLabel={t('composer.template.label')}
              searchPlaceholder={t('composer.toolbar.templateSearch')}
              emptyText={t('details.noMatches')}
              selectedText={t('details.selected')}
              disabled={templates.length === 0}
              options={templates.map((template) => ({ value: template.key, label: template.name }))}
              value=""
              onValueChange={insertTemplate}
              className="mx-0 h-control w-auto text-muted-foreground hover:text-foreground"
            >
              <FileText aria-hidden className="size-4" />
              <span className="sr-only">
                {templates.length === 0
                  ? t('composer.template.none')
                  : t('composer.template.choose')}
              </span>
            </Combobox>
          ) : null}
          {isStaff ? (
            <>
              <IconButton
                aria-disabled="true"
                label={t('composer.toolbar.attach')}
                tooltip={`${t('composer.toolbar.attach')} — ${soon}`}
                icon={<Paperclip aria-hidden className="size-4" />}
                className="text-muted-foreground"
              />
            </>
          ) : null}

          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {showVia && 'channel' in ticket ? (
              <Tooltip content={t('outbound.viaTip')}>
                <span
                  data-testid="send-via"
                  className="inline-flex h-7 items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <ChannelIcon channel={ticket.channel} />
                  {t('outbound.via', { channel: t(`channel.${ticket.channel}`) })}
                </span>
              </Tooltip>
            ) : null}
            {showStatus ? (
              <DropdownMenu>
                <Tooltip content={t('composer.setStatus.label')}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      className="gap-1 rounded-full px-2 text-muted-foreground"
                      aria-label={`${t('composer.setStatus.label')}: ${nextStatus ? t(statusKey(nextStatus)) : t('composer.setStatus.keep')}`}
                    >
                      <Flag aria-hidden className="size-4" />
                      {nextStatus ? <span aria-hidden>{t(statusKey(nextStatus))}</span> : null}
                      <ChevronDown aria-hidden className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </Tooltip>
                <DropdownMenuContent align="end" side="top">
                  <DropdownMenuRadioGroup
                    value={nextStatus}
                    onValueChange={(value) => {
                      const match = nextOptions.find((status) => status === value);
                      setNextStatus(match ?? '');
                    }}
                  >
                    <DropdownMenuRadioItem value="">
                      {t('composer.setStatus.keep')}
                    </DropdownMenuRadioItem>
                    {nextOptions.map((status) => (
                      <DropdownMenuRadioItem key={status} value={status}>
                        {t(statusKey(status))}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              disabled={!canSend}
              className="gap-1.5 rounded-full px-4"
              aria-label={submitLabel}
              aria-keyshortcuts="Control+Enter Meta+Enter"
            >
              <SubmitIcon aria-hidden className="size-4" />
              <span aria-hidden>
                {mutation.isPending
                  ? t('composer.sending')
                  : isNote
                    ? t('composer.submit.note')
                    : t('composer.submit.reply')}
                {!isNote && !mutation.isPending && nextStatus
                  ? ` · ${t(statusKey(nextStatus))}`
                  : ''}
              </span>
            </Button>
          </div>
        </div>
      </div>

      {isNote ? null : (
        <div className="mt-1.5 flex items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
          <p id={hintId}>{t(hintKey, { channel: channelName ?? '' })}</p>
          <span aria-hidden className="hidden shrink-0 items-center gap-0.5 sm:inline-flex">
            <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>
              <CornerDownLeft className="size-3" />
            </Kbd>
          </span>
        </div>
      )}

      {showVia && viaLine ? <LineQuotaNote quota={quota.data} /> : null}

      {noOutbound && canReply ? (
        <Alert tone="info" title={t('composer.noOutbound.title')} className="mt-2">
          <span data-testid="no-outbound">
            {t('composer.noOutbound.body', { channel: t(`channel.${ticketChannel}`) })}
          </span>
        </Alert>
      ) : null}

      {unresolved.length > 0 ? (
        <Alert tone="error" title={t('composer.unresolved.title')} className="mt-2">
          {t('composer.unresolved.body', { names: unresolved.join(', ') })}
        </Alert>
      ) : null}

      {mutation.isError ? (
        <Alert tone="error" title={t('composer.errors.title')} className="mt-2">
          {sendErrorText(mutation.error, t)}
        </Alert>
      ) : null}

      <div role="status" className="px-1 text-xs text-muted-foreground">
        {sent ? (sent === 'reply' ? t('composer.sent.reply') : t('composer.sent.note')) : null}
      </div>
    </form>
  );
}
