// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { buildTailwindThemeCss, buildTokensCss } from '../tokens/css.js';
import { Skeleton, SkeletonCard, SkeletonText } from './skeleton.js';

describe('Skeleton components & directional shimmer', () => {
  it('renders decorative shimmer block with motion-safe animation', () => {
    const { container } = render(<Skeleton className="h-4 w-24" />);
    const node = container.querySelector('[data-slot="skeleton"]');
    expect(node).not.toBeNull();
    expect(node?.getAttribute('aria-hidden')).toBe('true');
    expect(node?.className).toContain('bg-skeleton');
    expect(node?.className).toContain('motion-safe:animate-shimmer');
  });

  it('renders staggered SkeletonText and SkeletonCard', () => {
    const { container } = render(
      <div>
        <SkeletonText lines={4} />
        <SkeletonCard lines={2} />
      </div>,
    );
    const blocks = container.querySelectorAll('[data-slot="skeleton"]');
    // 4 lines in SkeletonText + (circle + title + pill + 2 lines) in SkeletonCard = 9
    expect(blocks.length).toBe(9);
  });

  it('declares bg-skeleton and zeros shimmer duration under prefers-reduced-motion', () => {
    const tokens = buildTokensCss();
    const theme = buildTailwindThemeCss();
    expect(tokens).toContain('--wt-motion-duration-shimmer: 1600ms;');
    expect(tokens).toContain('--wt-motion-duration-shimmer: 0ms;');
    expect(theme).toContain('@utility bg-skeleton {');
    expect(theme).toContain('@keyframes wt-shimmer {');
  });
});
