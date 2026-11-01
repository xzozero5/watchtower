'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, EmptyState, Skeleton } from '@watchtower/ui';
import { ArrowUp, ChevronDown, ChevronRight, Inbox, SearchX } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useT } from '@/i18n/provider';
import {
  COLLAPSED_BY_DEFAULT,
  groupRows,
  navigableRows,
  type PinnedRow,
  type RowGroup,
  triageGroup,
} from '@/lib/ai/model';
import { useSession } from '@/lib/auth/session';
import { useShortcut, stepIndex } from '@/lib/keyboard';
import { usePreferences } from '@/lib/preferences';
import { useNow } from '@/lib/use-now';
import { useThrottledValue } from '@/lib/use-throttled-value';
import { useRealtime } from '@/lib/realtime/realtime-provider';
import {
  activeFilterCount,
  DEFAULT_FILTERS,
  filtersEqual,
  filtersFromSearch,
  type QueueFilters,
} from '@/lib/tickets/filters';
import { toRowModel } from '@/lib/tickets/model';
import { ticketKeys, useTicketList } from '@/lib/tickets/queries';
import {
  browserStorage,
  loadSavedViews,
  persistSavedViews,
  removeView,
  type SavedView,
  upsertView,
} from '@/lib/tickets/saved-views';

import { FilterBar } from './filter-bar';
import { QUEUE_LISTBOX_ID, QueueRow, rowDomId } from './queue-row';

export interface QueuePaneProps {
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** A click on a row (a tap on a phone, where the conversation is another tab). */
  onActivate?: () => void;
  /** Enter or O on the open ticket: move keyboard focus into the conversation. */
  onOpenConversation?: () => void;
  /** Extra control at the end of the queue header (the button that folds the queue away). */
  headerEnd?: ReactNode;
}

/** The "N new" pill is announced to screen readers at most this often (docs/06-UI-SPEC.md 4.3). */
export const PILL_ANNOUNCE_INTERVAL_MS = 30_000;

const isZero = (count: number) => count === 0;

let viewCounter = 0;
const makeViewId = () => `v${String(Date.now())}-${String((viewCounter += 1))}`;

const GROUP_ICON = { open: ChevronDown, closed: ChevronRight } as const;

/**
 * One section of the board: a header button (title, count; folds the section; reachable with Tab)
 * and, while open, the section's listbox. Only the section with the cursor is in the tab order,
 * carries `aria-activedescendant` and the shared listbox id, so the board behaves as one list.
 */
