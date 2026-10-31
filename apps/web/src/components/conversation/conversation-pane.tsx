'use client';

import { Alert, Button, EmptyState, SeverityBadge, Skeleton, toast, Tooltip } from '@watchtower/ui';
import { CircleCheck, Copy, MessagesSquare } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';

import { SlaBadge } from '@/components/ticket/sla-badge';
import { StatusLabel } from '@/components/ticket/status-label';
import { TicketDetails } from '@/components/ticket/ticket-details';
import { useOptimisticEdit } from '@/components/ticket/use-optimistic-edit';
import { useI18n } from '@/i18n/provider';
import { isApiError } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';
import { type TicketItem, severityOf } from '@/lib/tickets/model';
import { slaView } from '@/lib/tickets/sla';
import { useTicket, useTicketMutations, useTimeline, useWorkflow } from '@/lib/tickets/queries';
import { statusKey } from '@/lib/tickets/status-key';
import { allowedNextStatuses } from '@/lib/tickets/templates';
import { useNow } from '@/lib/use-now';

import { Composer, type ComposerHandle } from './composer';
import { Timeline } from './timeline';

const HEADER =
  'flex min-h-[48px] shrink-0 items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2';

/** The header actions of an open ticket: copy the key, resolve it. */
function TicketActions({ ticket, trailing }: { ticket: TicketItem; trailing?: ReactNode }) {
  const { t } = useI18n();
  const { can } = useSession();
  const canEdit = can('ticket.handle');
  const workflow = useWorkflow(canEdit);
  const mutations = useTicketMutations(ticket.key);
  const edit = useOptimisticEdit(ticket);

  const canResolve =
    canEdit && allowedNextStatuses(workflow.data, ticket.status).includes('resolved');
  const resolve = () => {
    const previous = ticket.status;
    edit.run({
      optimistic: { ...ticket, status: 'resolved' },
      message: t('details.changed.status', { value: t(statusKey('resolved')) }),
      undo: allowedNextStatuses(workflow.data, 'resolved').includes(previous)
        ? () => {
            mutations.changeStatus.mutate(
              { status: previous },
              {
                onSuccess: () => {
                  toast(t('details.undone'));
                },
                onError: () => {
                  toast(t('details.undoFailed'));
                },
              },
            );
          }
        : undefined,
      send: (callbacks) => {
        mutations.changeStatus.mutate({ status: 'resolved' }, callbacks);
      },
    });
  };

  return (
    <div
      role="group"
      aria-label={t('conversation.headerActions')}
      className="flex items-center gap-1"
    >
      <Tooltip content={t('conversation.copyKey')}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('conversation.copyKey')}
          onClick={() => {
            void navigator.clipboard
              .writeText(ticket.key)
              .then(() => {
                toast(t('conversation.keyCopied', { key: ticket.key }));
              })
              .catch(() => undefined);
          }}
        >
          <Copy aria-hidden className="size-4" />
        </Button>
      </Tooltip>
      {canResolve ? (
        <Button variant="secondary" disabled={mutations.changeStatus.isPending} onClick={resolve}>
          <CircleCheck aria-hidden className="size-4" />
          {t('conversation.resolve')}
        </Button>
      ) : null}
      {trailing}
    </div>
  );
}

/**
 * The open ticket: a 48px header (key, subject, status and priority pills, SLA, actions), the
 * message timeline and the composer. The ticket's properties live in the right-hand panel; only a
 * customer, who has no panel, sees them here, read-only.
 */
