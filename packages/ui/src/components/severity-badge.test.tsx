import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SEVERITIES, SEVERITY_IDS } from '../tokens/severity.js';
import { SeverityBadge } from './severity-badge.js';

const LABELS = { p1: 'Critical', p2: 'High', p3: 'Medium', p4: 'Low' } as const;

describe('SeverityBadge', () => {
  it.each(SEVERITY_IDS)('shows the code, the label and an icon for %s', (severity) => {
    const { container } = render(<SeverityBadge severity={severity} label={LABELS[severity]} />);
    expect(screen.getByText(SEVERITIES[severity].code)).toBeVisible();
    expect(screen.getByText(LABELS[severity])).toBeVisible();
    const icon = container.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('does not rely on colour: every level has a different icon and a different code', () => {
    const shapes = new Set<string>();
    const codes = new Set<string>();
    for (const severity of SEVERITY_IDS) {
      const { container, unmount } = render(
        <SeverityBadge severity={severity} label={LABELS[severity]} />,
      );
      shapes.add(container.querySelector('svg')?.getAttribute('class') ?? '');
      codes.add(container.textContent);
      unmount();
    }
    expect(codes.size).toBe(SEVERITY_IDS.length);
    // Same size classes on every icon, so the class string differs only by the lucide icon name.
    expect(shapes.size).toBe(SEVERITY_IDS.length);
  });

  it('keeps the label for screen readers when it is visually hidden', () => {
    render(<SeverityBadge severity="p1" label="Critical" hideLabel />);
    expect(screen.getByText('Critical')).toHaveClass('sr-only');
    expect(screen.getByText('P1')).toBeVisible();
  });
});
