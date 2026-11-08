// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BIRDDAY_SIZES, BIRDDAY_STATES, BirddayAvatar, BirddayIcon } from './birdday.js';

describe('Birdday mascot components', () => {
  it('renders BirddayIcon as decorative by default and never uses brand coral (#e5594a)', () => {
    const { container } = render(<BirddayIcon className="size-4" />);
    const svg = container.querySelector('[data-slot="birdday-icon"]');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(container.innerHTML.toLowerCase()).not.toContain('#e5594a');
    // Signature cockatiel golden crest & apricot cheek
    expect(container.innerHTML.toLowerCase()).toContain('#fbbf24');
    expect(container.innerHTML.toLowerCase()).toContain('#fb923c');
  });

  it('supports every BirddayAvatar state and size with motion-safe animations', () => {
    for (const state of BIRDDAY_STATES) {
      for (const size of BIRDDAY_SIZES) {
        const { container, unmount } = render(<BirddayAvatar state={state} size={size} />);
        const el = container.querySelector('[data-slot="birdday-avatar"]');
        expect(el?.getAttribute('data-bird-state')).toBe(state);
        expect(el?.getAttribute('aria-hidden')).toBe('true');
        expect(container.innerHTML.toLowerCase()).not.toContain('#e5594a');
        unmount();
      }
    }
  });

  it('exposes role="img" and aria-label when standalone label is passed', () => {
    render(<BirddayAvatar state="thinking" label="Birdday is thinking" />);
    const img = screen.getByRole('img', { name: 'Birdday is thinking' });
    expect(img.getAttribute('data-bird-state')).toBe('thinking');
  });
});
