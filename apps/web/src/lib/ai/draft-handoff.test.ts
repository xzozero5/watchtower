import { afterEach, describe, expect, it, vi } from 'vitest';

import { draftHandoff } from './draft-handoff';

afterEach(() => {
  draftHandoff.clear();
});

describe('draftHandoff', () => {
  it('holds a draft until the composer takes it, once', () => {
    draftHandoff.send('OPS-1', { draftId: 'd1', text: 'Hello' });
    expect(draftHandoff.has('OPS-1')).toBe(true);
    expect(draftHandoff.take('OPS-2')).toBeUndefined();
    expect(draftHandoff.take('OPS-1')).toEqual({ draftId: 'd1', text: 'Hello' });
    expect(draftHandoff.take('OPS-1')).toBeUndefined();
  });

  it('tells a listener which ticket got a draft, and stops after unsubscribe', () => {
    const listener = vi.fn();
    const stop = draftHandoff.subscribe(listener);
    draftHandoff.send('OPS-1', { draftId: 'd1', text: 'a' });
    expect(listener).toHaveBeenCalledWith('OPS-1');
    stop();
    draftHandoff.send('OPS-1', { draftId: 'd2', text: 'b' });
    expect(listener).toHaveBeenCalledTimes(1);
    // The newer draft replaces the older one.
    expect(draftHandoff.take('OPS-1')?.draftId).toBe('d2');
  });
});
