'use client';

import {
  TICKET_EVENT_TYPES,
  ticketStatusSchema,
  type Message,
  type TimelineEntry,
} from '@watchtower/shared';
import { cn } from '@watchtower/ui';
import {
  AlertTriangle,
  Clock,
  Lock,
  MessageSquareReply,
  Send,
  Settings2,
  UserRound,
} from 'lucide-react';

import { useI18n } from '@/i18n/provider';
import { statusKey } from '@/lib/tickets/status-key';
import { formatDateTime } from '@/lib/format';

type EventEntry = Extract<TimelineEntry, { kind: 'event' }>;

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
    default:
      return <>{t('timeline.events.updated')}</>;
  }
}

function EventRow({ entry }: { entry: EventEntry }) {
  const { t, locale } = useI18n();
  const Icon = entry.type.startsWith('sla.') ? Clock : Settings2;
  const actor = entry.actor.name ?? (entry.actor.type === 'ai' ? t('timeline.actorAi') : null);
  return (
    <li className="flex items-start gap-2 px-pane py-1.5 text-xs text-muted-foreground">
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <p className="min-w-0">
        <EventText entry={entry} />
        {actor ? <span> {t('timeline.byActor', { name: actor })}</span> : null}{' '}
        <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt, locale)}</time>
      </p>
    </li>
  );
}

/** What kind of message this is, as words. The same distinction is also an icon and a border style. */
function messageKind(message: Message): 'internal' | 'reply' | 'customer' {
  if (message.visibility === 'internal') return 'internal';
  return message.direction === 'outbound' ? 'reply' : 'customer';
}

function DeliveryNote({ message }: { message: Message }) {
  const t = useI18n().t;
  if (message.deliveryStatus === 'not_applicable' || message.deliveryStatus === 'delivered') {
    return null;
  }
  const failed = message.deliveryStatus === 'failed';
  const Icon = failed ? AlertTriangle : Clock;
  return (
    <p
      className={cn('mt-2 flex items-center gap-1 text-xs', failed && 'font-semibold text-danger')}
    >
      <Icon aria-hidden className="size-3.5" />
      {failed ? t('timeline.delivery.failed') : t('timeline.delivery.pending')}
    </p>
  );
}

function MessageRow({ message }: { message: Message }) {
  const { t, locale } = useI18n();
  const kind = messageKind(message);
  const Icon = kind === 'internal' ? Lock : kind === 'reply' ? Send : MessageSquareReply;
  const author =
    message.sender.name ??
    (message.sender.type === 'system' ? t('timeline.system') : t('timeline.unknownSender'));
  const AuthorIcon = message.sender.type === 'contact' ? UserRound : null;

  return (
    <li className="px-pane py-2">
      <article
        data-message-kind={kind}
        aria-label={t(`timeline.kinds.${kind}`)}
        className={cn(
          'rounded-lg border px-3 py-2',
          kind === 'internal' && 'border-dashed border-border-strong bg-surface-muted',
          kind === 'reply' && 'border-solid border-border-strong bg-surface',
          kind === 'customer' && 'border-solid border-border bg-surface',
        )}
      >
        <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-semibold',
              kind === 'internal'
                ? 'border-dashed border-border-strong'
                : kind === 'reply'
                  ? 'border-border-strong bg-primary text-primary-foreground'
                  : 'border-border-strong',
            )}
          >
            <Icon aria-hidden className="size-3.5" />
            {t(`timeline.kinds.${kind}`)}
          </span>
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            {AuthorIcon ? <AuthorIcon aria-hidden className="size-3.5" /> : null}
            {author}
          </span>
          <span className="text-muted-foreground">{t(`channel.${message.channel}`)}</span>
          <time dateTime={message.createdAt} className="ml-auto text-muted-foreground">
            {formatDateTime(message.createdAt, locale)}
          </time>
        </header>
        {kind === 'internal' ? (
          <p className="mt-1 text-xs text-muted-foreground">{t('timeline.internalHint')}</p>
        ) : null}
        {/* Plain text, preserved line breaks. Never rendered as HTML. */}
        <p className="mt-2 text-sm break-words whitespace-pre-wrap text-foreground">
          {message.bodyText}
        </p>
        <DeliveryNote message={message} />
      </article>
    </li>
  );
}

/** Messages and system events in time order. Public replies and internal notes look different. */
export function Timeline({ entries }: { entries: readonly TimelineEntry[] }) {
  const t = useI18n().t;
  return (
    <ol aria-label={t('timeline.label')} className="flex flex-col py-1">
      {entries.map((entry) =>
        entry.kind === 'message' ? (
          <MessageRow key={`m-${entry.id}`} message={entry} />
        ) : (
          <EventRow key={`e-${entry.id}`} entry={entry} />
        ),
      )}
    </ol>
  );
}
