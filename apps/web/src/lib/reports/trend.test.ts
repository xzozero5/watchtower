import { describe, expect, it } from 'vitest';

import { changeOf } from './trend';

describe('changeOf', () => {
  it('has no chip without a previous period, or a zero base for a relative change', () => {
    expect(changeOf(5, null, 'relative', 'higher')).toBeNull();
    expect(changeOf(5, 0, 'relative', 'higher')).toBeNull();
    // A share can be compared with a previous share of zero: it is a gap in points.
    expect(changeOf(0.2, 0, 'share', 'higher')).toMatchObject({ direction: 'up', amount: 20 });
  });

  it('compares a relative figure in percent and a share in points', () => {
    expect(changeOf(150, 100, 'relative', 'neutral')).toEqual({
      direction: 'up',
      meaning: 'neutral',
      amount: 50,
      unit: 'percent',
    });
    expect(changeOf(0.8, 0.9, 'share', 'higher')).toEqual({
      direction: 'down',
      meaning: 'bad',
      amount: 10,
      unit: 'points',
    });
  });

  it('says whether the direction is the good one: lower is good for a duration', () => {
    expect(changeOf(60, 100, 'relative', 'lower')?.meaning).toBe('good');
    expect(changeOf(140, 100, 'relative', 'lower')?.meaning).toBe('bad');
    expect(changeOf(140, 100, 'relative', 'higher')?.meaning).toBe('good');
  });

  it('calls a change that rounds to nothing flat, with no tint', () => {
    expect(changeOf(100.2, 100, 'relative', 'higher')).toEqual({
      direction: 'flat',
      meaning: 'neutral',
      amount: 0,
      unit: 'percent',
    });
  });
});
