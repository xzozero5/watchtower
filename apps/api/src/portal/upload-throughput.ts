/**
 * A minimum speed for a body that is being received (T-154). An idle timeout alone is beaten by a
 * sender that sends one byte every few seconds, and a fixed deadline for the whole body either cuts a
 * real person on a slow link or leaves a slot to a trickle for as long as the deadline is. This asks
 * for a rate instead: over every `windowMs` at least `minBytesPerSecond` must arrive, or the sender is
 * too slow and the caller drops the connection and frees the slot.
 *
 * Pure bookkeeping, no timers: the caller feeds it the byte count and the time at each check, so a
 * test needs no clock.
 */
export class ThroughputGuard {
  private lastBytes: number;
  private lastAt: number;

  constructor(
    private readonly minBytesPerSecond: number,
    startBytes: number,
    startAt: number,
  ) {
    this.lastBytes = startBytes;
    this.lastAt = startAt;
  }

  /** True while the sender keeps up since the last check. Call it once per window. */
  keepsUp(bytes: number, at: number): boolean {
    const seconds = Math.max((at - this.lastAt) / 1000, 0.001);
    const rate = (bytes - this.lastBytes) / seconds;
    this.lastBytes = bytes;
    this.lastAt = at;
    return rate >= this.minBytesPerSecond;
  }
}
