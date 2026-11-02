'use client';

import {
  Avatar,
  cn,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
} from '@watchtower/ui';
import { FileSearch, type LucideIcon, SlidersHorizontal, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';

import { EvidencePanel } from '@/components/ai/evidence-panel';
import { useI18n } from '@/i18n/provider';
import { isDetail, isStaffTicket, type TicketItem } from '@/lib/tickets/model';
import { useTicket } from '@/lib/tickets/queries';

import { ChannelIcon } from './channel-icon';
import { InvestigatePanel } from './investigate-panel';
import { Row, TicketDetails } from './ticket-details';

export type PanelTab = 'evidence' | 'details' | 'customer';

/** The tab the panel opens on, always `[ASSUMED]` Details: it is the one that always has content. */
export const DEFAULT_PANEL_TAB: PanelTab = 'details';

/**
 * A tab of the panel: an icon that names itself in a tooltip and in `aria-label`; the selected tab
 * also shows its word, so the row stays small and still says where you are.
 */
function PanelTabTrigger({
  value,
  icon: Icon,
  label,
}: {
  value: PanelTab;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <Tooltip content={label}>
      <TabsTrigger
        value={value}
        data-panel-tab={value}
        aria-label={label}
        // The tooltip trigger takes over `data-state`, so the selected look follows `aria-selected`.
        className="group aria-selected:bg-primary-subtle aria-selected:text-foreground"
      >
        <Icon aria-hidden className="size-4 shrink-0" />
        <span aria-hidden className="truncate">
          {label}
        </span>
      </TabsTrigger>
    </Tooltip>
  );
}

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
    </div>
  );
}

/**
 * The right-hand panel: tabs Evidence / Details / Customer for the open ticket. The Evidence tab
 * is only there for someone who may review AI drafts; the panel always opens on Details (stable, whatever the
 * AI does; `tab` null means "the default"). `collapsed` folds the panel to a rail with
 * the toggle button (1024px and wider).
 */
export function TicketPanel({
  ticketKey,
  tab,
  onTabChange,
  showAi,
  highlightId = null,
  actions,
  collapsed,
}: {
  ticketKey: string | null;
  /** The tab the person chose; null until they do. */
  tab: PanelTab | null;
  onTabChange: (tab: PanelTab) => void;
  showAi: boolean;
  /** The evidence card to outline (set when a chip or a citation pointed at it). */
  highlightId?: string | null;
  /** Buttons at the end of the tab row (close the drawer, collapse the panel). */
  actions?: ReactNode;
  collapsed: boolean;
}) {
  const { t } = useI18n();
  const ticket = useTicket(ticketKey);
  // The panel opens on Details whatever the AI is doing, so it never changes under the person.
  // Evidence is one click away, and a chip or a citation opens it on purpose.
  const chosen = tab ?? DEFAULT_PANEL_TAB;
  const active: PanelTab = chosen === 'evidence' && !showAi ? 'details' : chosen;

  return (
    <Tabs
      value={active}
      onValueChange={(value) => {
        if (value === 'details' || value === 'customer' || (value === 'evidence' && showAi)) {
          onTabChange(value);
        }
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div
        className={cn(
          'flex h-[48px] shrink-0 items-center gap-1 border-b border-border/60 px-2',
          collapsed && 'lg:h-auto lg:flex-col lg:border-b-0 lg:px-1 lg:py-2',
        )}
      >
        <TabsList
          aria-label={t('panel.label')}
          className={cn('min-w-0 flex-1', collapsed && 'lg:hidden')}
          // A press on the tab already showing is a choice too; the Tabs change event skips it.
          onClickCapture={(event) => {
            const value = (event.target as HTMLElement)
              .closest('[data-panel-tab]')
              ?.getAttribute('data-panel-tab');
            if (value === 'details' || value === 'customer' || (value === 'evidence' && showAi)) {
              onTabChange(value);
            }
          }}
        >
          {showAi ? (
            <PanelTabTrigger value="evidence" icon={FileSearch} label={t('panel.evidence')} />
          ) : null}
          <PanelTabTrigger value="details" icon={SlidersHorizontal} label={t('panel.details')} />
          <PanelTabTrigger value="customer" icon={UserRound} label={t('panel.customer')} />
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
            <>
              <TicketDetails ticket={ticket.data} />
              {isStaffTicket(ticket.data) ? (
                <InvestigatePanel key={ticketKey} ticketKey={ticketKey} />
              ) : null}
            </>
          )}
        </TabsContent>
        {showAi ? (
          <TabsContent value="evidence">
            <EvidencePanel ticketKey={ticketKey} highlightId={highlightId} />
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
