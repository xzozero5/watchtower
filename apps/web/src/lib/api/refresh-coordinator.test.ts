import { describe, expect, it, vi } from 'vitest';

import {
  createRefreshCoordinator,
  localStorageMarkerStore,
  type LockManagerLike,
  type RefreshMarkerStore,
} from './refresh-coordinator';

function memoryStore(initial: number | null = null): RefreshMarkerStore & { value: number | null } {
  const store = {
    value: initial,
    read: () => store.value,
    write: (at: number) => {
      store.value = at;
    },
  };
  return store;
}

/** A lock manager that really serialises, like navigator.locks does across tabs. */
function serialLocks() {
  let tail: Promise<unknown> = Promise.resolve();
  const held: string[] = [];
  const locks: LockManagerLike = {
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      held.push(name);
      const run = tail.then(callback, callback);
      tail = run.catch(() => undefined);
      return run;
    },
  };
  return { locks, held };
}

describe('createRefreshCoordinator', () => {
  it('shares one refresh between callers in the same tab', async () => {
    let release: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const coordinator = createRefreshCoordinator({ run, locks: null, store: memoryStore() });

    const calls = [coordinator.refresh(1), coordinator.refresh(2), coordinator.refresh(3)];
    release();
    await expect(Promise.all(calls)).resolves.toEqual(['refreshed', 'refreshed', 'refreshed']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('starts a new refresh once the previous one has finished', async () => {
    const run = vi.fn(() => Promise.resolve());
    const coordinator = createRefreshCoordinator({ run, locks: null, store: memoryStore() });
    await coordinator.refresh(1);
    await coordinator.refresh(Number.POSITIVE_INFINITY);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('serialises refreshes across tabs with a lock and lets the second tab skip', async () => {
    // Two coordinators = two tabs sharing the lock manager and the marker store.
    const { locks, held } = serialLocks();
    const store = memoryStore();
    let clock = 1000;
    const now = () => (clock += 10);
    const runA = vi.fn(() => Promise.resolve());
    const runB = vi.fn(() => Promise.resolve());
    const tabA = createRefreshCoordinator({ run: runA, locks, store, now });
    const tabB = createRefreshCoordinator({ run: runB, locks, store, now });

    // Both tabs sent a request at t=1000 and both got a 401.
    const [a, b] = await Promise.all([tabA.refresh(1000), tabB.refresh(1000)]);

    expect([a, b]).toEqual(['refreshed', 'already-refreshed']);
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).not.toHaveBeenCalled();
    expect(held).toEqual(['wt-session-refresh', 'wt-session-refresh']);
  });

  it('refreshes when the last refresh is older than the failed request', async () => {
    const run = vi.fn(() => Promise.resolve());
    const coordinator = createRefreshCoordinator({
      run,
      locks: null,
      store: memoryStore(500),
      now: () => 2000,
    });
    await expect(coordinator.refresh(1000)).resolves.toBe('refreshed');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a forced refresh ignores the marker', async () => {
    const run = vi.fn(() => Promise.resolve());
    const coordinator = createRefreshCoordinator({
      run,
      locks: null,
      store: memoryStore(10_000),
    });
    await expect(coordinator.refresh(Number.POSITIVE_INFINITY)).resolves.toBe('refreshed');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not record a refresh that failed, and lets the error through', async () => {
    const store = memoryStore();
    const coordinator = createRefreshCoordinator({
      run: () => Promise.reject(new Error('session over')),
      locks: null,
      store,
    });
    await expect(coordinator.refresh(1)).rejects.toThrow('session over');
    expect(store.value).toBeNull();
    // And the next caller is not stuck behind the failed one.
    await expect(coordinator.refresh(2)).rejects.toThrow('session over');
  });
});

describe('localStorageMarkerStore', () => {
  it('round-trips a timestamp and ignores junk', () => {
    localStorage.clear();
    const store = localStorageMarkerStore('test-marker');
    expect(store.read()).toBeNull();
    store.write(1234);
    expect(store.read()).toBe(1234);
    localStorage.setItem('test-marker', 'not a number');
    expect(store.read()).toBeNull();
  });
});
