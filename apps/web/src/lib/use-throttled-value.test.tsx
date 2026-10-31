import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useThrottledValue } from './use-throttled-value';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const settle = (ms = 0) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe('useThrottledValue', () => {
  it('shows the first change at once and holds later ones until the window ends', () => {
    const { result, rerender } = renderHook(({ value }) => useThrottledValue(value, 30_000), {
      initialProps: { value: 0 },
    });
    expect(result.current).toBe(0);

    rerender({ value: 1 });
    settle();
    expect(result.current).toBe(1);

    rerender({ value: 2 });
    settle(10_000);
    expect(result.current).toBe(1);
    rerender({ value: 3 });
    settle(19_000);
    expect(result.current).toBe(1);

    // Window over: the latest value wins, not every intermediate one.
    settle(1_000);
    expect(result.current).toBe(3);
  });

  it('announces at most once per window however often the value changes', () => {
    const seen: number[] = [];
    const { result, rerender } = renderHook(({ value }) => useThrottledValue(value, 30_000), {
      initialProps: { value: 0 },
    });
    for (let count = 1; count <= 20; count += 1) {
      rerender({ value: count });
      settle(1_000);
      if (seen[seen.length - 1] !== result.current) seen.push(result.current);
    }
    // 20 s of changes: the first count, and nothing else yet.
    expect(seen).toEqual([1]);
    settle(30_000);
    expect(result.current).toBe(20);
  });

  it('lets an "immediate" value through, so the announcement clears when the count hits zero', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useThrottledValue(value, 30_000, (v) => v === 0),
      { initialProps: { value: 0 } },
    );
    rerender({ value: 4 });
    settle();
    expect(result.current).toBe(4);
    rerender({ value: 0 });
    settle();
    expect(result.current).toBe(0);
  });
});
