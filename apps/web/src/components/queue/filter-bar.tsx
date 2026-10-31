'use client';

import {
  SETTABLE_STATUSES,
  TICKET_PRIORITIES,
  type TicketPriority,
  type TicketStatus,
} from '@watchtower/shared';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Select,
  Tooltip,
} from '@watchtower/ui';
import { Bookmark, ChevronDown, ListFilter, Search, Trash2 } from 'lucide-react';
import { type ReactNode, type Ref, useEffect, useId, useState } from 'react';

import { useT } from '@/i18n/provider';
import {
  activeFilterCount,
  ASSIGNEE_FILTERS,
  BUILT_IN_VIEWS,
  DEFAULT_FILTERS,
  filtersEqual,
  type QueueFilters,
  SORTS,
} from '@/lib/tickets/filters';
import { severityOf } from '@/lib/tickets/model';
import { MAX_VIEW_NAME, type SavedView } from '@/lib/tickets/saved-views';
import { statusKey } from '@/lib/tickets/status-key';

const SEARCH_DEBOUNCE_MS = 300;
const CUSTOM_VIEW = 'custom';

export interface FilterBarProps {
  filters: QueueFilters;
  onChange: (filters: QueueFilters) => void;
  savedViews: readonly SavedView[];
  onSaveView: (name: string) => void;
  onDeleteView: (id: string) => void;
  /** A client sees fewer filters: no assignee, no SLA, no sorting by due time. */
  isClient: boolean;
  searchRef?: Ref<HTMLInputElement>;
  /** How many tickets the list shows, set next to the view name. */
  count?: ReactNode;
  /** Extra control at the end of the header row (the button that folds the queue away). */
  headerEnd?: ReactNode;
}

function toggle<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item];
}

const CHECK = 'size-4 shrink-0 accent-primary';
const CHECK_LABEL = 'inline-flex min-h-7 items-center gap-1.5';

/**
 * The queue's header (docs/design/ui-refresh-2026-11.md section 3.2): the view switcher with the
 * ticket count and a filter toggle on a 48px row, the search box under it, and the filter panel
 * when it is open.
 */
