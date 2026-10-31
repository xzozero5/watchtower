import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// R-11: the adapters depend on SDK internals (express-mode header swap, edge entries, the
// absence of import-time side effects), so a range could silently change behaviour. Move these
// pins deliberately, together with a re-run of vertex.test.ts and import-safety.test.ts.
describe('AI SDK pins', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { dependencies: Record<string, string> };

  it.each(['ai', '@ai-sdk/anthropic', '@ai-sdk/google-vertex'])(
    '%s is an exact version',
    (name) => {
      expect(manifest.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    },
  );
});
