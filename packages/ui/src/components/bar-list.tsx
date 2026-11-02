import { type ReactNode, useRef } from 'react';

import { ChartFrame, type ChartTableLabels } from './chart-frame.js';
import { rowPath } from './chart-geometry.js';
import { Tooltip } from './tooltip.js';
import { useElementWidth } from './use-element-width.js';

export interface BarListDatum {
  key: string;
  /** What names the row on screen: text, or a badge with an icon (a status never relies on colour). */
  label: ReactNode;
  /** The same name as plain text, for the tooltip, the table and a screen reader. */
  name: string;
  value: number;
  /** The mark's colour as a CSS value, normally a design-token variable. */
  color: string;
}

export interface BarListProps {
  data: readonly BarListDatum[];
  /** What is plotted, in sentence case. */
  title: string;
  valueLabel: string;
  categoryLabel: string;
  labels: ChartTableLabels;
  formatValue?: (value: number) => string;
  refreshing?: boolean;
  className?: string;
}

const BAR_HEIGHT = 10;
const plain = (value: number) => String(value);

/** One horizontal bar, 10 px thick, from a square baseline to a 4 px rounded tip. */
function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref, 160);
  const length = value > 0 ? Math.max(2, (value / max) * width) : 0;
  return (
    <div ref={ref} className="min-w-0">
      <svg width={width} height={BAR_HEIGHT} aria-hidden className="block max-w-full">
        {length > 0 ? <path d={rowPath(0, 0, length, BAR_HEIGHT)} style={{ fill: color }} /> : null}
      </svg>
    </div>
  );
}

/**
 * A few labelled magnitudes as horizontal bars: ordered buckets (age bands) or a status scale
 * (severity). One axis, the value at the tip of each bar, no grid to draw. Each row is a hover and
 * keyboard target that names the value in a tooltip, and the frame offers the same numbers as a
 * table. The caller picks the colours: a status scale passes its own colour per row and a label
 * that carries an icon, so colour is never the only channel.
 */
export function BarList({
  data,
  title,
  valueLabel,
  categoryLabel,
  labels,
  formatValue = plain,
  refreshing = false,
  className,
}: BarListProps) {
  const max = Math.max(1, ...data.map((datum) => datum.value));
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
          cells: [datum.name, formatValue(datum.value)],
        })),
      }}
    >
      <ul className="flex flex-col gap-0.5">
        {data.map((datum) => (
          <Tooltip
            key={datum.key}
            side="top"
            content={`${datum.name}: ${formatValue(datum.value)} ${valueLabel}`}
          >
            <li
              tabIndex={0}
              className="grid min-h-9 grid-cols-[minmax(5.5rem,9rem)_minmax(0,1fr)_3rem] items-center gap-3 rounded-md px-1 hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
            >
              <span className="min-w-0 text-sm text-foreground">{datum.label}</span>
              <Bar value={datum.value} max={max} color={datum.color} />
              <span className="tabular text-right text-sm font-medium text-foreground">
                {formatValue(datum.value)}
              </span>
            </li>
          </Tooltip>
        ))}
      </ul>
    </ChartFrame>
  );
}
