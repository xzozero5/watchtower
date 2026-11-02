import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useMemo, useState } from 'react';

import { cn } from '../lib/cn.js';

export interface DataTableColumn<Row> {
  id: string;
  /** Translated column title. */
  header: string;
  cell: (row: Row) => ReactNode;
  /** Makes the header a sort button. Return what to compare; `null` sorts last. */
  sortValue?: (row: Row) => string | number | null;
  /** Classes for both the header and the cells of this column (width, alignment). */
  className?: string;
  /** Keep the title for screen readers only (a column of row actions). */
  hideHeader?: boolean;
}

export interface DataTableSort {
  columnId: string;
  direction: 'asc' | 'desc';
}

export interface DataTableProps<Row> {
  /** The page title or a name for the list. A table always has a caption. */
  caption: string;
  /** Show the caption to screen readers only (the page header already shows it). */
  captionHidden?: boolean;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  getRowId: (row: Row) => string;
  /** Name of a row for assistive technology when its first cell is not enough. */
  getRowLabel?: (row: Row) => string;
  /** Enter on a focused row (not on a control inside it). */
  onRowActivate?: (row: Row) => void;
  defaultSort?: DataTableSort;
  /** Also move the row focus with J and K (follow the "single-key shortcuts" preference). */
  vimKeys?: boolean;
  /** The row that is highlighted as the open one. */
  selectedId?: string | null;
  busy?: boolean;
  className?: string;
}

function compare(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * A plain table for admin lists: a visible caption, sortable headers (`aria-sort` on the `th`),
 * and one tab stop for the whole body. Arrow keys (and J/K when asked for) move between rows,
 * Home and End jump, Enter on a row activates it. Cells can hold their own buttons and fields;
 * keys pressed inside them never move the row focus. Colour is never the only signal: put icons
 * and words in the cells.
 */
export function DataTable<Row>({
  caption,
  captionHidden = false,
  columns,
  rows,
  getRowId,
  getRowLabel,
  onRowActivate,
  defaultSort,
  vimKeys = false,
  selectedId = null,
  busy = false,
  className,
}: DataTableProps<Row>) {
  const [sort, setSort] = useState<DataTableSort | undefined>(defaultSort);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const column = columns.find((candidate) => candidate.id === sort?.columnId);
    if (!column?.sortValue || !sort) return rows;
    const value = column.sortValue;
    const sign = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => sign * compare(value(a), value(b)));
  }, [rows, columns, sort]);

  const tabbableId =
    activeId !== null && sorted.some((row) => getRowId(row) === activeId)
      ? activeId
      : sorted[0]
        ? getRowId(sorted[0])
        : null;

  const toggleSort = (columnId: string) => {
    setSort((current) =>
      current?.columnId === columnId
        ? { columnId, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { columnId, direction: 'asc' },
    );
  };

  const focusRow = (row: Element | null) => {
    if (row instanceof HTMLElement) row.focus();
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: Row) => {
    // Keys pressed inside a button, field or menu in the row belong to that control.
    if (event.target !== event.currentTarget) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const current = event.currentTarget;
    const key = event.key;
    if (key === 'ArrowDown' || (vimKeys && key === 'j')) {
      event.preventDefault();
      focusRow(current.nextElementSibling);
    } else if (key === 'ArrowUp' || (vimKeys && key === 'k')) {
      event.preventDefault();
      focusRow(current.previousElementSibling);
    } else if (key === 'Home') {
      event.preventDefault();
      focusRow(current.parentElement?.firstElementChild ?? null);
    } else if (key === 'End') {
      event.preventDefault();
      focusRow(current.parentElement?.lastElementChild ?? null);
    } else if (key === 'Enter' && onRowActivate) {
      event.preventDefault();
      onRowActivate(row);
    }
  };

  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table
        aria-busy={busy || undefined}
        className="w-full border-separate border-spacing-0 text-sm"
      >
        <caption className={captionHidden ? 'sr-only' : 'py-2 text-left text-sm font-semibold'}>
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const sortable = column.sortValue !== undefined;
              const active = sort?.columnId === column.id;
              const ariaSort = !sortable
                ? undefined
                : active
                  ? sort.direction === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none';
              const SortIcon = !active
                ? ChevronsUpDown
                : sort.direction === 'asc'
                  ? ArrowUp
                  : ArrowDown;
              return (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={ariaSort}
                  className={cn(
                    'sticky top-0 z-10 border-b border-border bg-surface-muted px-3 py-2 text-left text-xs font-medium text-muted-foreground first:rounded-l-inner last:rounded-r-inner',
                    column.className,
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => {
                        toggleSort(column.id);
                      }}
                      className="-mx-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
                    >
                      {column.header}
                      <SortIcon aria-hidden className="size-3.5" />
                    </button>
                  ) : (
                    <span className={column.hideHeader ? 'sr-only' : undefined}>
                      {column.header}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const id = getRowId(row);
            return (
              <tr
                key={id}
                data-row-id={id}
                tabIndex={id === tabbableId ? 0 : -1}
                aria-label={getRowLabel?.(row)}
                data-selected={selectedId === id || undefined}
                onFocus={(event) => {
                  if (event.target === event.currentTarget) setActiveId(id);
                }}
                onKeyDown={(event) => {
                  onRowKeyDown(event, row);
                }}
                onClick={(event) => {
                  // A click on text opens the row; a click on a control inside it does its own thing.
                  const target = event.target as HTMLElement;
                  if (target.closest('button, a, input, select, textarea, [role="combobox"]'))
                    return;
                  onRowActivate?.(row);
                }}
                className={cn(
                  'group h-row outline-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                  onRowActivate && 'cursor-pointer',
                  selectedId === id ? 'bg-primary-subtle' : 'hover:bg-surface-muted',
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={cn(
                      'border-b border-border px-3 py-1.5 align-middle',
                      column.className,
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
