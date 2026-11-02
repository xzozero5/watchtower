import { ChartColumn, Table2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

import { cn } from '../lib/cn.js';
import { IconButton } from './icon-button.js';

export interface ChartTableLabels {
  /** The name of the button that switches to the table, for example "Show as a table". */
  showTable: string;
  /** The name of the button that switches back, for example "Show as a chart". */
  showChart: string;
}

export interface ChartTableView {
  /** Column headings, first the category. */
  columns: readonly [string, ...string[]];
  rows: readonly { key: string; cells: readonly ReactNode[] }[];
}

export interface ChartFrameProps {
  /** What is plotted, in sentence case. It is the figure's caption and the table's caption. */
  title: string;
  labels: ChartTableLabels;
  table: ChartTableView;
  /** The chart. Rendered when the table is not showing. */
  children: ReactNode;
  /** The data is reloading: hold the previous render at reduced opacity, no skeleton, no jump. */
  refreshing?: boolean;
  className?: string;
}

/**
 * The container every chart sits in (dataviz components): a `<figure>` with a caption and a button
 * that swaps the chart for its table, which holds the same numbers (the accessible twin; a tooltip
 * never gates a value). The frame keeps its height by itself because the chart does.
 */
export function ChartFrame({
  title,
  labels,
  table,
  children,
  refreshing = false,
  className,
}: ChartFrameProps) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const captionId = useId();
  const showingTable = view === 'table';
  return (
    <figure
      aria-labelledby={captionId}
      aria-busy={refreshing || undefined}
      className={cn('flex min-w-0 flex-col gap-2', className)}
    >
      <div className="flex items-center justify-between gap-2">
        <figcaption id={captionId} className="text-sm font-medium text-foreground">
          {title}
        </figcaption>
        <IconButton
          label={showingTable ? labels.showChart : labels.showTable}
          aria-pressed={showingTable}
          icon={showingTable ? <ChartColumn aria-hidden /> : <Table2 aria-hidden />}
          onClick={() => {
            setView(showingTable ? 'chart' : 'table');
          }}
        />
      </div>
      <div className={cn('min-w-0 motion-safe:transition-opacity', refreshing && 'opacity-60')}>
        {showingTable ? (
          <div
            role="region"
            aria-label={title}
            tabIndex={0}
            className="max-h-64 overflow-auto rounded-md focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
          >
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">{title}</caption>
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  {table.columns.map((column, index) => (
                    <th
                      key={column}
                      scope="col"
                      className={cn('py-1 font-medium', index === 0 ? 'pr-3' : 'pl-3 text-right')}
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.key} className="border-b border-border/60 last:border-b-0">
                    {row.cells.map((cell, index) => {
                      const Cell = index === 0 ? 'th' : 'td';
                      return (
                        <Cell
                          key={index}
                          {...(index === 0 ? { scope: 'row' as const } : {})}
                          className={cn(
                            'py-1',
                            index === 0
                              ? 'pr-3 font-normal text-foreground'
                              : 'tabular pl-3 text-right text-foreground',
                          )}
                        >
                          {cell}
                        </Cell>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          children
        )}
      </div>
    </figure>
  );
}
