/**
 * Makes sure only one tab at a time renews the session (ADR-005: a refresh token works once, and
 * presenting a used one ends the whole session, so two tabs refreshing together would sign the user
 * out).
 *
 * Three layers:
 *  1. Within a tab, concurrent callers share one in-flight refresh (single-flight).
 *  2. Across tabs, a Web Lock (`navigator.locks`) serialises the actual `POST /v1/auth/refresh`.
 *  3. A timestamp in localStorage records the last successful refresh. A tab that waited for the
 *     lock and sees a refresh newer than its own failed request skips the call: the cookies are
 *     already new, so it only has to retry the request.
 */

export const REFRESH_LOCK_NAME = 'wt-session-refresh';
export const REFRESH_MARKER_KEY = 'wt-session-refreshed-at';

export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface RefreshMarkerStore {
  read(): number | null;
  write(at: number): void;
}

export type RefreshOutcome = 'refreshed' | 'already-refreshed';

export interface RefreshCoordinatorOptions {
  /** Performs the refresh call. Rejects when the session is over. */
  run: () => Promise<void>;
  /** Defaults to `navigator.locks` when the browser has it, otherwise no cross-tab lock. */
  locks?: LockManagerLike | null;
  /** Defaults to localStorage (silently disabled when storage is blocked). */
  store?: RefreshMarkerStore;
  now?: () => number;
}

export interface RefreshCoordinator {
  /**
   * @param requestStartedAt when the request that got the 401 was sent. A refresh recorded after
   * that moment is taken as the answer; pass `Infinity` to force a call.
   */
  refresh(requestStartedAt: number): Promise<RefreshOutcome>;
}

export function localStorageMarkerStore(key = REFRESH_MARKER_KEY): RefreshMarkerStore {
  return {
    read() {
      try {
        const raw = localStorage.getItem(key);
        const value = raw === null ? Number.NaN : Number(raw);
        return Number.isFinite(value) ? value : null;
      } catch {
        return null;
      }
    },
    write(at) {
      try {
        localStorage.setItem(key, String(at));
      } catch {
        // Storage can be blocked; the lock and the single-flight still protect the common case.
      }
    },
  };
}

function browserLocks(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as { locks?: LockManager }).locks;
  if (!locks) return null;
  return {
    request: <T>(name: string, callback: () => Promise<T>) => locks.request(name, callback),
  };
}

export function createRefreshCoordinator(options: RefreshCoordinatorOptions): RefreshCoordinator {
  const now = options.now ?? Date.now;
  let inFlight: Promise<RefreshOutcome> | null = null;

  const store = (): RefreshMarkerStore => options.store ?? localStorageMarkerStore();
  const locks = (): LockManagerLike | null =>
    options.locks === undefined ? browserLocks() : options.locks;

  async function attempt(requestStartedAt: number): Promise<RefreshOutcome> {
    const marker = store().read();
    if (marker !== null && marker >= requestStartedAt) return 'already-refreshed';
    await options.run();
    store().write(now());
    return 'refreshed';
  }

  return {
    refresh(requestStartedAt) {
      // A refresh that is still running replaces the cookies when it ends, so every caller that
      // arrives meanwhile (even a forced one) waits for it instead of starting a second.
      if (inFlight) return inFlight;

      const lock = locks();
      const promise = lock
        ? lock.request(REFRESH_LOCK_NAME, () => attempt(requestStartedAt))
        : attempt(requestStartedAt);
      const tracked = promise.finally(() => {
        if (inFlight === tracked) inFlight = null;
      });
      inFlight = tracked;
      return tracked;
    },
  };
}
