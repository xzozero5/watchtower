'use client';

import {
  TICKET_EVENT_TYPES,
  ticketStatusSchema,
  type Message,
  type TimelineEntry,
} from '@watchtower/shared';
import { Avatar, cn, toast, Tooltip } from '@watchtower/ui';
import { Fragment, useState } from 'react';

import { AlertTriangle, Bot, Clock, Copy, Lock, Quote, Settings2, Undo2 } from 'lucide-react';

import { ChannelIcon } from '@/components/ticket/channel-icon';
import { useI18n } from '@/i18n/provider';
import { formatAge, formatDateTime } from '@/lib/format';
import { useSendUndo } from '@/lib/outbound/queries';
import { useNow } from '@/lib/use-now';
import { statusKey } from '@/lib/tickets/status-key';

import { EmailMessageCard } from './email/email-message';
import { defaultExpandedIds, emailMessages, isEmailMessage, threadSubject } from './email/thread';
import { MessageAttachments } from './message-attachments';

type EventEntry = Extract<TimelineEntry, { kind: 'event' }>;
type MessageEntry = Extract<TimelineEntry, { kind: 'message' }>;

/** Messages by the same author, of the same kind, this close together read as one block. */
export const GROUP_WINDOW_MS = 5 * 60_000;

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** One line for a system event. Unknown types fall back to a neutral sentence. */
function EventText({ entry }: { entry: EventEntry }) {
  const { t } = useI18n();
  const payload = entry.payload;
  switch (entry.type) {
    case TICKET_EVENT_TYPES.created:
      return <>{t('timeline.events.created')}</>;
    case TICKET_EVENT_TYPES.statusChanged: {
      const from = ticketStatusSchema.safeParse(payload.from);
      const to = ticketStatusSchema.safeParse(payload.to);
      if (from.success && to.success) {
        return (
          <>
            {t('timeline.events.statusChanged', {
              from: t(statusKey(from.data)),
              to: t(statusKey(to.data)),
            })}
          </>
        );
      }
      return <>{t('timeline.events.updated')}</>;
    }
    case TICKET_EVENT_TYPES.assigned:
      return <>{t('timeline.events.assigned')}</>;
    case TICKET_EVENT_TYPES.merged: {
      const into = str(payload.intoKey);
      return (
        <>{into ? t('timeline.events.mergedInto', { key: into }) : t('timeline.events.merged')}</>
      );
    }
    case TICKET_EVENT_TYPES.mergeReceived: {
      const from = str(payload.fromKey);
      return (
        <>
          {from
            ? t('timeline.events.mergeReceivedFrom', { key: from })
            : t('timeline.events.mergeReceived')}
        </>
      );
    }
    case TICKET_EVENT_TYPES.reopened:
      return <>{t('timeline.events.reopened')}</>;
    case TICKET_EVENT_TYPES.slaPaused:
      return <>{t('timeline.events.slaPaused')}</>;
    case TICKET_EVENT_TYPES.slaResumed:
      return <>{t('timeline.events.slaResumed')}</>;
    case TICKET_EVENT_TYPES.slaRecalculated:
      return <>{t('timeline.events.slaRecalculated')}</>;
    case TICKET_EVENT_TYPES.messageSendCancelled:
      return <>{t('timeline.events.sendCancelled')}</>;
    case TICKET_EVENT_TYPES.messageDeliveryFailed:
      return <>{t('timeline.events.deliveryFailed')}</>;
    default:
      return <>{t('timeline.events.updated')}</>;
  }
}