export function FilterBar({
  filters,
  onChange,
  savedViews,
  onSaveView,
  onDeleteView,
  isClient,
  searchRef,
  count: ticketCount,
  headerEnd,
}: FilterBarProps) {
  const t = useT();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters.q);
  const [viewName, setViewName] = useState('');

  // The search box commits after a pause, or at once on Enter.
  useEffect(() => {
    if (draft === filters.q) return;
    const timer = setTimeout(() => {
      onChange({ ...filters, q: draft });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [draft, filters, onChange]);

  // Reflect a change made elsewhere (a view picked, filters reset) in the search box.
  const [seenQ, setSeenQ] = useState(filters.q);
  if (seenQ !== filters.q) {
    setSeenQ(filters.q);
    setDraft(filters.q);
  }

  const builtIns = BUILT_IN_VIEWS.filter(
    (view) => !isClient || view.id === 'open' || view.id === 'all',
  );
  const currentSaved = savedViews.find((view) => filtersEqual(view.filters, filters));
  const currentBuiltIn = builtIns.find((view) => filtersEqual(view.filters, filters));
  const selectedView = currentBuiltIn
    ? `b:${currentBuiltIn.id}`
    : currentSaved
      ? `s:${currentSaved.id}`
      : CUSTOM_VIEW;
  const viewTitle = currentBuiltIn
    ? t(`queue.views.${currentBuiltIn.id}`)
    : currentSaved
      ? currentSaved.name
      : t('queue.views.custom');
  const count = activeFilterCount(filters);

  const pickView = (value: string) => {
    if (value.startsWith('b:')) {
      const view = builtIns.find((entry) => `b:${entry.id}` === value);
      if (view) onChange({ ...view.filters });
    } else if (value.startsWith('s:')) {
      const view = savedViews.find((entry) => `s:${entry.id}` === value);
      if (view) onChange({ ...view.filters });
    }
  };

  const statuses: readonly TicketStatus[] = SETTABLE_STATUSES;
  const priorities: readonly TicketPriority[] = TICKET_PRIORITIES;

  return (
    <div className="border-b border-border">
      <div className="flex h-[48px] items-center gap-2 px-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`${t('queue.views.label')}: ${viewTitle}`}
              className="-ml-2 inline-flex h-control min-w-0 items-center gap-1 rounded-md px-2 text-base font-semibold transition-colors duration-(--wt-motion-duration-fast) ease-out hover:bg-surface-muted data-[state=open]:bg-surface-muted"
            >
              <span className="truncate">{viewTitle}</span>
              <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel>{t('queue.views.builtIn')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={selectedView} onValueChange={pickView}>
              {builtIns.map((view) => (
                <DropdownMenuRadioItem key={view.id} value={`b:${view.id}`}>
                  {t(`queue.views.${view.id}`)}
                </DropdownMenuRadioItem>
              ))}
              {savedViews.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{t('queue.views.saved')}</DropdownMenuLabel>
                  {savedViews.map((view) => (
                    <DropdownMenuRadioItem key={view.id} value={`s:${view.id}`}>
                      <span className="truncate">{view.name}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </>
              ) : null}
              {selectedView === CUSTOM_VIEW ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioItem value={CUSTOM_VIEW} disabled>
                    {t('queue.views.custom')}
                  </DropdownMenuRadioItem>
                </>
              ) : null}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {ticketCount ? (
          <span className="tabular shrink-0 text-xs text-muted-foreground">{ticketCount}</span>
        ) : null}
        <Tooltip content={t('queue.filters.title')}>
          <Button
            variant="ghost"
            className="ml-auto gap-1 px-2"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => {
              setOpen((value) => !value);
            }}
          >
            <ListFilter aria-hidden className="size-4" />
            <span className="sr-only">{t('queue.filters.title')}</span>
            {count > 0 ? (
              <span className="tabular rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
                <span className="sr-only">{t('queue.filters.activeCount', { count })}</span>
                <span aria-hidden>{count}</span>
              </span>
            ) : null}
          </Button>
        </Tooltip>
        {headerEnd}
      </div>

      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft !== filters.q) onChange({ ...filters, q: draft });
        }}
        className="relative px-3 pb-2"
      >
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-[60%] text-muted-foreground"
        />
        <Input
          ref={searchRef}
          id="queue-search"
          type="search"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          aria-label={t('queue.search.label')}
          aria-keyshortcuts="/"
          placeholder={t('queue.search.placeholder')}
          autoComplete="off"
          className="w-full border-transparent bg-surface-muted pl-8 hover:bg-surface-muted"
        />
      </form>

      <div
        id={panelId}
        hidden={!open}
        className="flex flex-col gap-3 border-t border-border px-3 text-sm"
      >
        {open ? (
          <>
            <fieldset className="mt-3 flex flex-wrap gap-x-3 gap-y-0.5">
              <legend className="mb-1 font-medium">{t('queue.filters.status')}</legend>
              {statuses.map((status) => (
                <label key={status} className={CHECK_LABEL}>
                  <input
                    type="checkbox"
                    checked={filters.status.includes(status)}
                    onChange={() => {
                      onChange({ ...filters, status: toggle(filters.status, status) });
                    }}
                    className={CHECK}
                  />
                  {t(statusKey(status))}
                </label>
              ))}
            </fieldset>

            <fieldset className="flex flex-wrap gap-x-3 gap-y-0.5">
              <legend className="mb-1 font-medium">{t('queue.filters.priority')}</legend>
              {priorities.map((priority) => (
                <label key={priority} className={CHECK_LABEL}>
                  <input
                    type="checkbox"
                    checked={filters.priority.includes(priority)}
                    onChange={() => {
                      onChange({ ...filters, priority: toggle(filters.priority, priority) });
                    }}
                    className={CHECK}
                  />
                  {priority}{' '}
                  <span className="text-muted-foreground">
                    {t(`severity.${severityOf(priority)}`)}
                  </span>
                </label>
              ))}
            </fieldset>

            {isClient ? null : (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <label className="inline-flex items-center gap-1.5">
                  {t('queue.filters.assignee')}
                  <Select
                    value={filters.assignee}
                    onChange={(event) => {
                      const next = ASSIGNEE_FILTERS.find((value) => value === event.target.value);
                      if (next) onChange({ ...filters, assignee: next });
                    }}
                  >
                    {ASSIGNEE_FILTERS.map((value) => (
                      <option key={value} value={value}>
                        {t(`queue.filters.assignees.${value}`)}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className={CHECK_LABEL}>
                  <input
                    type="checkbox"
                    checked={filters.overdue}
                    onChange={(event) => {
                      onChange({ ...filters, overdue: event.target.checked });
                    }}
                    className={CHECK}
                  />
                  {t('queue.filters.overdue')}
                </label>
              </div>
            )}

            <label className="inline-flex items-center gap-1.5">
              {t('queue.filters.sort')}
              <Select
                value={filters.sort}
                onChange={(event) => {
                  const next = SORTS.find((value) => value === event.target.value);
                  if (next) onChange({ ...filters, sort: next });
                }}
              >
                {SORTS.filter((value) => !(isClient && value === 'due_asc')).map((value) => (
                  <option key={value} value={value}>
                    {t(`queue.filters.sorts.${value}`)}
                  </option>
                ))}
              </Select>
            </label>

            <div className="flex flex-wrap items-center gap-2 border-t border-border py-3">
              <Button
                variant="ghost"
                onClick={() => {
                  onChange({ ...DEFAULT_FILTERS });
                }}
              >
                {t('queue.filters.clear')}
              </Button>
              <form
                className="flex min-w-0 flex-1 items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (viewName.trim() === '') return;
                  onSaveView(viewName);
                  setViewName('');
                }}
              >
                <Input
                  value={viewName}
                  onChange={(event) => {
                    setViewName(event.target.value);
                  }}
                  maxLength={MAX_VIEW_NAME}
                  aria-label={t('queue.views.name')}
                  placeholder={t('queue.views.name')}
                  className="min-w-0 flex-1"
                />
                <Button type="submit" variant="secondary" disabled={viewName.trim() === ''}>
                  <Bookmark aria-hidden className="size-4" />
                  {t('queue.views.save')}
                </Button>
              </form>
              {currentSaved ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    onDeleteView(currentSaved.id);
                  }}
                >
                  <Trash2 aria-hidden className="size-4" />
                  {t('queue.views.delete', { name: currentSaved.name })}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
