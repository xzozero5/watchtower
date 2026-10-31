'use client';

import { Avatar, cn, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@watchtower/ui';
import { Bot } from 'lucide-react';
import type { ReactNode } from 'react';

import { AiSidebar } from '@/components/ai-sidebar';
import { useI18n } from '@/i18n/provider';
import { isDetail, isStaffTicket, type TicketItem } from '@/lib/tickets/model';
import { useTicket } from '@/lib/tickets/queries';

import { ChannelIcon } from './channel-icon';
import { Row, TicketDetails } from './ticket-details';

export type PanelTab = 'details' | 'ai' | 'customer';

function CustomerTab({ ticket }: { ticket: TicketItem }) {
  const { t } = useI18n();
  if (!isStaffTicket(ticket)) return null;
  const requester = ticket.requester;
  const email = isDetail(ticket) ? ticket.requester?.email : null;
  return (
    <div className="flex flex-col gap-3 py-3">
      {requester ? (
        <div className="flex items-center gap-3 px-4">
          <Avatar name={requester.name} id={requester.id} size={32} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{requester.name}</p>
            <p className="truncate text-xs text-muted-foreground">{ticket.org.name}</p>
          </div>
        </div>
      ) : (
        <p className="px-4 text-sm text-muted-foreground">{t('customer.noRequester')}</p>
      )}
      <dl className="flex flex-col border-t border-border pt-2">
        <Row label={t('customer.requester')}>{requester?.name ?? t('details.none')}</Row>
        <Row label={t('customer.email')}>
          {email ? <span className="break-all">{email}</span> : t('details.none')}
        </Row>
        <Row label={t('details.organization')}>{ticket.org.name}</Row>
        <Row label={t('details.channel')}>
          <span className="inline-flex items-center gap-1.5">
            <ChannelIcon channel={ticket.channel} />
            {t(`channel.${ticket.channel}`)}
          </span>
        </Row>
      </dl>
      <p className="px-4 text-xs text-muted-foreground">{t('customer.more')}</p>
    </div>
  );
}

/**
 * The right-hand panel: tabs Details / AI / Customer for the open ticket. The AI tab is only
 * there for someone who may review AI drafts. `collapsed` folds it to a rail with the toggle
 * button (1024px and wider).
 */
export function TicketPanel({
  ticketKey,
  tab,
  onTabChange,
  showAi,
  actions,
  collapsed,
}: {
  ticketKey: string | null;
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  showAi: boolean;
  /** Buttons at the end of the tab row (close the drawer, collapse the panel). */
  actions?: ReactNode;
  collapsed: boolean;
}) {
  const { t } = useI18n();
  const ticket = useTicket(ticketKey);
  const active: PanelTab = tab === 'ai' && !showAi ? 'details' : tab;

  return (
    <Tabs
      value={active}
      onValueChange={(value) => {
        if (value === 'details' || value === 'customer' || (value === 'ai' && showAi)) {
          onTabChange(value);
        }
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div
        className={cn(
          'flex h-[48px] shrink-0 items-center gap-1 border-b border-border px-2',
          collapsed && 'lg:h-auto lg:flex-col lg:border-b-0 lg:px-1 lg:py-2',
        )}
      >
        <TabsList
          aria-label={t('panel.label')}
          className={cn('min-w-0 flex-1', collapsed && 'lg:hidden')}
        >
          <TabsTrigger value="details">{t('panel.details')}</TabsTrigger>
          {showAi ? (
            <TabsTrigger value="ai" className="gap-1.5">
              <Bot aria-hidden className="size-3.5 text-ai-accent" />
              {t('panel.ai')}
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="customer">{t('panel.customer')}</TabsTrigger>
        </TabsList>
        {actions}
      </div>
      <div className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto', collapsed && 'lg:hidden')}>
        <TabsContent value="details">
          {ticketKey === null ? (
            <p className="p-4 text-sm text-muted-foreground">{t('panel.noTicket')}</p>
          ) : ticket.isPending ? (
            <div role="status" className="flex flex-col gap-3 p-4">
              <span className="sr-only">{t('conversation.loading')}</span>
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-5 w-2/3" />
            </div>
          ) : ticket.isError ? (
            <p className="p-4 text-sm text-muted-foreground">{t('conversation.error.title')}</p>
          ) : (
            <TicketDetails ticket={ticket.data} />
          )}
        </TabsContent>
        {showAi ? (
          <TabsContent value="ai">
            <AiSidebar />
          </TabsContent>
        ) : null}
        <TabsContent value="customer">
          {ticket.data ? (
            <CustomerTab ticket={ticket.data} />
          ) : (
            <p className="p-4 text-sm text-muted-foreground">{t('panel.noTicket')}</p>
          )}
        </TabsContent>
      </div>
    </Tabs>
  );
}
