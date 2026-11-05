/**
 * Facts computed live are shared (ADR-029 section 9.3, C-11): callers that ask for the same key while it is being
 * computed wait for that one computation (single-flight, mandatory), and for `ttlMs` after it finishes they get
 * its result without a new one. A failure is shared with the callers that were waiting and then forgotten, so the
 * next call tries again. The map is bounded so that many different keys cannot grow it without end.
 */
export class SingleFlightCache<T> {
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly done = new Map<string, { readonly at: number; readonly value: T }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
    private readonly clock: () => number = Date.now,
  ) {}

  /** How many computations ran (for tests and metrics): not a promise of anything else. */
  computations = 0;

  async get(key: string, compute: () => Promise<T>): Promise<T> {
    const now = this.clock();
    const cached = this.done.get(key);
    if (cached !== undefined) {
      if (now - cached.at < this.ttlMs) return cached.value;
      this.done.delete(key);
    }
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;

    this.computations += 1;
    const promise = (async (): Promise<T> => {
      try {
        const value = await compute();
        this.remember(key, value);
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }

  private remember(key: string, value: T): void {
    const now = this.clock();
    if (this.done.size >= this.maxEntries) {
      for (const [other, entry] of this.done) {
        if (now - entry.at >= this.ttlMs) this.done.delete(other);
      }
      // Still full: drop the oldest (a Map keeps insertion order).
      while (this.done.size >= this.maxEntries) {
        const oldest = this.done.keys().next();
        if (oldest.done === true) break;
        this.done.delete(oldest.value);
      }
    }
    this.done.set(key, { at: now, value });
  }
}
