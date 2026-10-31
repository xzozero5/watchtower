import { describe, expect, it } from 'vitest';

import { COLOR_TOKENS } from './colors.js';
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

  it('contains no hard-coded colour outside the declared tokens', () => {
    const known = new Set<string>();
    for (const theme of Object.values(COLOR_TOKENS)) {
      for (const value of Object.values(theme)) {
        if (typeof value === 'string') known.add(value);
      }
      for (const id of SEVERITY_IDS) {
        known.add(theme.severity[id].fg).add(theme.severity[id].bg).add(theme.severity[id].border);
      }
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

  it('lists Thai-capable fonts after the Latin one', () => {
    expect(css).toMatch(/--font-sans: 'Inter Variable', 'Noto Sans Thai Variable'/);
  });
});
