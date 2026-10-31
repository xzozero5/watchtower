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

/** Number of avatar hues. A stable id hashes onto one of them. */
export const AVATAR_HUE_COUNT = 8;

export interface AvatarColors {
  /** Initials colour, drawn on `bg`. */
  readonly fg: string;
  readonly bg: string;
}

export interface ColorTokens {
  /**
   * Canvas: the neutral ground behind the panes. Panes have no card of their own, they sit on it
   * and are separated by 1px hairlines (docs/design/ui-refresh-2026-11.md section 3).
   */
  readonly background: string;
  /** Overlay surface: popovers, menus, dialogs, toasts and form fields. Only overlays get a shadow. */
  readonly surface: string;
  /** Raised surface: hovered rows, customer bubbles, code blocks, the note composer. */
  readonly surfaceMuted: string;
  readonly foreground: string;
  readonly mutedForeground: string;
  /** Hairlines between panes and rows. Not for controls: use `borderStrong` for anything interactive. */
  readonly border: string;
  /** Input and button outlines. Meets the 3:1 non-text contrast rule. */
  readonly borderStrong: string;
  /** Main button fill and selected indicator: navy in light mode, an inverted Canvas tone in dark. */
  readonly primary: string;
  readonly primaryForeground: string;
  /** Navy tint: the selected row and staff message bubbles. Text on it is `foreground`. */
  readonly primarySubtle: string;
  /** Link text. `[ASSUMED]` sky blue that reaches 4.5:1 for text. See the note below. */
  readonly link: string;
  /** Keyboard focus ring: navy in light mode, a light tone in dark. */
  readonly ring: string;
  readonly danger: string;
  readonly success: string;
  /** AI only: the seafoam from the logo, darkened until it reads as text. Never used for anything else. */
  readonly aiAccent: string;
  /** Brand moment ground (login, portal header): warm ivory. Not the app background. */
  readonly brandSurface: string;
  /** Text on `brandSurface`. */
  readonly brandForeground: string;
  /** Backdrop behind modal dialogs such as the command palette. */
  readonly scrim: string;
  readonly severity: Readonly<Record<SeverityId, SeverityColors>>;
  /** Muted hues for initials avatars, drawn from a stable id. Initials text passes AA on every one. */
  readonly avatar: readonly AvatarColors[];
}

/**
 * Brand palette, measured from the master PNG (docs/brand/README.md, confirmed 2026-10-31):
 * Midnight Navy `#0F172A` / `#1D2739`, Charcoal wordmark `#363839`, Ivory `#F7F0D4`, Seafoam
 * `#80CFC0`. The app itself is neutral (docs/design/ui-refresh-2026-11.md): a near-white canvas in
 * light mode, a near-black navy one in dark mode, navy for the main button and the focus ring, and
 * colour only where it means something (severity, SLA, AI).
 *
 * Link colour `[ASSUMED]`: the palette has no ocean blue, so links are sky blues chosen only
 * because they pass WCAG AA (`#0369a1` on light, `#38bdf8` on dark). Replace them when the owner
 * picks an accent.
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
    background: '#fafafa',
    surface: '#ffffff',
    surfaceMuted: '#f2f2f3',
    foreground: '#363839',
    mutedForeground: '#5b6064',
    border: '#e4e4e7',
    borderStrong: '#7c7c86',
    primary: '#0f172a',
    primaryForeground: '#f7f7ed',
    primarySubtle: '#e8ebf1',
    link: '#0369a1',
    ring: '#1d2739',
    danger: '#b91c1c',
    success: '#166534',
    aiAccent: '#0f766e',
    brandSurface: '#f7f0d4',
    brandForeground: '#363839',
    scrim: 'rgb(15 23 42 / 0.55)',
    severity: {
      p1: { fg: '#991b1b', bg: '#fee2e2', border: '#b91c1c' },
      p2: { fg: '#9a3412', bg: '#ffedd5', border: '#c2410c' },
      p3: { fg: '#854d0e', bg: '#fef9c3', border: '#a16207' },
      p4: { fg: '#075985', bg: '#e0f2fe', border: '#0369a1' },
    },
    avatar: [
      { bg: '#e0e7f5', fg: '#2b3f6b' },
      { bg: '#d5ece7', fg: '#1f5c52' },
      { bg: '#e0ebd2', fg: '#3d5a1c' },
      { bg: '#f2e6c9', fg: '#6b4b0e' },
      { bg: '#f3dde0', fg: '#7a2e3a' },
      { bg: '#e6def2', fg: '#4a3478' },
      { bg: '#f0dfd2', fg: '#6e3b1f' },
      { bg: '#dde3e8', fg: '#364754' },
    ],
  },
  dark: {
    background: '#0e1219',
    surface: '#161b25',
    surfaceMuted: '#1c2230',
    foreground: '#f7f7ed',
    mutedForeground: '#9ca6b6',
    border: '#262d3a',
    borderStrong: '#7a8599',
    primary: '#f7f7ed',
    primaryForeground: '#0f172a',
    primarySubtle: '#212b41',
    link: '#38bdf8',
    ring: '#7dd3fc',
    danger: '#fca5a5',
    success: '#4ade80',
    aiAccent: '#80cfc0',
    brandSurface: '#161b25',
    brandForeground: '#f7f7ed',
    scrim: 'rgb(2 6 23 / 0.72)',
    severity: {
      p1: { fg: '#fecaca', bg: '#450a0a', border: '#f87171' },
      p2: { fg: '#fed7aa', bg: '#431407', border: '#fb923c' },
      p3: { fg: '#fde68a', bg: '#422006', border: '#facc15' },
      p4: { fg: '#bae6fd', bg: '#082f49', border: '#38bdf8' },
    },
    avatar: [
      { bg: '#25314d', fg: '#c3d0f0' },
      { bg: '#1c3b37', fg: '#a7dcd2' },
      { bg: '#2c3a1f', fg: '#c6dca6' },
      { bg: '#43361a', fg: '#ecd7a0' },
      { bg: '#472a30', fg: '#f0c3ca' },
      { bg: '#33284a', fg: '#d3c3ee' },
      { bg: '#45301f', fg: '#eac9b0' },
      { bg: '#2b3640', fg: '#c6d2dc' },
    ],
  },
};
