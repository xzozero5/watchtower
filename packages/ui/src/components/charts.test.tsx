import { fireEvent, render, screen, within } from '@testing-library/react';
import { Lock, SearchX } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { BarChart, type BarChartDatum } from './bar-chart.js';
import { BarList } from './bar-list.js';
import { StatTile } from './stat-tile.js';
import { TooltipProvider } from './tooltip.js';

const LABELS = { showTable: 'Show as a table', showChart: 'Show as a chart' };

const days = (count: number, value = (index: number) => index % 5): BarChartDatum[] =>
  Array.from({ length: count }, (_, index) => ({
    key: `d${String(index)}`,
    label: `Day ${String(index + 1)}`,
    axisLabel: String(index + 1),
    value: value(index),
  }));

function chart(data: BarChartDatum[], extra: { refreshing?: boolean } = {}) {
  return render(
    <TooltipProvider>
      <BarChart
        data={data}
        title="Created per day"
        valueLabel="Created"
        categoryLabel="Day"
        labels={LABELS}
        emptyText="No days in this window"
        keyboardHint="Use the arrow keys to read each day"
        {...extra}
      />
    </TooltipProvider>,
  );
}

const plot = () => screen.getByRole('group', { name: 'Created per day' });

describe('BarChart', () => {
  it('says so instead of drawing an empty plot when there are no days', () => {
    const { container } = chart([]);
    expect(screen.getByText('No days in this window')).toBeVisible();
    expect(container.querySelector('rect[data-slot]')).toBeNull();
  });

  it('draws one column, with a baseline, for a single day', () => {
    const { container } = chart(days(1, () => 3));
    expect(container.querySelectorAll('path.fill-chart-series')).toHaveLength(1);
    expect(container.querySelectorAll('rect[data-slot]')).toHaveLength(1);
  });

  it('draws no mark for a day with a real zero, and the table still says 0', () => {
    const { container } = chart(days(3, (index) => [0, 4, 0][index] ?? 0));
    expect(container.querySelectorAll('path.fill-chart-series')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Show as a table' }));
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText('0')).toBeVisible();
  });

  it('keeps 90 days inside one plot, with labels that do not crowd', () => {
    const { container } = chart(days(90));
    expect(container.querySelectorAll('rect[data-slot]')).toHaveLength(90);
    expect(container.querySelectorAll('svg[width] text').length).toBeLessThan(14);
    // The newest day is always named.
    expect(within(container).getAllByText('90').length).toBeGreaterThan(0);
  });

  it('never makes a bar thicker than 24 px', () => {
    const { container } = chart(days(3, () => 2));
    const path = container.querySelector('path.fill-chart-series')?.getAttribute('d') ?? '';
    const xs = [...path.matchAll(/[MHL]\s*(-?[\d.]+)/g)].map((match) => Number(match[1]));
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(24);
  });

  it('shows the tooltip for the column under the pointer and hides it on leave', () => {
    const { container } = chart(days(7, (index) => index + 1));
    expect(screen.queryByTestId('chart-tooltip')).toBeNull();
    fireEvent.pointerEnter(container.querySelector('rect[data-slot="3"]') as Element);
    const tip = screen.getByTestId('chart-tooltip');
    expect(tip).toHaveTextContent('4');
    expect(tip).toHaveTextContent('Created');
    expect(tip).toHaveTextContent('Day 4');
    fireEvent.pointerLeave(plot());
    expect(screen.queryByTestId('chart-tooltip')).toBeNull();
  });

  it('is one tab stop that reads each day with the arrow keys, Home, End, and Escape closes it', () => {
    chart(days(7, (index) => index + 1));
    const group = plot();
    expect(group).toHaveAttribute('tabindex', '0');
    expect(group).toHaveAccessibleDescription('Use the arrow keys to read each day');
    fireEvent.focus(group);
    // Focus lands on the newest day.
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent('Day 7');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent('Day 6');
    fireEvent.keyDown(group, { key: 'Home' });
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent('Day 1');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent('Day 1');
    fireEvent.keyDown(group, { key: 'End' });
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent('Day 7');
    // Announced as text too, not only drawn.
    expect(screen.getByRole('status')).toHaveTextContent('Day 7: 7');
    fireEvent.keyDown(group, { key: 'Escape' });
    expect(screen.queryByTestId('chart-tooltip')).toBeNull();
    fireEvent.blur(group);
    expect(screen.queryByTestId('chart-tooltip')).toBeNull();
  });

  it('offers every value as a table and goes back to the chart', () => {
    chart(days(4, (index) => index * 10));
    fireEvent.click(screen.getByRole('button', { name: 'Show as a table' }));
    const table = screen.getByRole('table', { name: 'Created per day' });
    expect(within(table).getByRole('columnheader', { name: 'Day' })).toBeVisible();
    expect(within(table).getByRole('columnheader', { name: 'Created' })).toBeVisible();
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(within(table).getByRole('rowheader', { name: 'Day 4' })).toBeVisible();
    expect(within(table).getByRole('cell', { name: '30' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Show as a chart' }));
    expect(screen.queryByRole('table')).toBeNull();
    expect(plot()).toBeVisible();
  });

  it('holds the previous render while refreshing instead of swapping in a skeleton', () => {
    const { container } = chart(days(5), { refreshing: true });
    expect(container.querySelector('figure')).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('.opacity-60')).not.toBeNull();
    expect(container.querySelectorAll('rect[data-slot]')).toHaveLength(5);
  });

  it('draws text in text tokens and marks in the series token, never the other way round', () => {
    const { container } = chart(days(5));
    for (const text of container.querySelectorAll('svg text')) {
      expect(text.getAttribute('class')).toContain('fill-muted-foreground');
      expect(text.getAttribute('class')).not.toContain('chart');
    }
    expect(container.querySelector('path.fill-chart-series')).not.toBeNull();
  });
});

describe('BarChart stacked by series (T-159)', () => {
  const stacked: BarChartDatum[] = [
    {
      key: 'a',
      label: 'Mon',
      axisLabel: 'M',
      value: 5,
      segments: [
        { key: 'x', label: 'Email', value: 3, fillClass: 'fill-chart-email' },
        { key: 'y', label: 'LINE', value: 2, fillClass: 'fill-chart-line' },
      ],
    },
    { key: 'b', label: 'Tue', axisLabel: 'T', value: 0 },
  ];

  it('names every series in a legend and draws one part per series', () => {
    const { container } = chart(stacked);
    expect(screen.getAllByText('Email').length).toBeGreaterThan(0);
    expect(screen.getAllByText('LINE').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('path.fill-chart-email')).toHaveLength(1);
    expect(container.querySelectorAll('path.fill-chart-line')).toHaveLength(1);
  });

  it('puts the parts in the table and the tooltip, not colour alone', () => {
    chart(stacked);
    fireEvent.focus(plot());
    fireEvent.keyDown(plot(), { key: 'Home' });
    const tooltip = screen.getByTestId('chart-tooltip');
    expect(within(tooltip).getByText('Email')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show as a table' }));
    expect(screen.getByRole('columnheader', { name: 'Email' })).toBeInTheDocument();
  });
});

describe('BarList', () => {
  const data = [
    { key: 'a', label: <span>Under 4 h</span>, name: 'Under 4 h', value: 4, color: 'var(--x)' },
    { key: 'b', label: <span>Over 3 d</span>, name: 'Over 3 d', value: 0, color: 'var(--y)' },
  ];
  const list = () =>
    render(
      <TooltipProvider>
        <BarList
          data={data}
          title="Open by age"
          valueLabel="Tickets"
          categoryLabel="Age"
          labels={LABELS}
        />
      </TooltipProvider>,
    );

  it('writes the value at the tip of every row, a real zero included', () => {
    list();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Under 4 h');
    expect(rows[0]).toHaveTextContent('4');
    expect(rows[1]).toHaveTextContent('0');
  });

  it('draws a bar for a value and none for zero, and each row takes keyboard focus', () => {
    list();
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]?.querySelectorAll('path')).toHaveLength(1);
    expect(rows[1]?.querySelectorAll('path')).toHaveLength(0);
    for (const row of rows) expect(row).toHaveAttribute('tabindex', '0');
  });

  it('opens a tooltip with the value on keyboard focus', async () => {
    list();
    (screen.getAllByRole('listitem')[0] as HTMLElement).focus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Under 4 h: 4 Tickets');
  });

  it('has a table view', () => {
    list();
    fireEvent.click(screen.getByRole('button', { name: 'Show as a table' }));
    const table = screen.getByRole('table', { name: 'Open by age' });
    expect(within(table).getByRole('cell', { name: '4' })).toBeVisible();
    expect(within(table).getByRole('cell', { name: '0' })).toBeVisible();
  });
});

describe('StatTile', () => {
  it('shows the figure, a real zero included', () => {
    render(<StatTile label="Open" value={0} />);
    expect(screen.getByText('Open')).toBeVisible();
    expect(screen.getByText('0')).toBeVisible();
  });

  it('shows the reason and no number when the figure is unavailable', () => {
    const { container } = render(
      <StatTile
        label="Median"
        state="unavailable"
        note="No data in this window"
        noteIcon={SearchX}
      />,
    );
    expect(screen.getByText('No data in this window')).toBeVisible();
    expect(container.querySelector('[data-state="unavailable"]')).not.toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('shows that a role does not see it, and no number', () => {
    render(<StatTile label="CSAT" state="restricted" note="Not for your role" noteIcon={Lock} />);
    expect(screen.getByText('Not for your role')).toBeVisible();
    expect(screen.queryByText(/\d/)).toBeNull();
  });

  it('puts the definition behind a button a keyboard can reach', () => {
    render(
      <StatTile
        label="At risk now"
        value={3}
        info="Due within 60 minutes. Assumed."
        infoLabel="About at risk"
      />,
    );
    const button = screen.getByRole('button', { name: 'About at risk' });
    fireEvent.click(button);
    expect(screen.getByText('Due within 60 minutes. Assumed.')).toBeVisible();
  });

  it('draws an alerting figure in the danger text colour', () => {
    render(<StatTile label="Breached now" value={2} alert />);
    expect(screen.getByText('2')).toHaveClass('text-danger');
  });
});
