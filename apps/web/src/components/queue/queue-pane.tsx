'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { BulkAction, BulkResult } from '@watchtower/shared';
import {
  Alert,
  Button,
  EmptyState,
  IconButton,
  SectionHeading,
  Skeleton,
  type ChipIcon,
  type TintId,
} from '@watchtower/ui';
import {
  ArrowUp,
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  CircleCheck,
  Coffee,
  Hand,
  Hourglass,
  SearchX,
} from 'lucide-react';
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
import { ApiRequestError } from '@/lib/api/errors';
import { filtersToView } from '@/lib/tickets/filters';
import { toRowModel } from '@/lib/tickets/model';
import {
  ticketKeys,
  useBulkAction,
  useQueues,
  useTicketList,
  useViewMutations,
  useViews,
} from '@/lib/tickets/queries';
import { builtInCounts, viewOptions } from '@/lib/tickets/views';

import { BulkBar } from './bulk-bar';
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

/** The error codes of a bulk item that have words of their own; anything else says "could not be made". */
const BULK_REASONS = [
  'ticket_not_open',
  'invalid_transition',
  'merge_not_allowed',
  'not_found',
  'forbidden',
  'conflict',
  'validation_failed',
] as const;

/** What a bulk request did: the headline, then one line per ticket that could not be changed. */
function Outcome({ lines }: { lines: readonly string[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {lines.map((line, index) => (
        <li key={line} className={index === 0 ? 'font-medium' : 'text-muted-foreground'}>
          {line}
        </li>
      ))}
    </ul>
  );
}

const GROUP_ICON = { open: ChevronDown, closed: ChevronRight } as const;

/** Each section has its own hue and icon (docs/design/friendly-polish.md section 3). */
const GROUP_LOOK: Record<RowGroup['id'], { tone: TintId; icon: ChipIcon }> = {
  needsYou: { tone: 'amber', icon: Hand },
  aiWorking: { tone: 'teal', icon: Bot },
  waiting: { tone: 'slate', icon: Hourglass },
  done: { tone: 'green', icon: CircleCheck },
  all: { tone: 'slate', icon: Hourglass },
};

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
  selectable,
  checkedKeys,
  onToggleChecked,
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
  selectable: boolean;
  checkedKeys: ReadonlySet<string>;
  onToggleChecked: (key: string) => void;
}) {
  const t = useT();
  const listId = active ? QUEUE_LISTBOX_ID : `queue-section-${group.id}`;
  const Chevron = GROUP_ICON[open ? 'open' : 'closed'];
  const flat = group.id === 'all';
  const title = group.id === 'all' ? t('queue.listLabel') : t(`queue.groups.${group.id}`);
  return (
    <section data-group={group.id} className="flex flex-col">
      {flat ? null : (
        <h3 className="m-0 bg-background text-xs font-medium">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            onClick={onToggle}
            className="flex min-h-9 w-full items-center gap-1.5 px-4 text-left text-muted-foreground transition-colors duration-(--wt-motion-duration-fast) ease-out hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            <Chevron aria-hidden className="size-3.5 shrink-0" />
            <SectionHeading
              tone={GROUP_LOOK[group.id].tone}
              icon={GROUP_LOOK[group.id].icon}
              count={group.rows.length}
              className="text-foreground"
            >
              {title}
            </SectionHeading>
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
              group={group.id}
              onSelect={onSelect}
              selectable={selectable}
              checked={checkedKeys.has(row.key)}
              selecting={checkedKeys.size > 0}
              onToggleChecked={onToggleChecked}
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
  const { session, isClient, can } = useSession();
  const userId = session?.user.id ?? 'anonymous';
  const canHandle = !isClient && can('ticket.handle');
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
  const list = useTicketList(filters);
  // Views live on the server (T-119a): the built-in ones come with counts, then the team's, then mine.
  const views = useViews(!isClient);
  const viewMutations = useViewMutations();
  const savedViews = useMemo(() => viewOptions(views.data?.items ?? []), [views.data]);
  const counts = useMemo(() => builtInCounts(views.data?.items ?? []), [views.data]);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Bulk selection (T-119d): tickets ticked in the list, by key. Not the open ticket.
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [outcome, setOutcome] = useState<string[] | null>(null);
  const bulk = useBulkAction();
  const queues = useQueues(canHandle);

  const now = useNow();
  const rows = useMemo(
    () =>
      (list.data?.pages ?? []).flatMap((page) => page.items.map((item) => toRowModel(item, now))),
    [list.data, now],
  );

  // Only tickets still in the list count: a filter that hides a ticket drops it from the selection.
  const checkedRows = useMemo(() => rows.filter((row) => checked.has(row.key)), [rows, checked]);
  const checkedKeys = useMemo<ReadonlySet<string>>(
    () => new Set(checkedRows.map((row) => row.key)),
    [checkedRows],
  );
  const toggleChecked = useCallback((key: string) => {
    setOutcome(null);
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const assignees = useMemo(() => {
    const byId = new Map<string, string>();
    for (const queue of queues.data?.queues ?? []) {
      for (const member of queue.members) byId.set(member.userId, member.name);
    }
    if (session) byId.set(session.user.id, session.user.name);
    return [...byId].map(([id, name]) => ({ id, name }));
  }, [queues.data, session]);

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
      case 'Escape':
        // Leaves the selection first; with nothing selected Esc keeps its other meanings.
        if (checkedKeys.size > 0) {
          event.preventDefault();
          event.stopPropagation();
          setChecked(new Set());
        }
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

  // X ticks or unticks the open ticket for a bulk action (docs/06-UI-SPEC.md section 4.2).
  useShortcut(
    'x',
    () => {
      if (selectedKey !== null) toggleChecked(selectedKey);
    },
    canHandle && selectedKey !== null,
  );

  const saveView = (name: string, shared: boolean) => {
    setSaveError(null);
    const { filters: kept, sort } = filtersToView(filters);
    viewMutations.create.mutate(
      { name, filters: kept, sort, shared },
      {
        onError: (error) => {
          const status = error instanceof ApiRequestError ? error.status : 0;
          setSaveError(
            status === 409
              ? t('queue.views.nameTaken')
              : status === 403
                ? t('queue.views.shareDenied')
                : t('queue.views.saveFailed'),
          );
        },
      },
    );
  };

  const describe = (result: BulkResult): string[] => {
    const lines: string[] = [];
    if (result.failed === 0) {
      lines.push(
        result.succeeded === 1 ? t('bulk.oneDone') : t('bulk.allDone', { count: result.succeeded }),
      );
    } else if (result.succeeded === 0) {
      lines.push(t('bulk.nothingChanged'));
    } else {
      lines.push(t('bulk.partial', { ok: result.succeeded, failed: result.failed }));
    }
    for (const item of result.items) {
      if (item.ok || !item.error) continue;
      const code = BULK_REASONS.find((value) => value === item.error?.code);
      const reason = t(`bulk.reasons.${code ?? 'other'}`);
      lines.push(
        item.key === null
          ? t('bulk.failedUnknownKey', { reason })
          : t('bulk.failedItem', { key: item.key, reason }),
      );
    }
    return lines;
  };

  const applyBulk = (action: BulkAction) => {
    const ticketIds = checkedRows.map((row) => row.id);
    if (ticketIds.length === 0) return;
    setOutcome(null);
    bulk.mutate(
      { ticketIds, action },
      {
        onSuccess: (result) => {
          setOutcome(describe(result));
          // What worked leaves the selection; what did not stays, so it can be tried again.
          const failedIds = new Set(
            result.items.filter((item) => !item.ok).map((item) => item.ticketId),
          );
          setChecked(
            new Set(checkedRows.filter((row) => failedIds.has(row.id)).map((row) => row.key)),
          );
        },
        onError: () => {
          setOutcome([t('bulk.requestFailed')]);
        },
      },
    );
  };

  const filtered = activeFilterCount(filters) > 0;
  const initialLoading = list.isPending;

  return (
    <>
      {canHandle && checkedRows.length > 0 ? (
        <BulkBar
          count={checkedRows.length}
          busy={bulk.isPending}
          assignees={assignees}
          me={session ? { id: session.user.id, name: session.user.name } : null}
          onApply={applyBulk}
          onClear={() => {
            setChecked(new Set());
          }}
          outcome={outcome ? <Outcome lines={outcome} /> : null}
        />
      ) : (
        <FilterBar
          filters={filters}
          onChange={setFilters}
          savedViews={savedViews}
          builtInCounts={counts}
          onSaveView={saveView}
          onDeleteView={(id) => {
            viewMutations.remove.mutate(id);
          }}
          canShare={can('view.share')}
          saveError={saveError}
          isClient={isClient}
          searchRef={searchRef}
          headerEnd={headerEnd}
          count={
            rows.length > 0
              ? t(list.hasNextPage ? 'queue.countMore' : 'queue.count', { count: rows.length })
              : null
          }
        />
      )}
      {/* What a bulk change did stays visible after the selection is gone. */}
      {outcome && checkedRows.length === 0 ? (
        <div role="status" className="border-b border-border/60 px-3 py-2 text-sm">
          <Outcome lines={outcome} />
        </div>
      ) : null}

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
            className="tabular inline-flex h-8 animate-pop-in items-center gap-1.5 rounded-full bg-primary px-3.5 text-xs font-medium text-primary-foreground shadow-overlay transition-opacity duration-(--wt-motion-duration-fast) ease-out hover:opacity-90"
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
              <div key={index} className="mx-2 flex flex-col gap-2 rounded-xl px-2.5 py-3">
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
              tone="sky"
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
            <EmptyState icon={<Coffee />} tone="teal" title={t('panes.queue.emptyTitle')} />
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
                selectable={canHandle}
                checkedKeys={checkedKeys}
                onToggleChecked={toggleChecked}
              />
            ))}
            {list.hasNextPage ? (
              <div className="flex justify-center p-3">
                <IconButton
                  variant="secondary"
                  label={list.isFetchingNextPage ? t('queue.loadingMore') : t('queue.loadMore')}
                  icon={<ChevronsDown aria-hidden className="size-4" />}
                  disabled={list.isFetchingNextPage}
                  onClick={() => {
                    void list.fetchNextPage();
                  }}
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
