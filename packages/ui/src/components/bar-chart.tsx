import { type KeyboardEvent, useId, useRef, useState } from 'react';

import { columnLayout, columnPath, countTicks, labelIndexes, niceCeil } from './chart-geometry.js';
import { ChartFrame, type ChartTableLabels } from './chart-frame.js';
import { useElementWidth } from './use-element-width.js';

export interface BarChartDatum {
  key: string;
  /** Full name of the column, shown in the tooltip, the table and to a screen reader ("Mon, Nov 2"). */
  label: string;
  /** Short name for the x axis ("2"). */
  axisLabel: string;
  value: number;
}

export interface BarChartProps {
  /** One column per datum, left to right. */
  data: readonly BarChartDatum[];
  /** What is plotted, in sentence case: the caption. One series needs no legend, the title says it. */
  title: string;
  /** The name of the measure ("Created"): the table's value heading. */
  valueLabel: string;
  /** The name of what each column is ("Day"): the table's first heading. */
  categoryLabel: string;
  labels: ChartTableLabels;
  /** Shown instead of the plot when there is nothing to plot (no columns at all). */
  emptyText: string;
  /** Read out when the plot gets keyboard focus, for example "Use the arrow keys to read each day". */
  keyboardHint: string;
  /** How a value reads in the tooltip, the table and the axis. Defaults to a plain number. */
  formatValue?: (value: number) => string;
  /** Plot height in px, without the x axis band. */
  height?: number;
  refreshing?: boolean;
  className?: string;
}

const LEFT = 34;
const TOP = 8;
const AXIS_BAND = 24;
const FALLBACK_WIDTH = 560;
const LABEL_SPACING = 64;

const plain = (value: number) => String(value);

/**
 * Columns over time, one series, one axis (dataviz: form first, colour last). Thin columns (at most
 * 24 px) with a 4 px rounded top and a 2 px gap, a hairline grid, text in text tokens. Every column
 * is a hit target as wide as its slot and as tall as the plot, so the pointer never has to land on
 * the mark; the plot is also one tab stop that reads columns with the arrow keys, Home and End, and
 * Escape hides the tooltip. The same numbers are in the table the frame offers.
 */
export function BarChart({
  data,
  title,
  valueLabel,
  categoryLabel,
  labels,
  emptyText,
  keyboardHint,
  formatValue = plain,
  height = 160,
  refreshing = false,
  className,
}: BarChartProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrapperRef, FALLBACK_WIDTH);
  const [active, setActive] = useState<number | null>(null);
  const hintId = useId();

  const plotWidth = Math.max(1, width - LEFT);
  const count = data.length;
  const max = data.reduce((highest, datum) => Math.max(highest, datum.value), 0);
  const top = niceCeil(max);
  const ticks = countTicks(top);
  const { slot, thickness } = columnLayout(count, plotWidth);
  const y = (value: number) => TOP + height - (value / top) * height;
  const activeDatum = active === null ? undefined : data[active];

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    const last = count - 1;
    const from = active ?? last;
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(last, from + 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, from - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else if (event.key === 'Escape') {
      // The tooltip is dismissible without moving the pointer or focus (WCAG 1.4.13).
      if (active !== null) event.stopPropagation();
      setActive(null);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  };

  const center = active === null ? 0 : LEFT + (active + 0.5) * slot;
  // Near either edge the tooltip hangs inward instead of leaving the chart.
  const shift = center < 80 ? '0' : center > width - 80 ? '-100%' : '-50%';

  return (
    <ChartFrame
      title={title}
      labels={labels}
      refreshing={refreshing}
      className={className}
      table={{
        columns: [categoryLabel, valueLabel],
        rows: data.map((datum) => ({
          key: datum.key,
          cells: [datum.label, formatValue(datum.value)],
        })),
      }}
    >
      {count === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <div ref={wrapperRef} className="relative min-w-0">
          <div
            role="group"
            aria-label={title}
            aria-describedby={hintId}
            tabIndex={0}
            onKeyDown={move}
            onFocus={() => {
              // Land on the newest column; the arrow keys walk from there.
              setActive((now) => now ?? count - 1);
            }}
            onBlur={() => {
              setActive(null);
            }}
            onPointerLeave={() => {
              setActive(null);
            }}
            className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span id={hintId} className="sr-only">
              {keyboardHint}
            </span>
            <svg
              width={width}
              height={TOP + height + AXIS_BAND}
              viewBox={`0 0 ${String(width)} ${String(TOP + height + AXIS_BAND)}`}
              aria-hidden
              className="block max-w-full select-none"
            >
              {ticks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={LEFT}
                    x2={width}
                    y1={y(tick)}
                    y2={y(tick)}
                    strokeWidth={1}
                    className={tick === 0 ? 'stroke-muted-foreground/40' : 'stroke-border'}
                  />
                  <text
                    x={LEFT - 8}
                    y={y(tick)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="fill-muted-foreground text-xs tabular"
                  >
                    {formatValue(tick)}
                  </text>
                </g>
              ))}
              {active !== null ? (
                <rect
                  x={LEFT + active * slot}
                  y={TOP}
                  width={slot}
                  height={height}
                  className="fill-surface-muted"
                />
              ) : null}
              {data.map((datum, index) => {
                if (datum.value <= 0) return null;
                const barHeight = Math.max(2, (datum.value / top) * height);
                const x = LEFT + index * slot + (slot - thickness) / 2;
                return (
                  <path
                    key={datum.key}
                    d={columnPath(x, TOP + height - barHeight, thickness, barHeight)}
                    className="fill-chart-series"
                  />
                );
              })}
              {labelIndexes(count, plotWidth, LABEL_SPACING).map((index) => {
                // Keep the first and last label inside the box instead of clipping them.
                const x = Math.min(width - 16, Math.max(LEFT + 4, LEFT + (index + 0.5) * slot));
                return (
                  <text
                    key={data[index]?.key}
                    x={x}
                    y={TOP + height + 16}
                    textAnchor="middle"
                    className="fill-muted-foreground text-xs"
                  >
                    {data[index]?.axisLabel}
                  </text>
                );
              })}
              {data.map((datum, index) => (
                <rect
                  key={datum.key}
                  data-slot={index}
                  x={LEFT + index * slot}
                  y={0}
                  width={slot}
                  height={TOP + height + AXIS_BAND}
                  fill="transparent"
                  onPointerEnter={() => {
                    setActive(index);
                  }}
                  onPointerMove={() => {
                    setActive(index);
                  }}
                />
              ))}
            </svg>
          </div>
          {activeDatum && active !== null ? (
            <div
              data-testid="chart-tooltip"
              className="pointer-events-none absolute z-10 min-w-24 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-overlay"
              style={{
                left: shift === '0' ? Math.max(0, center - 12) : center,
                top: y(activeDatum.value) - 8,
                transform: `translate(${shift}, -100%)`,
              }}
            >
              <div className="flex items-center gap-1.5">
                <span aria-hidden className="h-0.5 w-3 shrink-0 rounded-full bg-chart-series" />
                <strong className="text-sm font-semibold text-foreground">
                  {formatValue(activeDatum.value)}
                </strong>
                <span className="text-muted-foreground">{valueLabel}</span>
              </div>
              <div className="text-muted-foreground">{activeDatum.label}</div>
            </div>
          ) : null}
          <span role="status" className="sr-only">
            {activeDatum ? `${activeDatum.label}: ${formatValue(activeDatum.value)}` : ''}
          </span>
        </div>
      )}
    </ChartFrame>
  );
}
