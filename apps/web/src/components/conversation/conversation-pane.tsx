'use client';

import { Alert, Button, EmptyState, SeverityBadge, Skeleton } from '@watchtower/ui';
import { MessageSquareText } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';

import { SlaBadge } from '@/components/ticket/sla-badge';
import { StatusLabel } from '@/components/ticket/status-label';
import { TicketDetails } from '@/components/ticket/ticket-details';
import { useI18n } from '@/i18n/provider';
import { isApiError } from '@/lib/api/errors';
import { severityOf } from '@/lib/tickets/model';
import { slaView } from '@/lib/tickets/sla';
import { useTicket, useTimeline } from '@/lib/tickets/queries';
import { useNow } from '@/lib/use-now';

import { Composer } from './composer';
import { Timeline } from './timeline';

/** The open ticket: header, details, the message timeline and the composer. */
export function ConversationPane({ ticketKey }: { ticketKey: string | null }) {
  const { t } = useI18n();
  const ticket = useTicket(ticketKey);
  const timeline = useTimeline(ticketKey);
  const now = useNow();
  const scrollRef = useRef<HTMLDivElement>(null);

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
      <EmptyState
        className="flex-1"
        icon={<MessageSquareText className="size-8" />}
        title={t('panes.conversation.emptyTitle')}
        description={t('panes.conversation.emptyBody')}
      />
    );
  }

  if (ticket.isPending) {
    return (
      <div role="status" className="flex flex-col gap-3 p-pane">
        <span className="sr-only">{t('conversation.loading')}</span>
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }

  if (ticket.isError) {
    const notFound = isApiError(ticket.error) && ticket.error.status === 404;
    return (
      <div className="p-pane">
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
    );
  }

  const data = ticket.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-ticket-key={data.key}>
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <header className="flex flex-col gap-2 border-b border-border px-pane py-3">
          <p className="font-mono text-xs text-muted-foreground">{data.key}</p>
          <h3 className="text-lg font-semibold break-words">{data.subject}</h3>
          <div className="flex flex-wrap items-center gap-3">
            <SeverityBadge
              severity={severityOf(data.priority)}
              label={t(`severity.${severityOf(data.priority)}`)}
            />
            <StatusLabel status={data.status} />
            <SlaBadge sla={slaView(data, now)} />
          </div>
        </header>

        <TicketDetails ticket={data} />

        <div aria-busy={timeline.isFetching}>
          {timeline.isPending ? (
            <div role="status" className="flex flex-col gap-3 p-pane">
              <span className="sr-only">{t('conversation.loadingMessages')}</span>
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : timeline.isError ? (
            <div className="p-pane">
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
              title={t('conversation.noMessages.title')}
              description={t('conversation.noMessages.body')}
            />
          ) : (
            <Timeline entries={entries} />
          )}
        </div>
      </div>
      <Composer key={data.key} ticket={data} />
    </div>
  );
}