/** A system or AI event: one line (icon, sentence, time), not a bubble. */
function EventRow({ entry, now }: { entry: EventEntry; now: number }) {
  const { t, locale } = useI18n();
  const byAi = entry.actor.type === 'ai';
  const Icon = byAi ? Bot : entry.type.startsWith('sla.') ? Clock : Settings2;
  const actor = entry.actor.name ?? (byAi ? t('timeline.actorAi') : null);
  return (
    <li className="flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground">
      <Icon aria-hidden className={cn('size-3.5 shrink-0', byAi && 'text-ai-accent')} />
      <p className="min-w-0 flex-1 truncate">
        <EventText entry={entry} />
        {actor ? <span> {t('timeline.byActor', { name: actor })}</span> : null}
      </p>
      <Tooltip content={formatDateTime(entry.createdAt, locale)} side="left">
        <time dateTime={entry.createdAt} className="tabular shrink-0">
          {formatAge(entry.createdAt, now, locale) ?? t('timeline.now')}
        </time>
      </Tooltip>
    </li>
  );
}

/** What kind of message this is, as words. The same distinction is also an icon and a border style. */
function messageKind(message: Message): 'internal' | 'reply' | 'customer' {
  if (message.visibility === 'internal') return 'internal';
  return message.direction === 'outbound' ? 'reply' : 'customer';
}

/**
 * Where a staff reply is (ADR-010): waiting out the undo window (with Undo while the server still
 * allows it), undone, or not delivered. Delivered and not-applicable say nothing.
 */
function DeliveryNote({ message }: { message: Message }) {
  const { t } = useI18n();
  const { undo } = useSendUndo(message.ticketKey);
  if (message.deliveryStatus === 'not_applicable' || message.deliveryStatus === 'delivered') {
    return null;
  }
  const failed = message.deliveryStatus === 'failed';
  const cancelled = message.deliveryStatus === 'cancelled';
  const scheduled = message.deliveryStatus === 'scheduled';
  const Icon = failed ? AlertTriangle : cancelled ? Undo2 : Clock;
  const cancellable = scheduled && message.delivery?.cancellable === true;
  return (
    <p
      className={cn('mt-2 flex items-center gap-1 text-xs', failed && 'font-semibold text-danger')}
    >
      <Icon aria-hidden className="size-3.5" />
      {failed
        ? t('timeline.delivery.failed')
        : cancelled
          ? t('outbound.delivery.cancelled')
          : scheduled
            ? t('outbound.delivery.scheduled')
            : t('timeline.delivery.pending')}
      {cancellable && message.delivery ? (
        <button
          type="button"
          onClick={() => {
            void undo(message.delivery?.id ?? '');
          }}
          className="ml-1 rounded-sm font-medium text-link underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {t('outbound.undo')}
        </button>
      ) : null}
    </p>
  );
}

function sameBlock(previous: TimelineEntry | undefined, message: MessageEntry): boolean {
  if (previous?.kind !== 'message') return false;
  if (messageKind(previous) !== messageKind(message)) return false;
  if (previous.sender.type !== message.sender.type) return false;
  if ((previous.sender.id ?? previous.sender.name) !== (message.sender.id ?? message.sender.name)) {
    return false;
  }
  return Math.abs(Date.parse(message.createdAt) - Date.parse(previous.createdAt)) < GROUP_WINDOW_MS;
}

const ICON_BUTTON =
  'inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--wt-motion-duration-fast) ease-out hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring';

