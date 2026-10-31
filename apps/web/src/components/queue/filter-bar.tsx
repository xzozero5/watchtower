'use client';

import {
  SETTABLE_STATUSES,
  TICKET_PRIORITIES,
  type TicketPriority,
  type TicketStatus,
} from '@watchtower/shared';
import { Button, Input, Select } from '@watchtower/ui';
import { Bookmark, ListFilter, Search, Trash2 } from 'lucide-react';
import { type Ref, useEffect, useId, useState } from 'react';

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
}

function toggle<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item];
}

/** Search, view picker and the filter panel of the queue. */
export function FilterBar({
  filters,
  onChange,
  savedViews,
  onSaveView,
  onDeleteView,
  isClient,
  searchRef,
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
    <div className="flex flex-col gap-2 border-b border-border px-pane py-2">
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft !== filters.q) onChange({ ...filters, q: draft });
        }}
        className="relative"
      >
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
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
          className="w-full pl-8"
        />
      </form>

      <div className="flex items-center gap-2">
        <label htmlFor={`${panelId}-view`} className="sr-only">
          {t('queue.views.label')}
        </label>
        <Select
          id={`${panelId}-view`}
          value={selectedView}
          onChange={(event) => {
            pickView(event.target.value);
          }}
          className="min-w-0 flex-1"
        >
          <optgroup label={t('queue.views.builtIn')}>
            {builtIns.map((view) => (
              <option key={view.id} value={`b:${view.id}`}>
                {t(`queue.views.${view.id}`)}
              </option>
            ))}
          </optgroup>
          {savedViews.length > 0 ? (
            <optgroup label={t('queue.views.saved')}>
              {savedViews.map((view) => (
                <option key={view.id} value={`s:${view.id}`}>
                  {view.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {selectedView === CUSTOM_VIEW ? (
            <option value={CUSTOM_VIEW} disabled>
              {t('queue.views.custom')}
            </option>
          ) : null}
        </Select>
        <Button
          variant="secondary"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          <ListFilter aria-hidden className="size-4" />
          {t('queue.filters.title')}
          {count > 0 ? (
            <span className="rounded-full border border-border-strong px-1.5 text-xs">
              <span className="sr-only">{t('queue.filters.activeCount', { count })}</span>
              <span aria-hidden>{count}</span>
            </span>
          ) : null}
        </Button>
      </div>

      <div id={panelId} hidden={!open} className="flex flex-col gap-3 text-sm">
        {open ? (
          <>
            <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
              <legend className="mb-1 font-medium">{t('queue.filters.status')}</legend>
              {statuses.map((status) => (
                <label key={status} className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={filters.status.includes(status)}
                    onChange={() => {
                      onChange({ ...filters, status: toggle(filters.status, status) });
                    }}
                    className="size-7 accent-primary"
                  />
                  {t(`status.${status}`)}
                </label>
              ))}
            </fieldset>

            <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
              <legend className="mb-1 font-medium">{t('queue.filters.priority')}</legend>
              {priorities.map((priority) => (
                <label key={priority} className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={filters.priority.includes(priority)}
                    onChange={() => {
                      onChange({ ...filters, priority: toggle(filters.priority, priority) });
                    }}
                    className="size-7 accent-primary"
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
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={filters.overdue}
                    onChange={(event) => {
                      onChange({ ...filters, overdue: event.target.checked });
                    }}
                    className="size-7 accent-primary"
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

            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
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
