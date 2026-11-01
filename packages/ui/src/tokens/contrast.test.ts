import { describe, expect, it } from 'vitest';

import { COLOR_TOKENS, THEME_NAMES, TINT_IDS } from './colors.js';
import {
  AA_TEXT_RATIO,
  AA_UI_RATIO,
  allContrastRequirements,
  contrastRatio,
  contrastRequirements,
  parseHexColor,
} from './contrast.js';
import { SEVERITY_IDS } from './severity.js';

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for identical colours', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });

  it('does not depend on argument order', () => {
    expect(contrastRatio('#1d4ed8', '#ffffff')).toBe(contrastRatio('#ffffff', '#1d4ed8'));
  });

  // Reference values published with the WCAG 2.x definition.
  it('matches known reference ratios', () => {
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  it('rejects colours it cannot measure instead of guessing', () => {
    expect(() => parseHexColor('rgb(0 0 0 / 0.5)')).toThrow();
    expect(() => parseHexColor('#fff')).toThrow();
    expect(() => parseHexColor('red')).toThrow();
  });
});

describe('design token contrast (WCAG 2.x AA)', () => {
  it('uses the AA thresholds from the PRD: 4.5:1 text and 3:1 UI', () => {
    expect(AA_TEXT_RATIO).toBe(4.5);
    expect(AA_UI_RATIO).toBe(3);
  });

  for (const theme of THEME_NAMES) {
    describe(`${theme} theme`, () => {
      const requirements = contrastRequirements(theme);

      it('checks a meaningful number of pairs', () => {
        expect(requirements.length).toBeGreaterThan(35);
      });

      it.each(requirements.map((requirement) => [requirement.name, requirement] as const))(
        '%s',
        (_name, requirement) => {
          const ratio = contrastRatio(requirement.foreground, requirement.background);
          expect(ratio).toBeGreaterThanOrEqual(requirement.minimum);
        },
      );

      it('covers every tint family, text and icon, on its chip and on every surface', () => {
        for (const id of TINT_IDS) {
          expect(requirements.some((r) => r.name.includes(`tint ${id} fg on bg`))).toBe(true);
          expect(requirements.some((r) => r.name.includes(`tint ${id} icon on bg`))).toBe(true);
          expect(requirements.some((r) => r.name.includes(`tint ${id} icon on aiSubtle`))).toBe(
            true,
          );
        }
      });

      it('covers the AI wash behind the brief', () => {
        expect(requirements.some((r) => r.name.includes('aiAccent on aiSubtle'))).toBe(true);
        expect(requirements.some((r) => r.name.includes('foreground on aiSubtle'))).toBe(true);
      });

      it('covers every severity level', () => {
        for (const id of SEVERITY_IDS) {
          expect(requirements.some((r) => r.name.includes(`severity ${id} fg on bg`))).toBe(true);
        }
      });
    });
  }

  it('fails when a token drops below AA, so the test can actually catch a regression', () => {
    const weak = { ...COLOR_TOKENS.light, mutedForeground: '#9ca3af' };
    const failing = contrastRequirements('light', weak).filter(
      (r) => contrastRatio(r.foreground, r.background) < r.minimum,
    );
    expect(failing.length).toBeGreaterThan(0);
  });

  it('keeps light and dark in step', () => {
    expect(Object.keys(COLOR_TOKENS.dark)).toEqual(Object.keys(COLOR_TOKENS.light));
    expect(allContrastRequirements().length).toBe(
      contrastRequirements('light').length + contrastRequirements('dark').length,
    );
  });
});
