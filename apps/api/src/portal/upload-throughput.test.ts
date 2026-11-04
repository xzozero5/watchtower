import { describe, expect, it } from 'vitest';

import { ThroughputGuard } from './upload-throughput.js';

describe('ThroughputGuard', () => {
  it('keeps a sender that sends at least the minimum in every window', () => {
    const guard = new ThroughputGuard(32 * 1024, 0, 0);
    expect(guard.keepsUp(100 * 1024, 2000)).toBe(true); // 50 KB/s
    expect(guard.keepsUp(180 * 1024, 4000)).toBe(true); // 40 KB/s
  });

  it('drops a sender that trickles, even if it never goes quiet', () => {
    const guard = new ThroughputGuard(32 * 1024, 0, 0);
    // One byte a second: an idle timeout never fires, the rate does.
    expect(guard.keepsUp(2, 2000)).toBe(false);
  });

  it('judges each window on its own: a fast start does not pay for a slow stretch', () => {
    const guard = new ThroughputGuard(32 * 1024, 0, 0);
    expect(guard.keepsUp(5 * 1024 * 1024, 2000)).toBe(true);
    expect(guard.keepsUp(5 * 1024 * 1024 + 10, 4000)).toBe(false);
  });

  it('counts from where the connection already was (a kept-alive socket has read bytes before)', () => {
    const guard = new ThroughputGuard(1000, 9_000_000, 0);
    expect(guard.keepsUp(9_000_000 + 5000, 1000)).toBe(true);
  });
});
