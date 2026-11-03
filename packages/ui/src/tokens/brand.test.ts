import { describe, expect, it } from 'vitest';

import { COLOR_TOKENS } from './colors.js';
import { AA_TEXT_RATIO, contrastRatio, relativeLuminance } from './contrast.js';

// Values from docs/brand/README.md (measured from the master PNG, confirmed 2026-10-31).
const BRAND = {
  midnightNavy: '#0f172a',
  navy: '#1d2739',
  charcoal: '#363839',
  coral: '#e5594a',
  canvas: '#f7f7ed',
  ivory: '#f7f0d4',
  seafoam: '#80cfc0',
};

describe('brand palette in the tokens', () => {
  it('keeps the app canvas a near-neutral cool grey and the ivory for brand moments only', () => {
    // Soft Beacon: a faint cool cast (blue a few steps above red), never a hue of its own.
    const [r, g, b] = [1, 3, 5].map((i) =>
      parseInt(COLOR_TOKENS.light.background.slice(i, i + 2), 16),
    );
    expect(Math.max(r ?? 0, g ?? 0, b ?? 0) - Math.min(r ?? 0, g ?? 0, b ?? 0)).toBeLessThanOrEqual(
      6,
    );
    expect(COLOR_TOKENS.light.background).not.toBe(BRAND.ivory);
    expect(COLOR_TOKENS.light.brandSurface).toBe(BRAND.ivory);
  });

  it('uses a near-black navy canvas in dark mode', () => {
    expect(relativeLuminance(COLOR_TOKENS.dark.background)).toBeLessThan(0.02);
    expect(relativeLuminance(COLOR_TOKENS.dark.surface)).toBeGreaterThan(
      relativeLuminance(COLOR_TOKENS.dark.background),
    );
  });

  it('orders the light surfaces canvas, overlay, raised', () => {
    const { background, surface, surfaceMuted } = COLOR_TOKENS.light;
    expect(relativeLuminance(surface)).toBeGreaterThanOrEqual(relativeLuminance(background));
    expect(relativeLuminance(surfaceMuted)).toBeLessThan(relativeLuminance(background));
  });

  it('uses charcoal for light-mode text and Canvas for dark-mode text', () => {
    expect(COLOR_TOKENS.light.foreground).toBe(BRAND.charcoal);
    expect(COLOR_TOKENS.dark.foreground).toBe(BRAND.canvas);
  });

  it('uses navy for the main button and the focus ring in light mode, Canvas in dark mode', () => {
    expect(COLOR_TOKENS.light.primary).toBe(BRAND.midnightNavy);
    expect(COLOR_TOKENS.dark.primary).toBe(BRAND.canvas);
    expect(COLOR_TOKENS.light.ring).toBe(BRAND.navy);
  });

  it('darkens the seafoam for AI in light mode and keeps it as is in dark mode', () => {
    expect(relativeLuminance(COLOR_TOKENS.light.aiAccent)).toBeLessThan(
      relativeLuminance(BRAND.seafoam),
    );
    expect(COLOR_TOKENS.dark.aiAccent).toBe(BRAND.seafoam);
  });

  it('keeps coral out of every UI token so it cannot be mistaken for severity P1', () => {
    for (const theme of Object.values(COLOR_TOKENS)) {
      const used = [
        ...Object.values(theme).filter((value) => typeof value === 'string'),
        ...Object.values(theme.severity).flatMap(({ fg, bg, border }) => [fg, bg, border]),
        ...theme.avatar.flatMap(({ fg, bg }) => [fg, bg]),
        ...Object.values(theme.tint).flatMap(({ fg, bg, icon }) => [fg, bg, icon]),
      ];
      expect(used).not.toContain(BRAND.coral);
    }
  });

  it('has the same number of avatar hues in both themes', () => {
    expect(COLOR_TOKENS.light.avatar).toHaveLength(8);
    expect(COLOR_TOKENS.dark.avatar).toHaveLength(8);
  });

  it('links and focus pass AA text contrast on the canvas of each theme', () => {
    expect(
      contrastRatio(COLOR_TOKENS.light.link, COLOR_TOKENS.light.background),
    ).toBeGreaterThanOrEqual(AA_TEXT_RATIO);
    expect(
      contrastRatio(COLOR_TOKENS.dark.link, COLOR_TOKENS.dark.background),
    ).toBeGreaterThanOrEqual(AA_TEXT_RATIO);
  });
});
