import { describe, expect, it } from 'vitest';

import { actorOf } from './kb-actor.js';

describe('actorOf (knowledge base)', () => {
  it('acts as a person for every staff role and for a client', () => {
    for (const role of ['agent', 'lead', 'head', 'client'] as const) {
      expect(actorOf({ role, userId: 'u-1' }), role).toEqual({ type: 'user', id: 'u-1' });
    }
  });

  it('acts as the system for a service identity, so the domain refuses it where a person is needed', () => {
    expect(actorOf({ role: 'system', userId: 'svc-1' })).toEqual({ type: 'system', id: 'svc-1' });
  });
});
