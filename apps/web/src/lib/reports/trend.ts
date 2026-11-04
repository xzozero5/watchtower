import type { TrendDirection, TrendMeaning } from '@watchtower/ui';

export interface Change {
  direction: TrendDirection;
  meaning: TrendMeaning;
  /** A relative change in percent, or the gap in percentage points for a share. */
  amount: number;
  unit: 'percent' | 'points';
}

/** Which way is the good way for a figure. `neutral` never gets a tint (volume going up is not good news). */
export type Better = 'higher' | 'lower' | 'neutral';

/** A change that rounds to nothing reads as flat. */
const FLAT_BELOW = 0.5;

/**
 * Change against the period before. A share (0 to 1) is compared in percentage points, anything else
 * relative to the previous value. With nothing to compare to, or a zero base for a relative change, there
 * is no chip (null): "+infinity" says nothing.
 */
export function changeOf(
  current: number,
  previous: number | null,
  kind: 'relative' | 'share',
  better: Better,
): Change | null {
  if (previous === null) return null;
  if (kind === 'relative' && previous <= 0) return null;
  const raw =
    kind === 'share' ? (current - previous) * 100 : ((current - previous) / previous) * 100;
  const amount = Math.round(Math.abs(raw));
  if (Math.abs(raw) < FLAT_BELOW)
    return {
      direction: 'flat',
      meaning: 'neutral',
      amount: 0,
      unit: kind === 'share' ? 'points' : 'percent',
    };
  const direction: TrendDirection = raw > 0 ? 'up' : 'down';
  const meaning: TrendMeaning =
    better === 'neutral'
      ? 'neutral'
      : (better === 'higher') === (direction === 'up')
        ? 'good'
        : 'bad';
  return { direction, meaning, amount, unit: kind === 'share' ? 'points' : 'percent' };
}
