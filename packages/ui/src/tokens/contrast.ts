import { type ColorTokens, COLOR_TOKENS, THEME_NAMES, TINT_IDS, type ThemeName } from './colors.js';
import { SEVERITY_IDS } from './severity.js';

/** WCAG 2.x AA thresholds (PRD section 10). */
export const AA_TEXT_RATIO = 4.5;
export const AA_UI_RATIO = 3;

const HEX_COLOR = /^#([0-9a-f]{6})$/i;

/** Parses `#rrggbb`. Anything else (rgb(), named colours, alpha) throws so a typo cannot pass. */
export function parseHexColor(value: string): readonly [number, number, number] {
  const match = HEX_COLOR.exec(value);
  const digits = match?.[1];
  if (digits === undefined) throw new Error(`Expected a #rrggbb colour, got "${value}"`);
  const channel = (start: number) => parseInt(digits.slice(start, start + 2), 16);
  return [channel(0), channel(2), channel(4)];
}

function linearise(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHexColor(hex);
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/** WCAG contrast ratio, 1 to 21. Symmetric: argument order does not matter. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface ContrastRequirement {
  readonly name: string;
  readonly foreground: string;
  readonly background: string;
  readonly minimum: number;
  readonly kind: 'text' | 'ui';
}

/** The ordinal ramp's lightest step must reach this against the surface (data-viz ordinal floor). */
export const CHART_ORDINAL_RATIO = 2;

const CHART_SURFACES = ['background', 'surface'] as const;

const SURFACES = ['background', 'surface', 'surfaceMuted', 'primarySubtle', 'aiSubtle'] as const;

/**
 * Every colour pair the UI is allowed to draw, with the AA ratio it must reach. Add a pair here
 * when a component starts to use a new combination. The test fails if any pair is too low.
 */
export function contrastRequirements(
  theme: ThemeName,
  tokens: ColorTokens = COLOR_TOKENS[theme],
): ContrastRequirement[] {
  const text = (name: string, foreground: string, background: string): ContrastRequirement => ({
    name: `${theme}: ${name}`,
    foreground,
    background,
    minimum: AA_TEXT_RATIO,
    kind: 'text',
  });
  const ui = (name: string, foreground: string, background: string): ContrastRequirement => ({
    name: `${theme}: ${name}`,
    foreground,
    background,
    minimum: AA_UI_RATIO,
    kind: 'ui',
  });

  const requirements: ContrastRequirement[] = [];
  for (const surface of SURFACES) {
    requirements.push(
      text(`foreground on ${surface}`, tokens.foreground, tokens[surface]),
      text(`mutedForeground on ${surface}`, tokens.mutedForeground, tokens[surface]),
      text(`link on ${surface}`, tokens.link, tokens[surface]),
      ui(`primary fill on ${surface}`, tokens.primary, tokens[surface]),
      text(`danger on ${surface}`, tokens.danger, tokens[surface]),
      text(`success on ${surface}`, tokens.success, tokens[surface]),
      text(`aiAccent on ${surface}`, tokens.aiAccent, tokens[surface]),
      ui(`borderStrong on ${surface}`, tokens.borderStrong, tokens[surface]),
      ui(`ring on ${surface}`, tokens.ring, tokens[surface]),
    );
  }
  requirements.push(text('primaryForeground on primary', tokens.primaryForeground, tokens.primary));

  // The brand moment ground (login, portal header) carries its own text and controls.
  requirements.push(
    text('brandForeground on brandSurface', tokens.brandForeground, tokens.brandSurface),
    text('mutedForeground on brandSurface', tokens.mutedForeground, tokens.brandSurface),
    text('link on brandSurface', tokens.link, tokens.brandSurface),
    text('danger on brandSurface', tokens.danger, tokens.brandSurface),
    ui('primary fill on brandSurface', tokens.primary, tokens.brandSurface),
    ui('borderStrong on brandSurface', tokens.borderStrong, tokens.brandSurface),
    ui('ring on brandSurface', tokens.ring, tokens.brandSurface),
  );

  // Initials avatars: every hue must keep its letters readable.
  tokens.avatar.forEach((colors, index) => {
    requirements.push(text(`avatar ${String(index + 1)} fg on bg`, colors.fg, colors.bg));
  });

  // Soft tinted chips (priority, SLA, AI state, channel, intent): dark text and a full-colour icon
  // on the tint, and the same text and icon when they stand alone on a surface (section headers).
  for (const id of TINT_IDS) {
    const colors = tokens.tint[id];
    requirements.push(
      text(`tint ${id} fg on bg`, colors.fg, colors.bg),
      ui(`tint ${id} icon on bg`, colors.icon, colors.bg),
    );
    for (const surface of SURFACES) {
      requirements.push(
        text(`tint ${id} fg on ${surface}`, colors.fg, tokens[surface]),
        ui(`tint ${id} icon on ${surface}`, colors.icon, tokens[surface]),
      );
    }
  }

  for (const id of SEVERITY_IDS) {
    const colors = tokens.severity[id];
    requirements.push(
      text(`severity ${id} fg on bg`, colors.fg, colors.bg),
      ui(`severity ${id} border on bg`, colors.border, colors.bg),
    );
    // Outlined pills (every level but P1) have no fill, so the text sits on the surface itself.
    for (const surface of SURFACES) {
      requirements.push(text(`severity ${id} fg on ${surface}`, colors.fg, tokens[surface]));
      requirements.push(ui(`severity ${id} border on ${surface}`, colors.border, tokens[surface]));
    }
  }

  // Chart marks sit on the Canvas (sections) and the overlay surface (cards, tooltips). The series
  // mark needs 3:1; an ordinal step may sit lower, to 2:1 (data-viz ordinal floor), because every
  // bucket is labelled and has a table view.
  for (const surface of CHART_SURFACES) {
    requirements.push(ui(`chart series on ${surface}`, tokens.chart.series, tokens[surface]));
    tokens.chart.ordinal.forEach((value, index) => {
      requirements.push({
        name: `${theme}: chart ordinal ${String(index + 1)} on ${surface}`,
        foreground: value,
        background: tokens[surface],
        minimum: CHART_ORDINAL_RATIO,
        kind: 'ui',
      });
    });
  }
  return requirements;
}

export function allContrastRequirements(): ContrastRequirement[] {
  return THEME_NAMES.flatMap((theme) => contrastRequirements(theme));
}
