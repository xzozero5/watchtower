import type { SeverityId } from './severity.js';

export const THEME_NAMES = ['light', 'dark'] as const;

export type ThemeName = (typeof THEME_NAMES)[number];

export interface SeverityColors {
  /** Text and icon colour, drawn on `bg`. */
  readonly fg: string;
  readonly bg: string;
  /** Outline of the badge, drawn against the page surface. */
  readonly border: string;
}

export interface ColorTokens {
  /** Page background behind the panes. */
  readonly background: string;
  /** Pane and card surface. */
  readonly surface: string;
  /** Hovered rows, code blocks, secondary surfaces. */
  readonly surfaceMuted: string;
  readonly foreground: string;
  readonly mutedForeground: string;
  /** Decorative separators. Not for controls: use `borderStrong` for anything interactive. */
  readonly border: string;
  /** Input and button outlines. Meets the 3:1 non-text contrast rule. */
  readonly borderStrong: string;
  /** Main button fill and selected rows: navy in light mode, an inverted Canvas tone in dark. */
  readonly primary: string;
  readonly primaryForeground: string;
  /** Link text. `[ASSUMED]` sky blue that reaches 4.5:1 for text. See the note below. */
  readonly link: string;
  /** Keyboard focus ring. Same hue as `link`. */
  readonly ring: string;
  readonly danger: string;
  readonly success: string;
  /** Backdrop behind modal dialogs such as the command palette. */
  readonly scrim: string;
  readonly severity: Readonly<Record<SeverityId, SeverityColors>>;
}

/**
 * Brand palette, measured from the master PNG (docs/brand/README.md, confirmed 2026-10-31):
 * Midnight Navy `#0F172A` / `#1E293B`, Charcoal wordmark `#363839`, Canvas cream `#F7F7ED`.
 * Light mode sits on Canvas with charcoal text and navy buttons. Dark mode sits on Midnight Navy
 * with Canvas text and an inverted (Canvas) main button.
 *
 * Link and focus colour `[ASSUMED]`: the palette no longer has an ocean blue, so these are sky
 * blues chosen only because they pass WCAG AA (`#0369a1` on light, `#38bdf8` on dark). Replace
 * them when the owner picks an accent.
 *
 * Brand Coral `#E5594A` is deliberately not a UI token. It belongs to the logo mark. A coral
 * button would read like severity P1 and break alert discipline (PRD section 10), so buttons are
 * navy and only severity uses red.
 *
 * Every foreground and background pair is checked against WCAG 2.x AA in contrast.test.ts, so a
 * change that lowers a ratio fails the test.
 */
export const COLOR_TOKENS: Readonly<Record<ThemeName, ColorTokens>> = {
  light: {
    background: '#f7f7ed',
    surface: '#ffffff',
    surfaceMuted: '#ebebde',
    foreground: '#363839',
    mutedForeground: '#4f5457',
    border: '#dcdccf',
    borderStrong: '#6b7075',
    primary: '#0f172a',
    primaryForeground: '#f7f7ed',
    link: '#0369a1',
    ring: '#0369a1',
    danger: '#b91c1c',
    success: '#166534',
    scrim: 'rgb(15 23 42 / 0.55)',
    severity: {
      p1: { fg: '#991b1b', bg: '#fee2e2', border: '#b91c1c' },
      p2: { fg: '#9a3412', bg: '#ffedd5', border: '#c2410c' },
      p3: { fg: '#854d0e', bg: '#fef9c3', border: '#a16207' },
      p4: { fg: '#075985', bg: '#e0f2fe', border: '#0369a1' },
    },
  },
  dark: {
    background: '#0f172a',
    surface: '#1e293b',
    surfaceMuted: '#2a3850',
    foreground: '#f7f7ed',
    mutedForeground: '#b4bdcc',
    border: '#334155',
    borderStrong: '#94a3b8',
    primary: '#f7f7ed',
    primaryForeground: '#0f172a',
    link: '#38bdf8',
    ring: '#38bdf8',
    danger: '#fca5a5',
    success: '#4ade80',
    scrim: 'rgb(2 6 23 / 0.72)',
    severity: {
      p1: { fg: '#fecaca', bg: '#450a0a', border: '#f87171' },
      p2: { fg: '#fed7aa', bg: '#431407', border: '#fb923c' },
      p3: { fg: '#fde68a', bg: '#422006', border: '#facc15' },
      p4: { fg: '#bae6fd', bg: '#082f49', border: '#38bdf8' },
    },
  },
};
