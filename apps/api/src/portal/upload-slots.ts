/**
 * Bounds how many multipart uploads this process reads at once, and how many one client address may
 * have in flight (T-140 security review P1-1). A multipart body is buffered in memory before any
 * proof or token is checked, so without this a few slow or concurrent large requests could exhaust
 * the process. The slot is taken before the first byte of the body is read and given back when the
 * response is finished or the connection closes, whichever comes first.
 *
 * In-memory and per process: with several api instances each has its own budget, which is what
 * protects each instance's memory. `[ASSUMED]` 3 in flight in total, 1 per address.
 */
export class UploadSlots {
  private total = 0;
  private readonly perAddress = new Map<string, number>();

  constructor(
    private readonly maxTotal = 3,
    private readonly maxPerAddress = 1,
  ) {}

  /** A function that gives the slot back (safe to call more than once), or null when none is free. */
  acquire(address: string): (() => void) | null {
    const mine = this.perAddress.get(address) ?? 0;
    if (this.total >= this.maxTotal || mine >= this.maxPerAddress) return null;
    this.total += 1;
    this.perAddress.set(address, mine + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const left = (this.perAddress.get(address) ?? 1) - 1;
      if (left <= 0) this.perAddress.delete(address);
      else this.perAddress.set(address, left);
    };
  }

  /** For tests and metrics. */
  get inFlight(): number {
    return this.total;
  }
}