export function ConversationPane({
  ticketKey,
  trailing,
}: {
  ticketKey: string | null;
  /** Extra buttons at the end of the header (the details-panel button on a mid-size screen). */
  trailing?: ReactNode;
}) {
  const { t } = useI18n();
  const { isClient, can } = useSession();
  const ticket = useTicket(ticketKey);
  const timeline = useTimeline(ticketKey);
  const now = useNow();
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);

  const entries = useMemo(
    () => (timeline.data?.pages ?? []).flatMap((page) => page.entries),
    [timeline.data],
  );

  // Show the newest message when a ticket opens or a message arrives, unless the reader has
  // scrolled up to read history.
  const lastCount = useRef(0);
  useEffect(() => {
    const area = scrollRef.current;
    if (!area) return;
    const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 160;
    if (lastCount.current === 0 || nearBottom) area.scrollTop = area.scrollHeight;
    lastCount.current = entries.length;
  }, [entries.length]);
  useEffect(() => {
    lastCount.current = 0;
  }, [ticketKey]);

  if (ticketKey === null) {
    return (
      <>
        <div className={HEADER}>
          <span className="flex-1" />
          {trailing}
        </div>
        <EmptyState
          className="flex-1"
          icon={<MessagesSquare />}
          title={t('panes.conversation.emptyTitle')}
          description={t('panes.conversation.emptyBody')}
        />
      </>
    );
  }

  if (ticket.isPending) {
    return (
      <>
        <div className={HEADER}>
          <Skeleton className="h-5 w-1/2" />
          <span className="flex-1" />
          {trailing}
        </div>
        <div role="status" className="flex flex-col gap-3 p-4">
          <span className="sr-only">{t('conversation.loading')}</span>
          <Skeleton className="h-16 w-2/3" />
          <Skeleton className="ml-auto h-16 w-2/3" />
          <Skeleton className="h-16 w-1/2" />
        </div>
      </>
    );
  }

  if (ticket.isError) {
    const notFound = isApiError(ticket.error) && ticket.error.status === 404;
    return (
      <>
        <div className={HEADER}>
          <span className="flex-1" />
          {trailing}
        </div>
        <div className="p-4">
          <Alert
            tone="error"
            title={notFound ? t('conversation.notFound.title') : t('conversation.error.title')}
          >
            <p>{notFound ? t('conversation.notFound.body') : t('conversation.error.body')}</p>
            {notFound ? null : (
              <Button
                className="mt-2"
                onClick={() => {
                  void ticket.refetch();
                }}
              >
                {t('errors.retry')}
              </Button>
            )}
          </Alert>
        </div>
      </>
    );
  }

  const data = ticket.data;
  const canQuote = can('ticket.reply') || can('ticket.reply.own');

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-ticket-key={data.key}>
      {/* Outside the scrolling area, so opening a ticket (which scrolls to the newest message) never hides it. */}
      <header className={`${HEADER} flex-wrap`}>
        <div className="flex min-w-0 flex-[1_1_14rem] items-baseline gap-2">
          <span className="shrink-0 font-mono text-xs whitespace-nowrap text-muted-foreground">
            {data.key}
          </span>
          <h3 className="min-w-0 truncate text-base font-semibold">{data.subject}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusLabel status={data.status} pill />
          <SeverityBadge
            severity={severityOf(data.priority)}
            label={t(`severity.${severityOf(data.priority)}`)}
          />
          <SlaBadge sla={slaView(data, now)} />
        </div>
        <TicketActions ticket={data} trailing={trailing} />
      </header>
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {isClient ? (
          <div className="border-b border-border">
            <TicketDetails ticket={data} />
          </div>
        ) : null}

        <div aria-busy={timeline.isFetching}>
          {timeline.isPending ? (
            <div role="status" className="flex flex-col gap-3 p-4">
              <span className="sr-only">{t('conversation.loadingMessages')}</span>
              <Skeleton className="h-16 w-2/3" />
              <Skeleton className="ml-auto h-16 w-2/3" />
            </div>
          ) : timeline.isError ? (
            <div className="p-4">
              <Alert tone="error" title={t('conversation.timelineError.title')}>
                <Button
                  className="mt-2"
                  onClick={() => {
                    void timeline.refetch();
                  }}
                >
                  {t('errors.retry')}
                </Button>
              </Alert>
            </div>
          ) : entries.length === 0 ? (
            <EmptyState
              icon={<MessagesSquare />}
              title={t('conversation.noMessages.title')}
              description={t('conversation.noMessages.body')}
            />
          ) : (
            <Timeline
              entries={entries}
              canQuote={canQuote}
              onQuote={(text) => composerRef.current?.quote(text)}
            />
          )}
        </div>
      </div>
      <Composer key={data.key} ticket={data} handleRef={composerRef} />
    </div>
  );
}
