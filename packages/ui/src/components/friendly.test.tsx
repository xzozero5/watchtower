import { fireEvent, render, screen } from '@testing-library/react';
import { Check } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { TINT_IDS } from '../tokens/colors.js';
import { ConfidenceDots, litDots } from './confidence-dots.js';
import { EmptyState } from './empty-state.js';
import { IconButton } from './icon-button.js';
import { INTENT_TINTS, IntentChip, intentIcon, intentTint } from './intent-chip.js';
import { SectionHeading } from './section-heading.js';
import { SeverityBadge } from './severity-badge.js';
import { TINT_CLASSES } from './tint.js';
import { TintChip } from './tint-chip.js';
import { TooltipProvider } from './tooltip.js';

describe('IconButton', () => {
  it('is a button named by its label, with the shortcut as aria-keyshortcuts', () => {
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <IconButton label="Edit" shortcut={['E']} icon={<Check aria-hidden />} onClick={onClick} />
      </TooltipProvider>,
    );
    const button = screen.getByRole('button', { name: 'Edit' });
    expect(button).toHaveAttribute('aria-keyshortcuts', 'E');
    expect(button).toHaveClass('rounded-full');
    expect(button).toHaveTextContent('');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps working when disabled', () => {
    render(
      <TooltipProvider>
        <IconButton label="Copy" icon={<Check aria-hidden />} disabled />
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
  });
});

describe('TintChip', () => {
  it('draws the words next to the icon', () => {
    const { container } = render(
      <TintChip tone="amber" icon={Check}>
        Needs you
      </TintChip>,
    );
    expect(screen.getByText('Needs you')).toBeVisible();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.firstElementChild).toHaveAttribute('data-tone', 'amber');
  });

  it('keeps the words for screen readers and a tooltip when icon only', () => {
    const { container } = render(
      <TintChip tone="teal" icon={Check} iconOnly>
        Draft ready
      </TintChip>,
    );
    expect(screen.getByText('Draft ready')).toHaveClass('sr-only');
    expect(container.firstElementChild).toHaveAttribute('title', 'Draft ready');
  });

  it('has classes for every tint family', () => {
    for (const id of TINT_IDS) {
      expect(TINT_CLASSES[id].chip).toContain(`bg-tint-${id}-bg`);
      expect(TINT_CLASSES[id].chip).toContain(`text-tint-${id}-fg`);
      expect(TINT_CLASSES[id].icon).toContain(`text-tint-${id}-icon`);
    }
  });
});

describe('severity as tinted chips', () => {
  it('uses red only for P1', () => {
    for (const [severity, tone] of [
      ['p1', 'red'],
      ['p2', 'amber'],
      ['p3', 'sky'],
      ['p4', 'slate'],
    ] as const) {
      const { container, unmount } = render(<SeverityBadge severity={severity} label="x" />);
      expect(container.firstElementChild?.className).toContain(`bg-tint-${tone}-bg`);
      unmount();
    }
  });
});

describe('intent colour and icon', () => {
  it('hashes an intent key to the same hue every time, and never to red or slate', () => {
    expect(intentTint('account_access')).toBe(intentTint('account_access'));
    expect(INTENT_TINTS).not.toContain('red');
    expect(INTENT_TINTS).not.toContain('slate');
    expect(INTENT_TINTS).toHaveLength(8);
    const keys = [
      'account_access',
      'api_error',
      'billing_report',
      'feature_question',
      'other',
      'upstream_timeout',
      'webhook_not_received',
      'workspace_config',
    ];
    const hues = new Set(keys.map(intentTint));
    expect(hues.size).toBeGreaterThan(3);
  });

  it('maps intent families to different icons and falls back to a tag', () => {
    const timeout = intentIcon('upstream_timeout');
    const webhook = intentIcon('webhook_not_received');
    const access = intentIcon('account_access');
    expect(new Set([timeout, webhook, access]).size).toBe(3);
    expect(intentIcon('something_new')).toBe(intentIcon('other'));
  });

  it('renders the name with its key on the element', () => {
    render(<IntentChip intentKey="upstream_timeout" name="Upstream timeout" />);
    expect(screen.getByText('Upstream timeout').closest('[data-intent]')).toHaveAttribute(
      'data-intent',
      'upstream_timeout',
    );
  });
});

describe('ConfidenceDots', () => {
  it('lights dots in proportion and keeps the number in the accessible name', () => {
    expect(litDots(0)).toBe(0);
    expect(litDots(0.86)).toBe(4);
    expect(litDots(0.9)).toBe(5);
    expect(litDots(1.4)).toBe(5);
    render(<ConfidenceDots value={0.86} label="Confidence High 0.86" />);
    const meter = screen.getByRole('meter', { name: 'Confidence High 0.86' });
    expect(meter).toHaveAttribute('aria-valuenow', '0.86');
    expect(meter.querySelectorAll('[data-on="true"]')).toHaveLength(4);
    expect(meter.querySelectorAll('[data-on="false"]')).toHaveLength(1);
    expect(meter).toHaveTextContent('');
  });
});

describe('EmptyState and SectionHeading', () => {
  it('draws the icon in a tinted circle with one line', () => {
    const { container } = render(<EmptyState icon={<Check />} tone="teal" title="All caught up" />);
    expect(screen.getByText('All caught up')).toBeVisible();
    expect(container.querySelector('[data-tone="teal"]')).not.toBeNull();
  });

  it('shows a dot, an icon, the name and a count', () => {
    const { container } = render(
      <SectionHeading tone="amber" icon={Check} count={3}>
        Needs you
      </SectionHeading>,
    );
    expect(container).toHaveTextContent('Needs you3');
    expect(container.querySelectorAll('svg')).toHaveLength(1);
  });
});
