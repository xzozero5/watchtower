'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, EmptyState, Skeleton } from '@watchtower/ui';
import { ArrowUp, Inbox, SearchX } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { useT } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { useShortcut, stepIndex } from '@/lib/keyboard';
import { useNow } from '@/lib/use-now';
import { useRealtime } from '@/lib/realtime/realtime-provider';
import {
  activeFilterCount,
  DEFAULT_FILTERS,
  filtersEqual,
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
import { QueueRow, rowDomId } from './queue-row';

export interface QueuePaneProps {
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

let viewCounter = 0;
const makeViewId = () => `v${String(Date.now())}-${String((viewCounter += 1))}`;

/**
 * The queue: filters and saved views, the ticket list with J/K navigation, and the "N new" pill.
 * New tickets from the realtime feed are only counted; the list changes when the user asks
 * (pill, or the `U` key), never under the cursor.
 */
export function QueuePane({ selectedKey, onSelect }: QueuePaneProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const { session, isClient } = useSession();
  const userId = session?.user.id ?? 'anonymous';
  const realtime = useRealtime();
  const searchRef = useRef<HTMLInputElement>(null);

  const [filters, setFilters] = useState<QueueFilters>(DEFAULT_FILTERS);
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

  const focusRow = useCallback((key: string) => {
    document.getElementById(rowDomId(key))?.focus();
  }, []);

  const move = useCallback(
    (delta: number) => {
      const current = rows.findIndex((row) => row.key === selectedKey);
      const next = stepIndex(current, delta, rows.length);
      const target = rows[next];
      if (!target) return;
      onSelect(target.key);
      focusRow(target.key);
      // Reaching the end of what is loaded fetches the next page, so J never hits a wall.
      if (next >= rows.length - 3 && list.hasNextPage && !list.isFetchingNextPage) {
        void list.fetchNextPage();
      }
    },
    [rows, selectedKey, onSelect, focusRow, list],
  );

  const newCount = realtime.newTicketIds.length;
  const { clearNewTickets } = realtime;
  const showNew = useCallback(() => {
    clearNewTickets();
    void queryClient.invalidateQueries({ queryKey: ticketKeys.lists }).then(() => {
      const list = document.getElementById('queue-list');
      if (list) list.scrollTop = 0;
    });
  }, [clearNewTickets, queryClient]);

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
      />

      {/* Announced politely when the count changes; the button itself is the action. */}
      <div role="status" aria-live="polite" className="sticky top-0 z-10">
        {newCount > 0 ? (
          <button
            type="button"
            onClick={showNew}
            aria-keyshortcuts="."
            className="flex w-full items-center justify-center gap-2 border-b border-border-strong bg-primary px-pane py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            <ArrowUp aria-hidden className="size-4" />
            {t('queue.newPill', { count: newCount })}
          </button>
        ) : null}
      </div>

      <div
        id="queue-list"
        aria-busy={initialLoading || list.isFetching}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {initialLoading ? (
          <div role="status" className="flex flex-col gap-2 p-pane">
            <span className="sr-only">{t('queue.loading')}</span>
            {[0, 1, 2, 3, 4].map((index) => (
              <Skeleton key={index} className="h-14" />
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
              icon={<SearchX className="size-8" />}
              title={t('queue.emptyFilteredTitle')}
              description={t('queue.emptyFilteredBody')}
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
            <EmptyState
              icon={<Inbox className="size-8" />}
              title={t('panes.queue.emptyTitle')}
              description={t('panes.queue.emptyBody')}
            />
          )
        ) : (
          <>
            <ul aria-label={t('queue.listLabel')} className="flex flex-col">
              {rows.map((row) => (
                <QueueRow
                  key={row.id}
                  row={row}
                  selected={row.key === selectedKey}
                  now={now}
                  onSelect={onSelect}
                />
              ))}
            </ul>
            {list.hasNextPage ? (
              <div className="p-pane">
                <Button
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
