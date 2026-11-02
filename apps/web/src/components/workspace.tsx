'use client';

import { cn, IconButton, SEVERITY_IDS, SeverityBadge } from '@watchtower/ui';
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  X,
} from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { evidenceDomId } from '@/components/ai/evidence-panel';
import { ConversationPane } from '@/components/conversation/conversation-pane';
import { QueuePane } from '@/components/queue/queue-pane';
import { QUEUE_LISTBOX_ID } from '@/components/queue/queue-row';
import { STATUS_FIELD_ID } from '@/components/ticket/ticket-details';
import { type PanelTab, TicketPanel } from '@/components/ticket/ticket-panel';
import { useT } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { type PaneCommand, useShortcut, useShortcutSequence, usePaneKeys } from '@/lib/keyboard';
import { useSelectedTicket } from '@/lib/tickets/selection';
import { SIDE_BY_SIDE_QUERY, THREE_PANES_QUERY, useMediaQuery } from '@/lib/use-media-query';

type PaneId = 'queue' | 'conversation' | 'assistant';

const PANE_ORDER: readonly PaneId[] = ['queue', 'conversation', 'assistant'];
const PANE_DOM_ID: Record<PaneId, string> = {
  queue: 'pane-queue',
  conversation: 'pane-conversation',
  assistant: 'pane-assistant',
};
const PANE_TITLE_KEY = {
  queue: 'panes.queue.title',
  conversation: 'panes.conversation.title',
  assistant: 'panes.assistant.title',
} as const;

type Layout = 'narrow' | 'medium' | 'wide';

/** Which of the three layouts the window is in (docs/06-UI-SPEC.md section 3.2). */
function useLayout(): Layout {
  const sideBySide = useMediaQuery(SIDE_BY_SIDE_QUERY);
  const threePanes = useMediaQuery(THREE_PANES_QUERY);
  if (threePanes) return 'wide';
  return sideBySide ? 'medium' : 'narrow';
}

/**
 * One region of the workspace. There is no card around it: the panes sit on the canvas and are
 * separated by a hairline on their inner edge. The visible heading is part of the pane's own header
 * (view switcher, subject, tabs); the region is named by a hidden `h2`. From 1024px a pane can fold
 * to a rail that only holds `rail` (its toggle button).
 */
function Pane({
  id,
  title,
  className,
  children,
  footer,
  rail,
  scrolls = true,
  collapsed = false,
}: {
  id: string;
  title: string;
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** What stays visible when the pane is folded to a rail. */
  rail?: ReactNode;
  /** False when the content manages its own scrolling (a pinned composer, a sticky pill). */
  scrolls?: boolean;
  collapsed?: boolean;
}) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      // Focusable by script only (F6, Alt+1..3, g q); the focused pane shows the focus ring.
      tabIndex={-1}
      className={cn(
        // Soft Beacon: from 768px each pane is a floating card on the Canvas; on a phone it fills.
        'flex min-h-0 min-w-0 flex-col bg-surface outline-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:overflow-hidden md:rounded-card md:shadow-card',
        className,
      )}
    >
      <h2 id={headingId} className="sr-only">
        {title}
      </h2>
      {collapsed ? <div className="hidden justify-center py-2 lg:flex">{rail}</div> : null}
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col',
          scrolls && 'overflow-y-auto',
          collapsed && 'lg:hidden',
        )}
      >
        {children}
      </div>
      {footer ? <div className={cn(collapsed && 'lg:hidden')}>{footer}</div> : null}
    </section>
  );
}

function SeverityKey() {
  const t = useT();
  return (
    <details className="border-t border-border/60 px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">
        {t('severity.keyTitle')}
      </summary>
      <ul className="mt-2 flex flex-wrap gap-2">
        {SEVERITY_IDS.map((id) => (
          <li key={id}>
            <SeverityBadge severity={id} label={t(`severity.${id}`)} />
          </li>
        ))}
      </ul>
    </details>
  );
}

// Complete class names, so Tailwind finds them (no template strings). The queue and the details
// panel are either open or folded to a 48px rail. The open widths flex with the window, queue
// clamp(280px,26vw,360px) and panel clamp(272px,22vw,320px), so the conversation is never squeezed.
const THREE_COLUMNS = {
  'open-open': 'lg:grid-cols-[clamp(280px,26vw,360px)_minmax(0,1fr)_clamp(272px,22vw,320px)]',
  'closed-open': 'lg:grid-cols-[48px_minmax(0,1fr)_clamp(272px,22vw,320px)]',
  'open-closed': 'lg:grid-cols-[clamp(280px,26vw,360px)_minmax(0,1fr)_48px]',
  'closed-closed': 'lg:grid-cols-[48px_minmax(0,1fr)_48px]',
} as const;
const TWO_COLUMNS = {
  open: 'lg:grid-cols-[clamp(280px,26vw,360px)_minmax(0,1fr)]',
  closed: 'lg:grid-cols-[48px_minmax(0,1fr)]',
} as const;

