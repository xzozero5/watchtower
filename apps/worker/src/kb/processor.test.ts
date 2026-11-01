import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';
import { testEnv } from '../testing/support.js';
import { chunkOptionsFrom } from './processor.js';

describe('chunkOptionsFrom', () => {
  it('uses the shared defaults when the environment says nothing', () => {
    expect(chunkOptionsFrom(loadConfig(testEnv()))).toEqual({
      targetChars: 900,
      maxChars: 1400,
      minChars: 120,
      overlapChars: 120,
    });
  });

  it('takes the sizes from the environment', () => {
    const tuned = loadConfig(testEnv({ KB_CHUNK_TARGET_CHARS: '500', KB_CHUNK_MAX_CHARS: '700' }));
    expect(chunkOptionsFrom(tuned)).toMatchObject({ targetChars: 500, maxChars: 700 });
  });

  it('refuses a single size out of bounds when the config loads', () => {
    expect(() => loadConfig(testEnv({ KB_CHUNK_TARGET_CHARS: '10' }))).toThrow(
      /KB_CHUNK_TARGET_CHARS/,
    );
  });

  it('refuses sizes that are valid one by one and wrong together, at boot', () => {
    // A maximum below the target.
    const skewed = loadConfig(testEnv({ KB_CHUNK_MAX_CHARS: '300' }));
    expect(() => chunkOptionsFrom(skewed)).toThrow(/Chunk sizes/);
  });
});
