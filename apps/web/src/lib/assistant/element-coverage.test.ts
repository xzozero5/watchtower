import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSIGHT_ELEMENTS, INSIGHT_ELEMENT_KEYS } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : entry.name.endsWith('.tsx') && !entry.name.includes('.test.')
        ? [readFileSync(path, 'utf8')]
        : [];
  });
}

describe('ADR-029 element control inventory', () => {
  it('mounts every non-X registry key in a real component and never an X key', () => {
    const mounted = new Set(
      sources(join(process.cwd(), 'src/components')).flatMap((source) =>
        [...source.matchAll(/<AskAiElement\s+element="([^"]+)"/g)].map((match) => match[1]),
      ),
    );
    const expected = INSIGHT_ELEMENT_KEYS.filter((key) => INSIGHT_ELEMENTS[key].mode !== 'X');
    expect([...mounted].sort()).toEqual([...expected].sort());
  });
});
