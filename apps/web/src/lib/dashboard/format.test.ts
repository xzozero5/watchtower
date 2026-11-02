import { describe, expect, it } from 'vitest';

import { formatDay, formatRate, formatScore, formatSeconds, formatUsd } from './format';

describe('formatSeconds', () => {
  it('names seconds under a minute instead of reading them as 0m', () => {
    expect(formatSeconds(30, 'en')).toBe('30s');
    expect(formatSeconds(0, 'en')).toBe('0s');
  });

  it('uses at most two units above a minute', () => {
    expect(formatSeconds(540, 'en')).toBe('9m');
    expect(formatSeconds(5400, 'en')).toBe('1h 30m');
    expect(formatSeconds(100_800, 'en')).toBe('1d 4h');
  });
});

describe('formatRate', () => {
  it('writes a real zero as 0% and keeps a decimal under 10%', () => {
    expect(formatRate(0, 'en')).toBe('0%');
    expect(formatRate(0.004, 'en')).toBe('0.4%');
    expect(formatRate(0.0789, 'en')).toBe('7.9%');
    expect(formatRate(0.3, 'en')).toBe('30%');
    expect(formatRate(1, 'en')).toBe('100%');
  });
});

describe('formatUsd and formatScore', () => {
  it('shows a few cents with three decimals and larger amounts with two', () => {
    expect(formatUsd(0.042, 'en')).toBe('$0.042');
    expect(formatUsd(12.5, 'en')).toBe('$12.50');
  });

  it('writes a score with one decimal', () => {
    expect(formatScore(4.25, 'en')).toBe('4.3');
    expect(formatScore(5, 'en')).toBe('5.0');
  });
});

describe('formatDay', () => {
  it('names the bucket own UTC day whatever the browser zone is', () => {
    expect(formatDay('2026-11-02', 'en', 'short')).toBe('Nov 2');
    expect(formatDay('2026-11-02', 'en', 'long')).toBe('Mon, Nov 2');
  });

  it('formats in Thai and falls back to the raw text for a bad day', () => {
    expect(formatDay('2026-11-02', 'th', 'short')).toContain('2');
    expect(formatDay('not-a-day', 'en', 'short')).toBe('not-a-day');
  });
});
