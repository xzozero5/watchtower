import { describe, expect, it } from 'vitest';

import { COLOR_TOKENS } from './colors.js';
import { AA_TEXT_RATIO, contrastRatio } from './contrast.js';

// Values from docs/brand/README.md (measured from the master PNG, confirmed 2026-10-31).
const BRAND = {
  midnightNavy: '#0f172a',
  charcoal: '#363839',
  coral: '#e5594a',
  canvas: '#f7f7ed',
};

describe('brand palette in the tokens', () => {
  it('uses Canvas as the light background and Midnight Navy as the dark one', () => {
    expect(COLOR_TOKENS.light.background).toBe(BRAND.canvas);
    expect(COLOR_TOKENS.dark.background).toBe(BRAND.midnightNavy);
  });

  it('uses charcoal for light-mode text and Canvas for dark-mode text', () => {
    expect(COLOR_TOKENS.light.foreground).toBe(BRAND.charcoal);
    expect(COLOR_TOKENS.dark.foreground).toBe(BRAND.canvas);
  });

  it('uses navy for the main button in light mode and Canvas in dark mode', () => {
    expect(COLOR_TOKENS.light.primary).toBe(BRAND.midnightNavy);
    expect(COLOR_TOKENS.dark.primary).toBe(BRAND.canvas);
  });

  it('keeps coral out of every UI token so it cannot be mistaken for severity P1', () => {
    for (const theme of Object.values(COLOR_TOKENS)) {
      const used = [
        ...Object.values(theme).filter((value) => typeof value === 'string'),
        ...Object.values(theme.severity).flatMap(({ fg, bg, border }) => [fg, bg, border]),
      ];
      expect(used).not.toContain(BRAND.coral);
    }
  });

  it('links and focus pass AA text contrast on the brand backgrounds', () => {
    expect(contrastRatio(COLOR_TOKENS.light.link, BRAND.canvas)).toBeGreaterThanOrEqual(
      AA_TEXT_RATIO,
    );
    expect(contrastRatio(COLOR_TOKENS.dark.link, BRAND.midnightNavy)).toBeGreaterThanOrEqual(
      AA_TEXT_RATIO,
    );
  });
});
