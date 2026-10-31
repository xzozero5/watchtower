export const DENSITIES = ['comfortable', 'compact'] as const;

export type Density = (typeof DENSITIES)[number];

export const DEFAULT_DENSITY: Density = 'comfortable';

export interface DensityTokens {
  /**
   * Root font size as a percentage of the browser default (16px), so a user who raised the
   * browser font size still gets a larger UI. 93.75% is 15px, 87.5% is 14px: the PRD section 10
   * base of 14-15px `[ASSUMED]`.
   */
  readonly fontScale: string;
  /** Height of a queue or list row. */
  readonly rowHeight: string;
  /** Height of buttons and inputs. Stays at or above the 24px WCAG 2.2 target size. */
  readonly controlHeight: string;
  /** Padding inside a pane. */
  readonly panePadding: string;
  /** Gap between stacked items. */
  readonly gap: string;
}

export const DENSITY_TOKENS: Readonly<Record<Density, DensityTokens>> = {
  comfortable: {
    fontScale: '93.75%',
    rowHeight: '3.5rem',
    controlHeight: '2.5rem',
    panePadding: '1rem',
    gap: '0.75rem',
  },
  compact: {
    fontScale: '87.5%',
    rowHeight: '2.5rem',
    controlHeight: '2rem',
    panePadding: '0.625rem',
    gap: '0.375rem',
  },
};

/** Animation timing. Zeroed under prefers-reduced-motion in the generated CSS. */
export const MOTION_TOKENS = {
  durationFast: '120ms',
  durationBase: '200ms',
} as const;
