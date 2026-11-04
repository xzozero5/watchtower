'use client';

import {
  INCIDENTS_TICKET_EVENTS,
  TICKET_EVENT_TYPES,
  ticketPrioritySchema,
  ticketStatusSchema,
  type Message,
  type TimelineEntry,
} from '@watchtower/shared';
import { Avatar, cn, toast, Tooltip } from '@watchtower/ui';
import { Fragment, useState } from 'react';

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Copy,
  Lock,
  Mail,
  Quote,
  Settings2,
  StickyNote,
  Undo2,
} from 'lucide-react';

import { AppLink } from '@/components/app-link';
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
    case TICKET_EVENT_TYPES.assigned: {
      // The API names the people (T-144). Without a name, or for a person who was removed, say so plainly.
      const from = str(payload.fromName);
      const to = str(payload.toName);
      const hadFrom = str(payload.from) !== null;
      const hasTo = str(payload.to) !== null;
      if (!hadFrom && !hasTo) return <>{t('timeline.events.assigned')}</>;
      const label = (name: string | null, present: boolean) =>
        name ?? (present ? t('timeline.events.unknownPerson') : t('timeline.events.unassigned'));
      return (
        <>
          {t('timeline.events.assignedFromTo', {
            from: label(from, hadFrom),
            to: label(to, hasTo),
          })}
        </>
      );
    }
    case TICKET_EVENT_TYPES.updated: {
      const change = payload.priority;
      if (typeof change === 'object' && change !== null) {
        const record = change as Record<string, unknown>;
        const from = ticketPrioritySchema.safeParse(record.from);
        const to = ticketPrioritySchema.safeParse(record.to);
        if (from.success && to.success) {
          return <>{t('timeline.events.priorityChanged', { from: from.data, to: to.data })}</>;
        }
      }
      return <>{t('timeline.events.updated')}</>;
    }
    case INCIDENTS_TICKET_EVENTS.incidentLinked:
    case INCIDENTS_TICKET_EVENTS.incidentUnlinked: {
      const linked = entry.type === INCIDENTS_TICKET_EVENTS.incidentLinked;
      const id = str(payload.incidentId);
      const key = str(payload.incidentKey);
      const sentence = (name: string) =>
        t(linked ? 'timeline.events.incidentLinked' : 'timeline.events.incidentUnlinked', {
          key: name,
        });
      if (id === null || key === null) {
        return (
          <>
            {t(
              linked ? 'timeline.events.incidentLinkedAny' : 'timeline.events.incidentUnlinkedAny',
            )}
          </>
        );
      }
      return (
        <AppLink
          href={`/incidents?incident=${encodeURIComponent(id)}`}
          title={str(payload.incidentTitle) ?? undefined}
          className="rounded-sm text-link underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {sentence(key)}
        </AppLink>
      );
    }
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
 * Where a staff reply or a confirmation email is (ADR-010, T-139): waiting out the undo window (with
 * Undo while the server still allows it), sent (and when), undone, or not delivered. The channel is an
 * icon and a word, the state is an icon and a word, never colour alone. A reply with no delivery
 * behind it (the portal, an internal note) says nothing once it is delivered.
 */
function DeliveryNote({ message }: { message: Message }) {
  const { t, locale } = useI18n();
  const { undo } = useSendUndo(message.ticketKey);
  const delivery = message.delivery;
  if (
    delivery === null &&
    (message.deliveryStatus === 'not_applicable' || message.deliveryStatus === 'delivered')
  ) {
    return null;
  }
  // The delivery is the truth when there is one; the message's own status is the summary otherwise.
  const state =
    delivery?.state ??
    (message.deliveryStatus === 'failed'
      ? 'failed'
      : message.deliveryStatus === 'cancelled'
        ? 'cancelled'
        : message.deliveryStatus === 'scheduled'
          ? 'scheduled'
          : 'sending');
  const failed = state === 'failed';
  const cancellable = state === 'scheduled' && delivery?.cancellable === true;
  const StateIcon = failed
    ? AlertTriangle
    : state === 'cancelled'
      ? Undo2
      : state === 'sent'
        ? CheckCircle2
        : Clock;
  const channel = delivery ? t(`channel.${delivery.channel}`) : null;
  const confirmation = delivery?.origin === 'system_template';
  const text =
    state === 'failed'
      ? t('timeline.delivery.failed')
      : state === 'cancelled'
        ? t('outbound.delivery.cancelled')
        : state === 'scheduled'
          ? t('outbound.delivery.scheduled')
          : state === 'sent'
            ? t('outbound.delivery.sent', {
                time: delivery?.sentAt ? formatDateTime(delivery.sentAt, locale) : '',
              })
            : t('timeline.delivery.pending');
  return (
    <p
      data-delivery-state={state}
      className={cn(
        'mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground',
        failed && 'font-semibold text-danger',
      )}
    >
      {delivery?.channel === 'gmail' ? (
        <>
          <Mail aria-hidden className="size-3.5" />
          <span className="sr-only">{channel}</span>
        </>
      ) : null}
      {confirmation ? <span>{t('outbound.delivery.confirmation')}</span> : null}
      <span className="inline-flex items-center gap-1">
        <StateIcon aria-hidden className="size-3.5" />
        {text}
      </span>
      {cancellable ? (
        <button
          type="button"
          onClick={() => {
            void undo(delivery.id);
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
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <StickyNote aria-hidden className="size-3.5" />
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
