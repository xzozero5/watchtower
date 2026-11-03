import { DelayedError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { OFFLINE_GIVE_UP_MS, OFFLINE_RETRY_MS, delayWhileOffline } from './brief.js';

const fakeJob = (timestamp: number) => ({
  timestamp,
  moveToDelayed: vi.fn(() => Promise.resolve()),
});

describe('delayWhileOffline (ADR-019)', () => {
  it('moves the job later and ends the run with DelayedError', async () => {
    const job = fakeJob(1_000);
    await expect(delayWhileOffline(job, 'lock', 2_000)).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(2_000 + OFFLINE_RETRY_MS, 'lock');
  });

  it('does nothing past the give-up age or without a lock token', async () => {
    const old = fakeJob(0);
    await expect(delayWhileOffline(old, 'lock', OFFLINE_GIVE_UP_MS)).resolves.toBeUndefined();
    const fresh = fakeJob(1_000);
    await expect(delayWhileOffline(fresh, undefined, 2_000)).resolves.toBeUndefined();
    expect(old.moveToDelayed).not.toHaveBeenCalled();
    expect(fresh.moveToDelayed).not.toHaveBeenCalled();
  });
});
