import type { Actor } from '@watchtower/domain';

import type { Principal } from '../auth/decorators.js';

/**
 * Who a request acts as in the domain. A service identity (role `system`) acts as `system`, not as a
 * person: the domain refuses it where a human is required (publishing, reviewing a break-glass
 * publication), whatever permission it holds. Every other role is a person.
 */
export function actorOf(principal: Pick<Principal, 'role' | 'userId'>): Actor {
  return { type: principal.role === 'system' ? 'system' : 'user', id: principal.userId };
}
