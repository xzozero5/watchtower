import { type ColorTokens, COLOR_TOKENS, THEME_NAMES, type ThemeName } from './colors.js';
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

const SURFACES = ['background', 'surface', 'surfaceMuted'] as const;

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
      ui(`borderStrong on ${surface}`, tokens.borderStrong, tokens[surface]),
      ui(`ring on ${surface}`, tokens.ring, tokens[surface]),
    );
  }
  requirements.push(text('primaryForeground on primary', tokens.primaryForeground, tokens.primary));

  for (const id of SEVERITY_IDS) {
    const colors = tokens.severity[id];
    requirements.push(
      text(`severity ${id} fg on bg`, colors.fg, colors.bg),
      ui(`severity ${id} border on surface`, colors.border, tokens.surface),
      ui(`severity ${id} border on background`, colors.border, tokens.background),
      ui(`severity ${id} border on bg`, colors.border, colors.bg),
    );
  }
  return requirements;
}

export function allContrastRequirements(): ContrastRequirement[] {
  return THEME_NAMES.flatMap((theme) => contrastRequirements(theme));
}
