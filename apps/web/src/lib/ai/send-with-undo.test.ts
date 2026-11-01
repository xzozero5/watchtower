import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isScheduled, scheduleSend, UNDO_WINDOW_MS } from './send-with-undo';

describe('scheduleSend', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not send inside the undo window and sends once it has passed', () => {
    const send = vi.fn();
    scheduleSend('d1', send);
    expect(isScheduled('d1')).toBe(true);
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('never sends a reply that was undone', () => {
    const send = vi.fn();
    const scheduled = scheduleSend('d2', send);
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 100);
    scheduled.cancel();
    vi.advanceTimersByTime(10_000);
    expect(send).not.toHaveBeenCalled();
    expect(isScheduled('d2')).toBe(false);
  });

  it('keeps a draft marked as scheduled until the send reports it is done', () => {
    let done: () => void = () => undefined;
    scheduleSend('d3', (finish) => {
      done = finish;
    });
    vi.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(isScheduled('d3')).toBe(true);
    done();
    expect(isScheduled('d3')).toBe(false);
  });

  it('uses a window of five seconds unless told otherwise', () => {
    expect(UNDO_WINDOW_MS).toBe(5000);
    const send = vi.fn();
    scheduleSend('d4', send, 200);
    vi.advanceTimersByTime(200);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
