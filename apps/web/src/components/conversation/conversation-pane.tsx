'use client';

import type { TimelineEntry } from '@watchtower/shared';
import {
  Alert,
  Button,
  EmptyState,
  IconButton,
  SeverityBadge,
  Skeleton,
  toast,
} from '@watchtower/ui';
import { CircleCheck, Copy, MessagesSquare, MousePointerClick } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { AiBrief } from '@/components/ai/ai-brief';
import { SlaBadge } from '@/components/ticket/sla-badge';
import { StatusLabel } from '@/components/ticket/status-label';
import { TicketDetails } from '@/components/ticket/ticket-details';
import { useStatusMove } from '@/components/ticket/use-status-move';
import { useI18n } from '@/i18n/provider';
import { hasBrief } from '@/lib/ai/model';
import { useTicketAi } from '@/lib/ai/queries';
import { isApiError } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';
import { type TicketItem, severityOf } from '@/lib/tickets/model';
import { slaView } from '@/lib/tickets/sla';
import { useTicket, useTimeline } from '@/lib/tickets/queries';
import { useNow } from '@/lib/use-now';

import type { ComposerHandle } from './composer';
import { PendingSendBar } from './pending-send-bar';
import { ReplyDock, type ReplyDockHandle } from './reply-dock';
import { Timeline } from './timeline';

/** Index of the newest public message from the customer, or -1. */
export function lastCustomerMessage(entries: readonly TimelineEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.kind === 'message' &&
      entry.direction === 'inbound' &&
      entry.visibility === 'public'
    ) {
      return index;
    }
  }
  return -1;
}

const HEADER =
  'flex min-h-[48px] shrink-0 items-center gap-x-3 gap-y-1 border-b border-border/60 px-4 py-2';

/** The header actions of an open ticket: copy the key, resolve it. */
function TicketActions({ ticket, trailing }: { ticket: TicketItem; trailing?: ReactNode }) {
  const { t } = useI18n();
  const status = useStatusMove(ticket);
  const canResolve = status.can('resolved');

  return (
    <div
      role="group"
      aria-label={t('conversation.headerActions')}
      className="flex items-center gap-1"
    >
      <IconButton
        label={t('conversation.copyKey')}
        icon={<Copy aria-hidden className="size-4" />}
        onClick={() => {
          void navigator.clipboard
            .writeText(ticket.key)
            .then(() => {
              toast(t('conversation.keyCopied', { key: ticket.key }));
            })
            .catch(() => undefined);
        }}
      />
      {canResolve ? (
        <Button
          variant="secondary"
          className="rounded-full"
          disabled={status.pending}
          onClick={() => {
            status.move('resolved');
          }}
        >
          <CircleCheck aria-hidden className="size-4" />
          {t('conversation.resolve')}
        </Button>
      ) : null}
      {trailing}
    </div>
  );
}

/**
 * The open ticket (docs/design/ai-first-workspace.md section 3). One-line header: key, the AI's
 * summary as the title (the subject appears when it is opened), status, priority and SLA pills,
 * actions. Under it, for staff who may review AI work, the AI brief and its draft; then the
 * conversation, folded to the last customer message with "Show N earlier" while the AI leads; and
 * the reply dock, which opens the composer when the person takes over. Without a brief (the api
 * does not serve one, the AI failed, or the person may not review AI) the page is the plain
 * thread and composer as before. The ticket's properties live in the right-hand panel; only a
 * customer, who has no panel, sees them here, read-only.
 */
