import { describe, expect, it } from 'vitest';

import { channelSegments, volumeTrend } from './volume';

describe('volumeTrend', () => {
  it('has no chip without a base', () => {
    expect(volumeTrend(5, 0)).toBeNull();
  });
  it('rounds to whole percent and names the direction', () => {
    expect(volumeTrend(12, 10)).toEqual({ direction: 'up', percent: 20 });
    expect(volumeTrend(5, 10)).toEqual({ direction: 'down', percent: 50 });
    expect(volumeTrend(0, 10)).toEqual({ direction: 'down', percent: 100 });
  });
  it('is flat when the change rounds to zero', () => {
    expect(volumeTrend(10, 10)).toEqual({ direction: 'flat', percent: 0 });
    expect(volumeTrend(1001, 1000)).toEqual({ direction: 'flat', percent: 0 });
  });
});

describe('channelSegments', () => {
  const name = (channel: string) => channel.toUpperCase();
  it('orders email, LINE, portal and rolls other channels into one part', () => {
    const parts = channelSegments({ portal: 2, discord: 1, gmail: 3, webhook: 1 }, name);
    expect(parts.map((part) => [part.key, part.value])).toEqual([
      ['gmail', 3],
      ['portal', 2],
      ['other', 2],
    ]);
    expect(parts[0]?.fillClass).toBe('fill-chart-email');
  });
  it('is empty for a day with no tickets', () => {
    expect(channelSegments({}, name)).toEqual([]);
  });
});
