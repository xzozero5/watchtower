import { describe, expect, it } from 'vitest';

import {
  BAR_GAP,
  BAR_MAX_THICKNESS,
  columnLayout,
  columnPath,
  countTicks,
  labelIndexes,
  niceCeil,
  rowPath,
  slotAt,
} from './chart-geometry.js';

describe('niceCeil and countTicks', () => {
  it.each([
    [0, 1],
    [1, 1],
    [2, 2],
    [3, 4],
    [5, 6],
    [7, 8],
    [9, 10],
    [11, 20],
    [37, 40],
    [101, 200],
    [1234, 2000],
  ])('rounds %i up to %i', (max, top) => {
    expect(niceCeil(max)).toBe(top);
  });

  it('gives whole-number ticks, 0 included, so a count axis never shows 0.5', () => {
    expect(countTicks(1)).toEqual([0, 1]);
    expect(countTicks(2)).toEqual([0, 1, 2]);
    expect(countTicks(6)).toEqual([0, 3, 6]);
    expect(countTicks(40)).toEqual([0, 20, 40]);
    for (const max of [3, 5, 7, 9, 11, 37, 101]) {
      for (const tick of countTicks(niceCeil(max))) expect(Number.isInteger(tick)).toBe(true);
    }
  });
});

describe('labelIndexes', () => {
  it('labels nothing for no columns and the only column for one', () => {
    expect(labelIndexes(0, 300, 60)).toEqual([]);
    expect(labelIndexes(1, 300, 60)).toEqual([0]);
  });

  it('always names the newest column and keeps the labels apart', () => {
    const picked = labelIndexes(90, 300, 60);
    expect(picked.at(-1)).toBe(89);
    expect(picked.length).toBeLessThanOrEqual(5);
    const slot = 300 / 90;
    for (let i = 1; i < picked.length; i += 1) {
      expect(((picked[i] ?? 0) - (picked[i - 1] ?? 0)) * slot).toBeGreaterThanOrEqual(60);
    }
  });

  it('labels every column when there is room', () => {
    expect(labelIndexes(7, 700, 60)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('columnLayout', () => {
  it('caps a bar at 24 px however wide the slot is', () => {
    expect(columnLayout(1, 600).thickness).toBe(BAR_MAX_THICKNESS);
    expect(columnLayout(7, 700).thickness).toBe(BAR_MAX_THICKNESS);
  });

  it('keeps a 2 px surface gap between neighbours', () => {
    const { slot, thickness } = columnLayout(30, 300);
    expect(slot - thickness).toBeGreaterThanOrEqual(BAR_GAP);
  });

  it('still draws something for 90 columns on a phone', () => {
    const { slot, thickness } = columnLayout(90, 300);
    expect(slot).toBeCloseTo(3.33, 1);
    expect(thickness).toBeGreaterThanOrEqual(1);
  });
});

describe('columnPath and rowPath', () => {
  it('rounds the data end by 4 px and leaves the baseline square', () => {
    const path = columnPath(10, 20, 24, 100);
    // Starts at the bottom left corner with no arc, arcs only at the top.
    expect(path.startsWith('M10 120V24A4 4 0 0 1 14 20')).toBe(true);
    expect(path.match(/A/g)).toHaveLength(2);
    expect(path.endsWith('V120Z')).toBe(true);
  });

  it('never rounds more than the bar can take', () => {
    expect(columnPath(0, 0, 2, 100)).toContain('A1 1 0 0 1');
    expect(columnPath(0, 98, 24, 2)).toContain('A2 2 0 0 1');
  });

  it('draws a plain rectangle when there is no room to round', () => {
    expect(columnPath(0, 0, 0, 10).includes('A')).toBe(false);
  });

  it('rounds a horizontal bar on the right only', () => {
    const path = rowPath(0, 0, 100, 10);
    expect(path.startsWith('M0 0H96A4 4 0 0 1 100 4')).toBe(true);
    expect(path.match(/A/g)).toHaveLength(2);
    expect(path.endsWith('H0Z')).toBe(true);
  });
});

describe('slotAt', () => {
  it('maps the pointer to a column and clamps at both ends', () => {
    expect(slotAt(-5, 10, 100)).toBe(0);
    expect(slotAt(0, 10, 100)).toBe(0);
    expect(slotAt(25, 10, 100)).toBe(2);
    expect(slotAt(1000, 10, 100)).toBe(9);
    expect(slotAt(10, 0, 100)).toBe(-1);
  });
});