export function ConversationPane({
  ticketKey,
  trailing,
  onOpenEvidence,
}: {
  ticketKey: string | null;
  /** Extra buttons at the end of the header (the details-panel button on a mid-size screen). */
  trailing?: ReactNode;
  /** An evidence chip or a citation was chosen: show it in the right-hand panel. */
  onOpenEvidence?: (evidenceId: string) => void;
}) {
  const { t } = useI18n();
  const { isClient, can } = useSession();
  const ticket = useTicket(ticketKey);
  const timeline = useTimeline(ticketKey);
  const canReviewAi = can('ai.draft.review') && !isClient;
  const ai = useTicketAi(ticketKey, canReviewAi);
  const now = useNow();
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<Pick<ComposerHandle, 'quote'>>(null);
  const dockRef = useRef<ReplyDockHandle>(null);
  const [subjectFor, setSubjectFor] = useState<string | null>(null);
  const subjectOpen = ticketKey !== null && subjectFor === ticketKey;
  const [earlierFor, setEarlierFor] = useState<string | null>(null);

  // The AI leads while its brief is loading or has something to say. With no brief, or a failed
  // one, the conversation and the composer are the page.
  const aiLed =
    canReviewAi &&
    (ai.isPending || (ai.data !== undefined && hasBrief(ai.data) && ai.data.state !== 'failed'));

  const entries = useMemo(
    () => (timeline.data?.pages ?? []).flatMap((page) => page.entries),
    [timeline.data],
  );
  // While the AI leads, the thread starts at the customer's latest message.
  const lastCustomer = lastCustomerMessage(entries);
  const earlier = aiLed && earlierFor !== ticketKey && lastCustomer > 0 ? lastCustomer : 0;
  const shown = earlier > 0 ? entries.slice(earlier) : entries;
  const canFold = aiLed && lastCustomer > 0;

  // Show the newest message when a ticket opens or a message arrives, unless the reader has
  // scrolled up to read history. While the AI leads the brief is the top of the page instead.
  const lastCount = useRef(0);
  useEffect(() => {
    const area = scrollRef.current;
    if (!area) return;
    const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 160;
    if (aiLed) {
      if (lastCount.current === 0) area.scrollTop = 0;
    } else if (lastCount.current === 0 || nearBottom) {
      area.scrollTop = area.scrollHeight;
    }
    lastCount.current = entries.length;
  }, [entries.length, aiLed]);
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
          icon={<MousePointerClick />}
          tone="sky"
          title={t('panes.conversation.emptyTitle')}
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
  const canWrite = canQuote || can('ticket.handle');
  const canReplyHere = can('ticket.reply') && !isClient;
  const summary = canReviewAi
    ? ai.data?.summary?.trim() || ('ai' in data ? data.ai?.summary?.trim() : undefined) || null
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-ticket-key={data.key}>
      {/* Outside the scrolling area, so opening a ticket (which scrolls) never hides it. */}
      <header className={`${HEADER} flex-wrap`}>
        <div className="flex min-w-0 flex-[1_1_14rem] flex-col">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-xs whitespace-nowrap text-muted-foreground">
              {data.key}
            </span>
            <h3 className="min-w-0 truncate text-base font-semibold">
              {summary ? (
                <button
                  type="button"
                  aria-expanded={subjectOpen}
                  title={data.subject}
                  onClick={() => {
                    setSubjectFor(subjectOpen ? null : data.key);
                  }}
                  className="max-w-full cursor-pointer truncate text-left font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {summary}
                </button>
              ) : (
                data.subject
              )}
            </h3>
          </div>
          {summary && subjectOpen ? (
            <p className="truncate text-xs text-muted-foreground">{data.subject}</p>
          ) : null}
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
      {/* scroll-pb: a control focused with Tab scrolls clear of the draft's sticky action bar. */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 scroll-pb-24 flex-col overflow-y-auto">
        {isClient ? (
          <div className="border-b border-border">
            <TicketDetails ticket={data} />
          </div>
        ) : null}

        {canReviewAi ? (
          <AiBrief
            ticket={data}
            query={ai}
            canReview={canReviewAi}
            canWrite={canWrite}
            canRequest={can('ticket.handle')}
            onOpenEvidence={(id) => onOpenEvidence?.(id)}
            onWriteMyself={() => dockRef.current?.open('reply')}
          />
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
              tone="slate"
              title={t('conversation.noMessages.title')}
            />
          ) : (
            <>
              {canFold ? (
                <div className="px-4 pt-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={earlier === 0}
                    onClick={() => {
                      setEarlierFor(earlier === 0 ? null : ticketKey);
                    }}
                  >
                    {earlier > 0
                      ? t('ai.conversation.showEarlier', { count: earlier })
                      : t('ai.conversation.hideEarlier')}
                  </Button>
                </div>
              ) : null}
              <Timeline
                entries={shown}
                canQuote={canQuote}
                onQuote={(text) => composerRef.current?.quote(text)}
              />
            </>
          )}
        </div>
      </div>
      {canReplyHere ? <PendingSendBar ticketKey={data.key} /> : null}
      <ReplyDock
        key={data.key}
        ticket={data}
        aiLed={aiLed}
        handleRef={composerRef}
        openRef={dockRef}
      />
    </div>
  );
}
