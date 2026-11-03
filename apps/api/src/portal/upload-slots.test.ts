import { describe, expect, it } from 'vitest';

import { UploadSlots } from './upload-slots.js';

describe('UploadSlots', () => {
  it('allows one per address and a few in all', () => {
    const slots = new UploadSlots(2, 1);
    const a = slots.acquire('10.0.0.1');
    expect(a).not.toBeNull();
    expect(slots.acquire('10.0.0.1')).toBeNull();
    const b = slots.acquire('10.0.0.2');
    expect(b).not.toBeNull();
    expect(slots.acquire('10.0.0.3')).toBeNull();
    expect(slots.inFlight).toBe(2);
  });

  it('frees a slot when it is released, once only', () => {
    const slots = new UploadSlots(1, 1);
    const release = slots.acquire('10.0.0.1');
    release?.();
    release?.();
    expect(slots.inFlight).toBe(0);
    expect(slots.acquire('10.0.0.2')).not.toBeNull();
    expect(slots.inFlight).toBe(1);
  });
});
