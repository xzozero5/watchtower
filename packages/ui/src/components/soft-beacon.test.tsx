import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AppFrame } from './app-frame.js';
import { Card, CardHeader, HighlightCard } from './card.js';
import { TrendChip } from './trend-chip.js';

describe('Card', () => {
  it('is a borderless card with the soft shadow, and a region when it is a labelled section', () => {
    render(
      <Card as="section" aria-labelledby="t">
        <CardHeader title={<h2 id="t">Open tickets</h2>} subtitle="Right now" actions="x" />
      </Card>,
    );
    const region = screen.getByRole('region', { name: 'Open tickets' });
    expect(region).toHaveClass('rounded-card', 'bg-surface', 'shadow-card');
    expect(region).not.toHaveClass('border');
    expect(screen.getByText('Right now')).toBeInTheDocument();
  });

  it('draws the highlight card on the gradient ground', () => {
    render(<HighlightCard data-testid="h">AI drafted 4 replies</HighlightCard>);
    expect(screen.getByTestId('h')).toHaveClass('bg-highlight');
  });
});

describe('TrendChip', () => {
  it('always shows the words, and colours by meaning, never red', () => {
    const { rerender } = render(
      <TrendChip direction="down" meaning="good" label="-8% vs last week" />,
    );
    const chip = screen.getByText('-8% vs last week');
    expect(chip).toHaveAttribute('data-meaning', 'good');
    expect(chip.className).toContain('tint-green');
    rerender(<TrendChip direction="up" meaning="bad" label="+3 breaches" />);
    expect(screen.getByText('+3 breaches').className).toContain('tint-amber');
    expect(screen.getByText('+3 breaches').className).not.toContain('tint-red');
  });
});

describe('AppFrame', () => {
  it('passes attributes to the sheet inside the backdrop', () => {
    render(<AppFrame data-testid="sheet">content</AppFrame>);
    const sheet = screen.getByTestId('sheet');
    expect(sheet).toHaveClass('bg-frame');
    expect(sheet.parentElement).toHaveAttribute('data-app-frame');
  });
});
