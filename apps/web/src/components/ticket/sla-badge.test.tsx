import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderApp } from '@/test-utils';
import type { SlaState, SlaView } from '@/lib/tickets/sla';

import { SlaBadge } from './sla-badge';

const DUE = '2026-11-02T07:30:00.000Z'; // 14:30 in Asia/Bangkok

function badge(state: SlaState, extra: Partial<SlaView> = {}) {
  return {
    state,
    target: 'firstResponse' as const,
    ms: 42 * 60_000,
    dueAt: DUE,
    ...extra,
  };
}

describe('SlaBadge', () => {
  it.each([
    ['onTrack', 'FR 42m'],
    ['atRisk', 'FR 42m left'],
    ['breached', 'Overdue 42m'],
    ['paused', 'Paused'],
  ] as const)('shows %s as an icon and the words "%s"', (state, text) => {
    const { container } = renderApp(<SlaBadge sla={badge(state)} />);
    const element = screen.getByRole('img');
    expect(element).toHaveAttribute('data-sla', state);
    expect(element).toHaveTextContent(text);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('gives the full sentence with the due time in Bangkok time, as tooltip and accessible name', () => {
    renderApp(<SlaBadge sla={badge('atRisk')} />);
    const element = screen.getByRole('img', {
      name: /FR 42m left — First response due .*2:30\s?PM/,
    });
    expect(element).toHaveAttribute('title', element.getAttribute('aria-label'));
  });

  it('shows Resolution targets with their own label', () => {
    renderApp(<SlaBadge sla={badge('onTrack', { target: 'resolution', ms: 28 * 3_600_000 })} />);
    expect(screen.getByRole('img')).toHaveTextContent('Res 1d 4h');
  });

  it('shows "Met" without a target, and nothing when there is no SLA', () => {
    const { rerender, container } = renderApp(
      <SlaBadge sla={{ state: 'met', target: null, ms: 0, dueAt: null }} />,
    );
    expect(screen.getByRole('img')).toHaveTextContent('Met');
    rerender(<SlaBadge sla={{ state: 'none', target: null, ms: 0, dueAt: null }} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('[data-sla]')).toBeNull();
  });

  it('is in Thai too', () => {
    renderApp(<SlaBadge sla={badge('breached')} />, { locale: 'th' });
    expect(screen.getByRole('img')).toHaveTextContent('เกินกำหนด');
  });
});