/**
 * Queue | conversation | details panel (docs/06-UI-SPEC.md sections 3.2 and 14, amended by
 * docs/design/ui-refresh-2026-11.md):
 *  - 1024 px and wider: three columns next to the navigation rail; `[` and `]` fold the queue / the
 *    panel to a rail;
 *  - 768 to 1023 px: queue and conversation, with the panel as a right-hand drawer that a button
 *    (or `]`) opens (a plain region, not a modal, so the conversation stays readable);
 *  - narrower: one pane at a time, chosen with tabs (Queue / Conversation / Details), and a sticky
 *    the AI draft's Approve / Edit / Reject buttons stick to the bottom edge with 44 px targets.
 * F6 and Shift+F6 cycle the visible panes, Alt+1/2/3 jump to one, `g q` goes to the queue, `s`
 * opens the status field. The panel (Details, Customer, and AI for someone who may review AI
 * drafts) is for staff; a customer never gets it and sees the ticket's facts in the conversation.
 */
export function Workspace() {
  const t = useT();
  const { can, isClient } = useSession();
  const layout = useLayout();
  const [selectedKey, select] = useSelectedTicket();
  const showPanel = !isClient;
  const showAi = can('ai.draft.review');
  const canEdit = can('ticket.handle');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  const [assistantCollapsed, setAssistantCollapsed] = useState(false);
  const [tab, setTab] = useState<PaneId>(selectedKey ? 'conversation' : 'queue');
  // null: the panel picks (Evidence when the AI brought some, else Details) until the person chooses.
  const [panelTab, setPanelTab] = useState<PanelTab | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string; tick: number } | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Focus follows the drawer: into it when it opens, back to its button when it closes.
  useEffect(() => {
    if (drawerOpen) closeRef.current?.focus();
    else if (wasOpen.current) toggleRef.current?.focus();
    wasOpen.current = drawerOpen;
  }, [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      // A menu or list inside the drawer closes first; Escape only reaches us when none is open.
      if (document.querySelector('[role="menu"], [role="listbox"][data-state="open"]')) return;
      setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [drawerOpen]);

  // Moves keyboard focus once the state change that revealed the target has been rendered.
  useEffect(() => {
    if (!focusRequest) return;
    // A tab panel mounts one render after the tab that shows it, so look again a few times.
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      const target = document.getElementById(focusRequest.id);
      if (target) {
        target.focus();
      } else if (tries < 5) {
        tries += 1;
        timer = setTimeout(attempt, 0);
      }
    };
    attempt();
    return () => {
      clearTimeout(timer);
    };
  }, [focusRequest]);
  const requestFocus = useCallback((id: string) => {
    setFocusRequest((previous) => ({ id, tick: (previous?.tick ?? 0) + 1 }));
  }, []);

  const panes = PANE_ORDER.filter((pane) => pane !== 'assistant' || showPanel);

  /** Reveals a pane if it is folded away and moves focus to it. */
  const goToPane = (pane: PaneId) => {
    if (pane === 'assistant' && !showPanel) return;
    if (layout === 'narrow') setTab(pane);
    if (layout === 'wide') {
      if (pane === 'queue') setQueueCollapsed(false);
      if (pane === 'assistant') setAssistantCollapsed(false);
    }
    if (pane === 'assistant' && layout === 'medium') {
      // The drawer's own effect moves focus to its close button.
      setDrawerOpen(true);
      return;
    }
    requestFocus(pane === 'queue' ? QUEUE_LISTBOX_ID : PANE_DOM_ID[pane]);
  };

  // After revealing the queue the listbox may not exist yet (empty or loading): fall back to the pane.
  useEffect(() => {
    if (focusRequest?.id === QUEUE_LISTBOX_ID && !document.getElementById(QUEUE_LISTBOX_ID)) {
      document.getElementById(PANE_DOM_ID.queue)?.focus();
    }
  }, [focusRequest]);

  const visiblePanes = (): PaneId[] => {
    if (layout === 'wide') {
      return panes.filter(
        (pane) =>
          !(pane === 'queue' && queueCollapsed) && !(pane === 'assistant' && assistantCollapsed),
      );
    }
    if (layout === 'medium') return panes.filter((pane) => pane !== 'assistant' || drawerOpen);
    return panes;
  };

  const currentPane = (): PaneId | null => {
    const holder = document.activeElement?.closest('section[id^="pane-"]');
    const found = PANE_ORDER.find((pane) => PANE_DOM_ID[pane] === holder?.id);
    if (found) return found;
    return layout === 'narrow' ? tab : null;
  };

  const onPaneKey = (command: PaneCommand) => {
    if (command.type === 'jump') {
      const pane = PANE_ORDER[command.index];
      if (pane) goToPane(pane);
      return;
    }
    const order = visiblePanes();
    if (order.length === 0) return;
    const current = currentPane();
    const index = current ? order.indexOf(current) : -1;
    const next =
      index === -1
        ? command.delta === 1
          ? 0
          : order.length - 1
        : (index + command.delta + order.length) % order.length;
    const target = order[next];
    if (target) goToPane(target);
  };
  usePaneKeys(onPaneKey);

  const toggleQueue = () => {
    if (layout !== 'wide') return;
    const next = !queueCollapsed;
    setQueueCollapsed(next);
    requestFocus(next ? 'pane-queue-toggle' : QUEUE_LISTBOX_ID);
  };
  const toggleAssistant = () => {
    if (layout === 'medium' && showPanel) {
      setDrawerOpen((open) => !open);
      return;
    }
    if (layout !== 'wide' || !showPanel) return;
    const next = !assistantCollapsed;
    setAssistantCollapsed(next);
    requestFocus(next ? 'pane-assistant-toggle' : PANE_DOM_ID.assistant);
  };
  useShortcut('[', toggleQueue);
  useShortcut(']', toggleAssistant, showPanel);
  useShortcutSequence('g', {
    q: () => {
      goToPane('queue');
    },
  });
  // S: show the Details tab, reveal the panel if it is folded, and move focus to the status field.
  useShortcut(
    's',
    () => {
      setPanelTab('details');
      if (layout === 'narrow') setTab('assistant');
      if (layout === 'wide') setAssistantCollapsed(false);
      if (layout === 'medium') setDrawerOpen(true);
      requestFocus(STATUS_FIELD_ID);
    },
    showPanel && canEdit && selectedKey !== null,
  );

  // An evidence chip or a citation: open the panel on the Evidence tab and move to that card.
  const openEvidence = (id: string) => {
    setPanelTab('evidence');
    setHighlightId(id);
    if (layout === 'narrow') setTab('assistant');
    if (layout === 'wide') setAssistantCollapsed(false);
    if (layout === 'medium') setDrawerOpen(true);
    requestFocus(evidenceDomId(id));
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const edge = event.key === 'Home' ? 0 : event.key === 'End' ? panes.length - 1 : null;
    if (delta === 0 && edge === null) return;
    event.preventDefault();
    const index = panes.indexOf(tab);
    const next = edge ?? (index + delta + panes.length) % panes.length;
    const target = panes[next];
    if (!target) return;
    setTab(target);
    requestFocus(`tab-${target}`);
  };

  const columns = showPanel
    ? THREE_COLUMNS[
        `${queueCollapsed ? 'closed' : 'open'}-${assistantCollapsed ? 'closed' : 'open'}`
      ]
    : TWO_COLUMNS[queueCollapsed ? 'closed' : 'open'];
  // Below 768 px only the chosen tab's pane is shown.
  const onlyOnTab = (pane: PaneId) => (tab === pane ? undefined : 'max-md:hidden');

  const queueToggle = (
    <IconButton
      id="pane-queue-toggle"
      label={t(queueCollapsed ? 'workspace.expandQueue' : 'workspace.collapseQueue')}
      shortcut={['[']}
      aria-expanded={!queueCollapsed}
      aria-controls="queue-pane-body"
      className="hidden lg:inline-flex"
      icon={
        queueCollapsed ? (
          <PanelLeftOpen aria-hidden className="size-4" />
        ) : (
          <PanelLeftClose aria-hidden className="size-4" />
        )
      }
      onClick={() => {
        setQueueCollapsed((collapsed) => !collapsed);
      }}
    />
  );

  return (
    <>
      <div
        role="tablist"
        aria-label={t('workspace.tabsLabel')}
        onKeyDown={onTabKeyDown}
        className="flex shrink-0 gap-1 border-b border-border/60 bg-frame p-1.5 md:hidden"
      >
        {panes.map((pane) => (
          <button
            key={pane}
            id={`tab-${pane}`}
            type="button"
            role="tab"
            aria-selected={tab === pane}
            aria-controls={PANE_DOM_ID[pane]}
            tabIndex={tab === pane ? 0 : -1}
            onClick={() => {
              setTab(pane);
            }}
            className={cn(
              'min-h-[44px] flex-1 rounded-full px-2 text-sm transition-colors duration-(--wt-motion-duration-fast) ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
              tab === pane
                ? 'bg-primary-subtle font-medium text-foreground'
                : 'text-muted-foreground',
            )}
          >
            {t(PANE_TITLE_KEY[pane])}
          </button>
        ))}
      </div>
      <main
        className={cn(
          'relative grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] bg-background md:grid-cols-[clamp(260px,34vw,340px)_minmax(0,1fr)] md:gap-3 md:p-3 lg:gap-4 lg:p-4',
          columns,
        )}
      >
        <Pane
          id="pane-queue"
          title={t('panes.queue.title')}
          footer={<SeverityKey />}
          scrolls={false}
          collapsed={queueCollapsed}
          rail={queueToggle}
          className={onlyOnTab('queue')}
        >
          <div id="queue-pane-body" className="flex min-h-0 flex-1 flex-col">
            <QueuePane
              selectedKey={selectedKey}
              onSelect={select}
              headerEnd={queueCollapsed ? null : queueToggle}
              onActivate={() => {
                // A tap on a row opens the ticket: on a phone that is the Conversation tab.
                if (layout === 'narrow') goToPane('conversation');
              }}
              onOpenConversation={() => {
                goToPane('conversation');
              }}
            />
          </div>
        </Pane>
        <Pane
          id="pane-conversation"
          title={t('panes.conversation.title')}
          scrolls={false}
          className={onlyOnTab('conversation')}
        >
          <ConversationPane
            ticketKey={selectedKey}
            onOpenEvidence={showPanel && showAi ? openEvidence : undefined}
            trailing={
              showPanel ? (
                <IconButton
                  ref={toggleRef}
                  variant="secondary"
                  label={t('workspace.openAssistant')}
                  aria-expanded={drawerOpen}
                  aria-controls="pane-assistant"
                  className="hidden md:max-lg:inline-flex"
                  icon={<PanelRight aria-hidden className="size-4" />}
                  onClick={() => {
                    setDrawerOpen((open) => !open);
                  }}
                />
              ) : null
            }
          />
        </Pane>
        {showPanel ? (
          <section
            id="pane-assistant"
            aria-labelledby="pane-assistant-heading"
            tabIndex={-1}
            className={cn(
              'flex min-h-0 min-w-0 flex-col bg-surface outline-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring lg:overflow-hidden lg:rounded-card lg:shadow-card',
              drawerOpen
                ? 'animate-slide-in-right md:max-lg:fixed md:max-lg:inset-y-0 md:max-lg:right-0 md:max-lg:z-30 md:max-lg:w-[min(24rem,90vw)] md:max-lg:border-l md:max-lg:border-border md:max-lg:bg-surface md:max-lg:shadow-overlay'
                : 'md:max-lg:hidden',
              onlyOnTab('assistant'),
            )}
          >
            <h2 id="pane-assistant-heading" className="sr-only">
              {t('panes.assistant.title')}
            </h2>
            <TicketPanel
              ticketKey={selectedKey}
              tab={panelTab}
              onTabChange={setPanelTab}
              showAi={showAi}
              highlightId={highlightId}
              collapsed={assistantCollapsed}
              actions={
                <>
                  <IconButton
                    ref={closeRef}
                    label={t('workspace.closeAssistant')}
                    // Focus lands here when the drawer opens: a tooltip would take the first Escape.
                    noTooltip
                    className="hidden md:max-lg:inline-flex"
                    icon={<X aria-hidden className="size-4" />}
                    onClick={() => {
                      setDrawerOpen(false);
                    }}
                  />
                  <IconButton
                    id="pane-assistant-toggle"
                    label={t(
                      assistantCollapsed
                        ? 'workspace.expandAssistant'
                        : 'workspace.collapseAssistant',
                    )}
                    shortcut={[']']}
                    aria-expanded={!assistantCollapsed}
                    className="hidden lg:inline-flex"
                    icon={
                      assistantCollapsed ? (
                        <PanelRightOpen aria-hidden className="size-4" />
                      ) : (
                        <PanelRightClose aria-hidden className="size-4" />
                      )
                    }
                    onClick={() => {
                      setAssistantCollapsed((collapsed) => !collapsed);
                    }}
                  />
                </>
              }
            />
          </section>
        ) : null}
      </main>
    </>
  );
}