function MessageRow({
  message,
  continued,
  now,
  onQuote,
  canQuote,
}: {
  message: MessageEntry;
  now: number;
  /** True when this message continues the block above: no avatar or name again. */
  continued: boolean;
  onQuote?: (text: string) => void;
  canQuote: boolean;
}) {
  const { t, locale } = useI18n();
  const kind = messageKind(message);
  const author =
    message.sender.name ??
    (message.sender.type === 'system' ? t('timeline.system') : t('timeline.unknownSender'));
  const staffSide = kind !== 'customer';
  const exact = formatDateTime(message.createdAt, locale);

  const copy = () => {
    void navigator.clipboard
      .writeText(message.bodyText)
      .then(() => {
        toast(t('timeline.copied'));
      })
      .catch(() => undefined);
  };

  return (
    <li
      className={cn(
        'group/message flex px-4',
        continued ? 'pt-0.5' : 'pt-3',
        staffSide && 'justify-end',
      )}
    >
      <article
        data-message-kind={kind}
        aria-label={t(`timeline.kinds.${kind}`)}
        className={cn(
          'relative w-fit max-w-[88%] min-w-0 rounded-lg border px-3 py-2',
          kind === 'internal' && 'border-dashed border-border-strong bg-surface-muted',
          kind === 'reply' && 'border-solid border-transparent bg-primary-subtle',
          kind === 'customer' && 'border-solid border-transparent bg-surface-muted',
        )}
      >
        <header
          className={cn(
            'flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs',
            continued ? 'sr-only' : 'mb-1',
          )}
        >
          <Avatar name={author} id={message.sender.id ?? author} size={20} />
          <span className="text-sm font-medium text-foreground">{author}</span>
          {kind === 'internal' ? (
            <span className="inline-flex items-center text-muted-foreground">
              <Lock aria-hidden className="size-3.5" />
              <span className="sr-only">{t('timeline.kinds.internal')}</span>
            </span>
          ) : null}
          <ChannelIcon channel={message.channel} className="text-muted-foreground" />
          <Tooltip content={exact}>
            <time dateTime={message.createdAt} className="tabular ml-auto text-muted-foreground">
              {formatAge(message.createdAt, now, locale) ?? t('timeline.now')}
            </time>
          </Tooltip>
        </header>
        {/* Plain text, preserved line breaks. Never rendered as HTML. */}
        <p className="text-sm break-words whitespace-pre-wrap text-foreground">
          {message.bodyText}
        </p>
        <MessageAttachments message={message} />
        <DeliveryNote message={message} />
        {continued ? (
          <Tooltip content={t('timeline.at', { time: exact })}>
            <time dateTime={message.createdAt} className="sr-only">
              {formatAge(message.createdAt, now, locale) ?? t('timeline.now')}
            </time>
          </Tooltip>
        ) : null}

        <div
          role="group"
          aria-label={t('timeline.actions')}
          className={cn(
            'absolute -top-3 flex gap-0.5 rounded-md border border-border bg-surface p-0.5 opacity-0 shadow-overlay transition-opacity duration-(--wt-motion-duration-fast) ease-out group-hover/message:opacity-100 focus-within:opacity-100',
            staffSide ? 'right-2' : 'left-2',
          )}
        >
          <Tooltip content={t('timeline.copy')}>
            <button
              type="button"
              aria-label={t('timeline.copy')}
              onClick={copy}
              className={ICON_BUTTON}
            >
              <Copy aria-hidden className="size-3.5" />
            </button>
          </Tooltip>
          {canQuote && onQuote && kind !== 'internal' ? (
            <Tooltip content={t('timeline.quote')}>
              <button
                type="button"
                aria-label={t('timeline.quote')}
                onClick={() => {
                  onQuote(message.bodyText);
                  toast(t('timeline.quoted'));
                }}
                className={ICON_BUTTON}
              >
                <Quote aria-hidden className="size-3.5" />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </article>
    </li>
  );
}

/** An email in the thread: a Gmail-style card, full width, collapsed or open. */
function EmailRow({
  message,
  expanded,
  onToggle,
  onQuote,
  canQuote,
}: {
  message: MessageEntry;
  expanded: boolean;
  onToggle: () => void;
  onQuote?: (text: string) => void;
  canQuote: boolean;
}) {
  const { t } = useI18n();
  const kind = messageKind(message) === 'reply' ? 'reply' : 'customer';
  const copy = () => {
    void navigator.clipboard
      .writeText(message.bodyText)
      .then(() => {
        toast(t('timeline.copied'));
      })
      .catch(() => undefined);
  };
  return (
    <li className="px-4 pt-3">
      <EmailMessageCard
        message={message}
        kind={kind}
        expanded={expanded}
        onToggle={onToggle}
        footer={<DeliveryNote message={message} />}
        actions={
          <div role="group" aria-label={t('timeline.actions')} className="flex gap-0.5">
            <Tooltip content={t('timeline.copy')}>
              <button
                type="button"
                aria-label={t('timeline.copy')}
                onClick={copy}
                className={ICON_BUTTON}
              >
                <Copy aria-hidden className="size-3.5" />
              </button>
            </Tooltip>
            {canQuote && onQuote ? (
              <Tooltip content={t('timeline.quote')}>
                <button
                  type="button"
                  aria-label={t('timeline.quote')}
                  onClick={() => {
                    onQuote(message.bodyText);
                    toast(t('timeline.quoted'));
                  }}
                  className={ICON_BUTTON}
                >
                  <Quote aria-hidden className="size-3.5" />
                </button>
              </Tooltip>
            ) : null}
          </div>
        }
      />
    </li>
  );
}

/** The subject of the thread, how many mails it has, and Expand all / Collapse all. */
function ThreadHeader({
  subject,
  count,
  allOpen,
  onToggleAll,
}: {
  subject: string | null;
  count: number;
  allOpen: boolean;
  onToggleAll: () => void;
}) {
  const { t } = useI18n();
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3">
      {subject ? (
        <h3 className="min-w-0 flex-1 text-base font-medium break-words text-foreground">
          {subject}
        </h3>
      ) : (
        <span className="flex-1" />
      )}
      <span className="text-xs text-muted-foreground">{t('email.thread.messages', { count })}</span>
      {count > 1 ? (
        <button
          type="button"
          onClick={onToggleAll}
          className="rounded-sm text-xs text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {allOpen ? t('email.thread.collapseAll') : t('email.thread.expandAll')}
        </button>
      ) : null}
    </li>
  );
}

/**
 * Messages and system events in time order. A customer's message sits on the left on a raised
 * surface; a team reply sits on the right on a navy tint; an internal note keeps its dashed border
 * and lock. Messages by the same author within five minutes read as one block. Events are one line.
 */
export function Timeline({
  entries,
  onQuote,
  canQuote = false,
}: {
  entries: readonly TimelineEntry[];
  onQuote?: (text: string) => void;
  canQuote?: boolean;
}) {
  const t = useI18n().t;
  const now = useNow();
  // Email is drawn as a thread: the newest mail is open, older ones are a line each. A person's own
  // toggles win over that default.
  const mails = emailMessages(entries);
  const defaults = defaultExpandedIds(entries);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const isOpen = (id: string) => overrides[id] ?? defaults.has(id);
  const allOpen = mails.every((mail) => isOpen(mail.id));
  const firstMailId = mails[0]?.id ?? null;
  return (
    <ol aria-label={t('timeline.label')} className="flex flex-col pt-1 pb-3">
      {entries.map((entry, index) =>
        entry.kind === 'message' && isEmailMessage(entry) ? (
          <Fragment key={`m-${entry.id}`}>
            {entry.id === firstMailId ? (
              <ThreadHeader
                subject={threadSubject(entries)}
                count={mails.length}
                allOpen={allOpen}
                onToggleAll={() => {
                  setOverrides(Object.fromEntries(mails.map((mail) => [mail.id, !allOpen])));
                }}
              />
            ) : null}
            <EmailRow
              message={entry}
              expanded={isOpen(entry.id)}
              onToggle={() => {
                setOverrides((current) => ({ ...current, [entry.id]: !isOpen(entry.id) }));
              }}
              onQuote={onQuote}
              canQuote={canQuote}
            />
          </Fragment>
        ) : entry.kind === 'message' ? (
          <MessageRow
            key={`m-${entry.id}`}
            message={entry}
            continued={sameBlock(entries[index - 1], entry)}
            now={now}
            onQuote={onQuote}
            canQuote={canQuote}
          />
        ) : (
          <EventRow key={`e-${entry.id}`} entry={entry} now={now} />
        ),
      )}
    </ol>
  );
}
