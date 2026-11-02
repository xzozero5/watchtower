import { describe, expect, it } from 'vitest';

import { COLOR_TOKENS, TINT_IDS } from './colors.js';
import { buildTailwindThemeCss, buildTokensCss, colorVariableNames } from './css.js';
import { DENSITY_TOKENS } from './density.js';
import { SEVERITY_IDS } from './severity.js';

/** Returns the body of the first block that starts with `selector`. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `selector ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    if (depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`Unclosed block for ${selector}`);
}

describe('buildTokensCss', () => {
  const css = buildTokensCss();

  it('defines light tokens on :root', () => {
    const root = block(css, ':root');
    expect(root).toContain(`--wt-color-background: ${COLOR_TOKENS.light.background};`);
    expect(root).toContain(`--wt-color-foreground: ${COLOR_TOKENS.light.foreground};`);
    expect(root).toContain('color-scheme: light;');
  });

  it('switches to dark with the OS unless the user chose light', () => {
    const media = block(css, '@media (prefers-color-scheme: dark)');
    expect(media).toContain(":root:not([data-theme='light'])");
    expect(media).toContain(`--wt-color-background: ${COLOR_TOKENS.dark.background};`);
  });

  it('lets an explicit data-theme="dark" override a light OS', () => {
    const dark = block(css, ":root[data-theme='dark']");
    expect(dark).toContain(`--wt-color-surface: ${COLOR_TOKENS.dark.surface};`);
    expect(dark).toContain('color-scheme: dark;');
  });

  it('writes every colour token in both themes, severity included', () => {
    const names = colorVariableNames();
    expect(names).toEqual(colorVariableNames('dark'));
    for (const id of SEVERITY_IDS) {
      for (const part of ['fg', 'bg', 'border']) {
        expect(names).toContain(`color-severity-${id}-${part}`);
      }
    }
    const dark = block(css, ":root[data-theme='dark']");
    for (const name of names) {
      expect(dark).toContain(`--wt-${name}:`);
    }
  });

  it('writes the AI accent, the brand ground and every avatar hue in both themes', () => {
    const dark = block(css, ":root[data-theme='dark']");
    for (const name of ['color-ai-accent', 'color-brand-surface', 'color-primary-subtle']) {
      expect(dark).toContain(`--wt-${name}:`);
      expect(block(css, ':root')).toContain(`--wt-${name}:`);
    }
    for (let hue = 1; hue <= 8; hue += 1) {
      expect(dark).toContain(`--wt-color-avatar-${String(hue)}-bg:`);
      expect(dark).toContain(`--wt-color-avatar-${String(hue)}-fg:`);
    }
  });

  it('writes every tint family in both themes and the three radii', () => {
    const dark = block(css, ":root[data-theme='dark']");
    for (const id of TINT_IDS) {
      for (const part of ['fg', 'bg', 'icon']) {
        expect(dark).toContain(`--wt-color-tint-${id}-${part}:`);
        expect(block(css, ':root')).toContain(`--wt-color-tint-${id}-${part}:`);
      }
    }
    expect(dark).toContain('--wt-color-ai-subtle:');
    const root = block(css, ':root');
    expect(root).toContain('--wt-radius-control: 12px;');
    expect(root).toContain('--wt-radius-inner: 14px;');
    expect(root).toContain('--wt-radius-card: 20px;');
    expect(root).toContain('--wt-radius-dialog: 20px;');
    expect(root).toContain('--wt-radius-app: 28px;');
  });

  it('writes the card, lift and app shadows per theme', () => {
    for (const name of ['shadow-card', 'shadow-lift', 'shadow-app']) {
      expect(block(css, ':root')).toContain(`--wt-${name}:`);
      expect(block(css, ":root[data-theme='dark']")).toContain(`--wt-${name}:`);
    }
  });

  it('sets a 14-15px base and a compact density', () => {
    const root = block(css, ':root');
    expect(root).toContain(`--wt-font-scale: ${DENSITY_TOKENS.comfortable.fontScale};`);
    expect(DENSITY_TOKENS.comfortable.fontScale).toBe('93.75%'); // 15px of 16px
    expect(DENSITY_TOKENS.compact.fontScale).toBe('87.5%'); // 14px of 16px
    const compact = block(css, ":root[data-density='compact']");
    expect(compact).toContain(`--wt-row-height: ${DENSITY_TOKENS.compact.rowHeight};`);
  });

  it('removes motion under prefers-reduced-motion', () => {
    const reduced = block(css, '@media (prefers-reduced-motion: reduce)');
    expect(reduced).toContain('--wt-motion-duration-fast: 0ms;');
    expect(reduced).toContain('--wt-motion-duration-base: 0ms;');
  });

  it('uses 32px controls and 40px rows when comfortable, 28px and 32px when compact', () => {
    // rem of the density's own base (15px comfortable, 14px compact), so the UI follows browser zoom.
    expect(parseFloat(DENSITY_TOKENS.comfortable.controlHeight) * 15).toBeCloseTo(32, 0);
    expect(parseFloat(DENSITY_TOKENS.comfortable.rowHeight) * 15).toBeCloseTo(40, 0);
    expect(parseFloat(DENSITY_TOKENS.compact.controlHeight) * 14).toBeCloseTo(28, 0);
    expect(parseFloat(DENSITY_TOKENS.compact.rowHeight) * 14).toBeCloseTo(32, 0);
  });

  it('writes the chart series colour and every ordinal step in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const scope = theme === 'dark' ? block(css, ":root[data-theme='dark']") : block(css, ':root');
      expect(scope).toContain(`--wt-color-chart-series: ${COLOR_TOKENS[theme].chart.series};`);
      COLOR_TOKENS[theme].chart.ordinal.forEach((value, index) => {
        expect(scope).toContain(`--wt-color-chart-ordinal-${String(index + 1)}: ${value};`);
      });
      for (const [channel, value] of Object.entries(COLOR_TOKENS[theme].chart.channel)) {
        expect(scope).toContain(`--wt-color-chart-${channel}: ${value};`);
      }
    }
  });

  it('contains no hard-coded colour outside the declared tokens', () => {
    const known = new Set<string>();
    for (const theme of Object.values(COLOR_TOKENS)) {
      for (const value of Object.values(theme)) {
        if (typeof value === 'string') known.add(value);
      }
      for (const id of SEVERITY_IDS) {
        known.add(theme.severity[id].fg).add(theme.severity[id].bg).add(theme.severity[id].border);
      }
      for (const { fg, bg } of theme.avatar) known.add(fg).add(bg);
      for (const { fg, bg, icon } of Object.values(theme.tint)) known.add(fg).add(bg).add(icon);
      known.add(theme.chart.series);
      for (const step of theme.chart.ordinal) known.add(step);
      for (const value of Object.values(theme.chart.channel)) known.add(value);
    }
    for (const [hex] of css.matchAll(/#[0-9a-f]{6}\b/gi)) {
      expect(known.has(hex)).toBe(true);
    }
  });
});

describe('buildTailwindThemeCss', () => {
  const css = buildTailwindThemeCss();

  it('maps utilities onto the variables', () => {
    expect(css).toContain('@theme inline {');
    expect(css).toContain('--color-surface-muted: var(--wt-color-surface-muted);');
    expect(css).toContain('--color-sev-p1-fg: var(--wt-color-severity-p1-fg);');
    expect(css).toContain('--spacing-row: var(--wt-row-height);');
  });

  it('declares only variables that tokens.css defines', () => {
    const defined = buildTokensCss();
    const referenced = [...css.matchAll(/var\((--wt-[a-z0-9-]+)\)/g)].map(
      (match) => match[1] ?? '',
    );
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(defined, name).toContain(`${name}:`);
    }
  });

  it('maps the type scale to 12, 13, 14, 16 and 20 px with Thai-safe line heights', () => {
    expect(css).toContain('--text-xs: 0.8rem;');
    expect(css).toContain('--text-xs--line-height: 1.5;');
    expect(css).toContain('--text-xl: 1.3333rem;');
  });

  it('rounds the default md, lg and xl steps to the control, card and dialog radii', () => {
    expect(css).toContain('--radius-md: var(--wt-radius-control);');
    expect(css).toContain('--radius-lg: var(--wt-radius-card);');
    expect(css).toContain('--radius-xl: var(--wt-radius-dialog);');
    expect(css).toContain('--color-tint-amber-bg: var(--wt-color-tint-amber-bg);');
  });

  it('pops a check mark with a duration that reduced motion sets to zero', () => {
    expect(css).toContain('--animate-check-pop: wt-check-pop var(--wt-motion-duration-base)');
    expect(css).toContain('@keyframes wt-check-pop');
  });

  it('exposes the AI accent and avatar colours as utilities and one overlay shadow', () => {
    expect(css).toContain('--color-ai-accent: var(--wt-color-ai-accent);');
    expect(css).toContain('--color-avatar-8-bg: var(--wt-color-avatar-8-bg);');
    expect(css).toContain('--shadow-overlay:');
  });

  it('lists Thai-capable fonts after the Latin one', () => {
    expect(css).toMatch(/--font-sans: 'Plus Jakarta Sans Variable', 'IBM Plex Sans Thai'/);
    expect(css).toMatch(/--font-mono: 'IBM Plex Mono'/);
  });

  it('adds the page title and hero number steps and the gradient grounds', () => {
    expect(css).toContain('--text-display: 2.2667rem;');
    expect(css).toContain('--text-hero: 3.4667rem;');
    for (const utility of ['bg-nav-active', 'bg-highlight', 'bg-backdrop']) {
      expect(css).toContain(`@utility ${utility} {`);
    }
  });
});