function Section({
  group,
  open,
  active,
  activeDescendant,
  selectedKey,
  compact,
  onToggle,
  onKeyDown,
  onSelect,
}: {
  group: RowGroup;
  open: boolean;
  active: boolean;
  activeDescendant: string | undefined;
  selectedKey: string | null;
  compact: boolean;
  onToggle: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLUListElement>) => void;
  onSelect: (key: string) => void;
}) {
  const t = useT();
  const listId = active ? QUEUE_LISTBOX_ID : `queue-section-${group.id}`;
  const Chevron = GROUP_ICON[open ? 'open' : 'closed'];
  const flat = group.id === 'all';
  const title = group.id === 'all' ? t('queue.listLabel') : t(`queue.groups.${group.id}`);
  return (
    <section data-group={group.id} className="flex flex-col">
      {flat ? null : (
        <h3 className="m-0 border-b border-border bg-background text-xs font-medium">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            onClick={onToggle}
            className="flex min-h-8 w-full items-center gap-1.5 px-3 text-left text-muted-foreground transition-colors duration-(--wt-motion-duration-fast) ease-out hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            <Chevron aria-hidden className="size-3.5 shrink-0" />
            <span>{title}</span>
            <span className="tabular rounded-full bg-surface-muted px-1.5 text-foreground">
              {group.rows.length}
            </span>
          </button>
        </h3>
      )}
      {open ? (
        <ul
          id={listId}
          role="listbox"
          tabIndex={active ? 0 : -1}
          aria-label={title}
          aria-activedescendant={active ? activeDescendant : undefined}
          onKeyDown={onKeyDown}
          className="flex flex-col outline-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          {group.rows.map((row) => (
            <QueueRow
              key={row.id}
              row={row}
              selected={row.key === selectedKey}
              compact={compact}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * The queue: filters and saved views, the ticket list with J/K navigation, and the "N new" pill.
 * New tickets from the realtime feed are only counted; the list changes when the user asks
 * (pill, or the `U` key), never under the cursor.
 */
export function QueuePane({
  selectedKey,
  onSelect,
  onActivate,
  onOpenConversation,
  headerEnd,
}: QueuePaneProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const { session, isClient } = useSession();
  const userId = session?.user.id ?? 'anonymous';
  const realtime = useRealtime();
  const { singleKeyShortcuts, density } = usePreferences();
  const compact = density === 'compact';
  const searchRef = useRef<HTMLInputElement>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(COLLAPSED_BY_DEFAULT);
  // Set when the keyboard moved the cursor: focus follows it once the right section is drawn.
  const refocus = useRef(false);

  // A link from Home may name filters in the address (`/?assignee=unassigned&status=new`).
  const [filters, setFilters] = useState<QueueFilters>(
    () => filtersFromSearch(window.location.search) ?? DEFAULT_FILTERS,
  );
  const [savedViews, setSavedViews] = useState<SavedView[]>(() =>
    loadSavedViews(browserStorage(), userId),
  );
  const list = useTicketList(filters);

  const now = useNow();
  const rows = useMemo(
    () =>
      (list.data?.pages ?? []).flatMap((page) => page.items.map((item) => toRowModel(item, now))),
    [list.data, now],
  );

  // The board: sections in order, and the rows J and K walk through, top to bottom as drawn.
  const [pinned, setPinned] = useState<PinnedRow | null>(null);
  const openRow = rows.find((row) => row.key === selectedKey);
  if ((openRow?.key ?? null) !== (pinned?.key ?? null)) {
    // A new ticket was opened: remember its section, so it stays there while it is open.
    setPinned(openRow ? { key: openRow.key, group: triageGroup(openRow) } : null);
  }
  const groups = useMemo<RowGroup[]>(
    () => (isClient ? (rows.length > 0 ? [{ id: 'all', rows }] : []) : groupRows(rows, pinned)),
    [isClient, rows, pinned],
  );
  const walkable = useMemo(
    () => navigableRows(groups, folded, selectedKey),
    [groups, folded, selectedKey],
  );
  const selectedIndex = walkable.findIndex((row) => row.key === selectedKey);
  const activeDescendant = selectedIndex >= 0 && selectedKey ? rowDomId(selectedKey) : undefined;
  // One section's listbox holds focus at a time: the one with the open ticket, else the first.
  const holder =
    selectedIndex >= 0
      ? groups.find((group) => group.rows.some((row) => row.key === selectedKey))
      : undefined;
  const activeGroup: RowGroup['id'] | undefined = (
    holder && !folded.has(holder.id) ? holder : groups.find((group) => !folded.has(group.id))
  )?.id;

  const focusList = useCallback(() => {
    document.getElementById(QUEUE_LISTBOX_ID)?.focus();
  }, []);

  // Keep the current row in view as it moves (J/K, arrows, a ticket opened from the address), and
  // carry keyboard focus into its section.
  useEffect(() => {
    if (activeDescendant)
      document.getElementById(activeDescendant)?.scrollIntoView({ block: 'nearest' });
    if (refocus.current) {
      refocus.current = false;
      focusList();
    }
  }, [activeDescendant, focusList]);

  const toggleGroup = (id: RowGroup['id']) => {
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const moveTo = useCallback(
    (next: number) => {
      const target = walkable[next];
      if (!target) return;
      refocus.current = true;
      onSelect(target.key);
      focusList();
      // Reaching the end of what is loaded fetches the next page, so J never hits a wall.
      if (next >= walkable.length - 3 && list.hasNextPage && !list.isFetchingNextPage) {
        void list.fetchNextPage();
      }
    },
    [walkable, onSelect, focusList, list],
  );

  const move = useCallback(
    (delta: number) => {
      moveTo(stepIndex(selectedIndex, delta, walkable.length));
    },
    [moveTo, selectedIndex, walkable.length],
  );

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        return;
      case 'Home':
        event.preventDefault();
        moveTo(0);
        return;
      case 'End':
        event.preventDefault();
        moveTo(walkable.length - 1);
        return;
      case 'Enter':
        // Only acts while the list has focus, so it is not a character-key shortcut (WCAG 2.1.4).
        if (selectedIndex >= 0) {
          event.preventDefault();
          onOpenConversation?.();
        }
        return;
    }
  };

  const newCount = realtime.newTicketIds.length;
  // Screen readers hear the count at most once per 30 s; the visible pill updates at once.
  const announcedCount = useThrottledValue(newCount, PILL_ANNOUNCE_INTERVAL_MS, isZero);
  const { clearNewTickets } = realtime;
  const showNew = useCallback(() => {
    clearNewTickets();
    void queryClient.invalidateQueries({ queryKey: ticketKeys(userId).lists }).then(() => {
      const list = document.getElementById('queue-list');
      if (list) list.scrollTop = 0;
    });
  }, [clearNewTickets, queryClient, userId]);

  useShortcut('j', () => {
    move(1);
  });
  useShortcut('k', () => {
    move(-1);
  });
  useShortcut('/', () => {
    searchRef.current?.focus();
  });
  useShortcut(
    'o',
    () => {
      onOpenConversation?.();
    },
    selectedKey !== null,
  );
  useShortcut(
    '.',
    () => {
      showNew();
    },
    newCount > 0,
  );

  const updateViews = (next: SavedView[]) => {
    setSavedViews(next);
    persistSavedViews(browserStorage(), userId, next);
  };

  const filtered = activeFilterCount(filters) > 0;
  const initialLoading = list.isPending;

  return (
    <>
      <FilterBar
        filters={filters}
        onChange={setFilters}
        savedViews={savedViews}
        onSaveView={(name) => {
          updateViews(upsertView(savedViews, name, filters, makeViewId));
        }}
        onDeleteView={(id) => {
          updateViews(removeView(savedViews, id));
        }}
        isClient={isClient}
        searchRef={searchRef}
        headerEnd={headerEnd}
        count={
          rows.length > 0
            ? t(list.hasNextPage ? 'queue.countMore' : 'queue.count', { count: rows.length })
            : null
        }
      />

      {/* The announcement is throttled (see above); the button is the action and is not live. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcedCount > 0 ? t('queue.newPill', { count: announcedCount }) : ''}
      </p>
      {newCount > 0 ? (
        <div className="sticky top-0 z-10 flex justify-center px-3 pt-2">
          <button
            type="button"
            onClick={showNew}
            aria-keyshortcuts={singleKeyShortcuts ? '.' : undefined}
            className="tabular inline-flex h-7 animate-pop-in items-center gap-1.5 rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground shadow-overlay transition-opacity duration-(--wt-motion-duration-fast) ease-out hover:opacity-90"
          >
            <ArrowUp aria-hidden className="size-3.5" />
            {t(singleKeyShortcuts ? 'queue.newPill' : 'queue.newPillClick', { count: newCount })}
          </button>
        </div>
      ) : null}

      <div
        id="queue-list"
        aria-busy={initialLoading || list.isFetching}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {initialLoading ? (
          <div role="status" className="flex flex-col">
            <span className="sr-only">{t('queue.loading')}</span>
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index} className="flex flex-col gap-2 border-b border-border px-3 py-3">
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="h-3 w-3/5" />
              </div>
            ))}
          </div>
        ) : list.isError ? (
          <div className="p-pane">
            <Alert tone="error" title={t('queue.error.title')}>
              <p>{t('queue.error.body')}</p>
              <Button
                className="mt-2"
                onClick={() => {
                  void list.refetch();
                }}
              >
                {t('errors.retry')}
              </Button>
            </Alert>
          </div>
        ) : rows.length === 0 ? (
          filtered && !filtersEqual(filters, DEFAULT_FILTERS) ? (
            <EmptyState
              icon={<SearchX />}
              title={t('queue.emptyFilteredTitle')}
              action={
                <Button
                  onClick={() => {
                    setFilters({ ...DEFAULT_FILTERS });
                  }}
                >
                  {t('queue.filters.clear')}
                </Button>
              }
            />
          ) : (
            <EmptyState icon={<Inbox />} title={t('panes.queue.emptyTitle')} />
          )
        ) : (
          <>
            {groups.map((group) => (
              <Section
                key={group.id}
                group={group}
                open={!folded.has(group.id)}
                active={group.id === activeGroup}
                activeDescendant={activeDescendant}
                selectedKey={selectedKey}
                compact={compact}
                onToggle={() => {
                  toggleGroup(group.id);
                }}
                onKeyDown={onListKeyDown}
                onSelect={(key) => {
                  onSelect(key);
                  onActivate?.();
                }}
              />
            ))}
            {list.hasNextPage ? (
              <div className="p-3">
                <Button
                  variant="ghost"
                  className="w-full"
                  disabled={list.isFetchingNextPage}
                  onClick={() => {
                    void list.fetchNextPage();
                  }}
                >
                  {list.isFetchingNextPage ? t('queue.loadingMore') : t('queue.loadMore')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
