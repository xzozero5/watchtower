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

/**
 * Soft tint families for chips (docs/design/friendly-polish.md section 3). A chip is a 12-20 %
 * tint of the hue behind a full-colour icon and dark text. Red is for P1 and breaches only and
 * coral is not here at all (docs/brand/README.md).
 */
export const TINT_IDS = [
  'red',
  'amber',
  'sky',
  'slate',
  'green',
  'teal',
  'violet',
  'blue',
  'indigo',
  'purple',
  'pink',
  'orange',
] as const;

export type TintId = (typeof TINT_IDS)[number];

export interface TintColors {
  /** Chip text, drawn on `bg`. */
  readonly fg: string;
  /** The tinted chip ground. */
  readonly bg: string;
  /** The icon, in the full hue. Meets 3:1 on `bg` and on every surface. */
  readonly icon: string;
}

/** Number of steps of the ordinal (ordered buckets) ramp. */
export const CHART_ORDINAL_STEPS = 4;

/**
 * Colours of chart marks. Marks only: text in a chart uses the text tokens, never these. Both were
 * run through the data-viz validator (`validate_palette.js`) against the Canvas and the overlay
 * surface in their own mode.
 */
export interface ChartColors {
  /** The one categorical series colour (slot 1, blue). Meets 3:1 on the surfaces a chart sits on. */
  readonly series: string;
  /**
   * One-hue ramp for ordered buckets such as age bands, first step to last. Light mode goes light to
   * dark, dark mode dark to light: the last step is always the one nearest the reader's attention.
   * The step nearest the surface keeps 2:1 (the validator's ordinal floor); every bucket is also
   * labelled and in the table view.
   */
  readonly ordinal: readonly [string, string, string, string];
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
  /** A faint teal wash behind the AI brief and draft. Text on it is `foreground`. */
  readonly aiSubtle: string;
  /** Brand moment ground (login, portal header): warm ivory. Not the app background. */
  readonly brandSurface: string;
  /** Text on `brandSurface`. */
  readonly brandForeground: string;
  /** Backdrop behind modal dialogs such as the command palette. */
  readonly scrim: string;
  readonly severity: Readonly<Record<SeverityId, SeverityColors>>;
  /** Muted hues for initials avatars, drawn from a stable id. Initials text passes AA on every one. */
  readonly avatar: readonly AvatarColors[];
  /** Soft tints for priority, SLA, AI state, channel and intent chips. */
  readonly tint: Readonly<Record<TintId, TintColors>>;
  /** Data-viz marks (docs/design/less-text-ai-assistant.md, the dashboard charts). */
  readonly chart: ChartColors;
}

/**
 * Corner radii (docs/design/friendly-polish.md section 2): controls 10 px, cards, the AI brief and
 * popovers 16 px, dialogs 20 px, pills, avatars and icon buttons fully round. They do not change
 * with the theme, so they live outside `ColorTokens`.
 */
export const RADIUS_TOKENS = {
  control: '10px',
  card: '16px',
  dialog: '20px',
} as const;

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
    aiSubtle: '#f0f9f7',
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
    tint: {
      red: { bg: '#fde7e7', fg: '#991b1b', icon: '#dc2626' },
      amber: { bg: '#fef2df', fg: '#92400e', icon: '#b45309' },
      sky: { bg: '#e0f3fc', fg: '#075985', icon: '#0284c7' },
      slate: { bg: '#ebedf0', fg: '#334155', icon: '#64748b' },
      green: { bg: '#e2f7ea', fg: '#166534', icon: '#15803d' },
      teal: { bg: '#e0f6f3', fg: '#115e59', icon: '#0f766e' },
      violet: { bg: '#f0eafe', fg: '#5b21b6', icon: '#7c3aed' },
      blue: { bg: '#e6effe', fg: '#1e40af', icon: '#2563eb' },
      indigo: { bg: '#ebebfd', fg: '#3730a3', icon: '#4f46e5' },
      purple: { bg: '#f4e9fe', fg: '#6b21a8', icon: '#9333ea' },
      pink: { bg: '#fde7f2', fg: '#9d174d', icon: '#db2777' },
      orange: { bg: '#feede1', fg: '#9a3412', icon: '#c2410c' },
    },
    chart: { series: '#2a78d6', ordinal: ['#86b6ef', '#3987e5', '#1c5cab', '#104281'] },
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
    aiSubtle: '#142428',
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
    tint: {
      red: { bg: '#41232b', fg: '#fecaca', icon: '#f87171' },
      amber: { bg: '#433520', fg: '#fde68a', icon: '#fbbf24' },
      sky: { bg: '#14374c', fg: '#bae6fd', icon: '#38bdf8' },
      slate: { bg: '#262d39', fg: '#e2e8f0', icon: '#94a3b8' },
      green: { bg: '#183d30', fg: '#bbf7d0', icon: '#4ade80' },
      teal: { bg: '#163a3f', fg: '#99f6e4', icon: '#2dd4bf' },
      violet: { bg: '#2d284f', fg: '#ddd6fe', icon: '#a78bfa' },
      blue: { bg: '#1d304f', fg: '#bfdbfe', icon: '#60a5fa' },
      indigo: { bg: '#252a4e', fg: '#c7d2fe', icon: '#818cf8' },
      purple: { bg: '#33274f', fg: '#e9d5ff', icon: '#c084fc' },
      pink: { bg: '#41243c', fg: '#fbcfe8', icon: '#f472b6' },
      orange: { bg: '#432d22', fg: '#fed7aa', icon: '#fb923c' },
    },
    chart: { series: '#3987e5', ordinal: ['#184f95', '#256abf', '#3987e5', '#6da7ec'] },
  },
};
