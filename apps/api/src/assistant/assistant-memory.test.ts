import { ASSISTANT_MEMORY_LIMITS } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { clipMemoryBody } from './assistant-memory.js';

describe('clipMemoryBody', () => {
  it('keeps a short sentence as it is', () => {
    expect(clipMemoryBody('  The queue is calm.  ')).toBe('The queue is calm.');
  });

  it('cuts to the limit', () => {
    const long = 'word '.repeat(200);
    const clipped = clipMemoryBody(long);
    expect(clipped.length).toBeLessThanOrEqual(ASSISTANT_MEMORY_LIMITS.maxBodyChars);
    expect(clipped.startsWith('word word')).toBe(true);
  });

  it('never leaves half a placeholder at the cut', () => {
    const text = `${'a'.repeat(ASSISTANT_MEMORY_LIMITS.maxBodyChars - 4)} [PERSON_12] wrote back`;
    const clipped = clipMemoryBody(text);
    expect(clipped).not.toMatch(/\[[A-Za-z_0-9]*$/);
    expect(clipped.length).toBeLessThanOrEqual(ASSISTANT_MEMORY_LIMITS.maxBodyChars);
    // A placeholder that fits whole is kept.
    expect(clipMemoryBody('Ask [PERSON_1] about it.')).toBe('Ask [PERSON_1] about it.');
  });
});
