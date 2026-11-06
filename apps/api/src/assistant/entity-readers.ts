import type { Handoff, IncomingHandoffs } from '@watchtower/shared';

import type { Principal } from '../auth/principal.js';
import type { HandoffService } from '../shifts/handoff.service.js';

export type VisibleHandoff = Pick<Handoff, 'id' | 'from' | 'items' | 'notes' | 'messageForNext'>;

/** Exactly the two GET views: own open handoff, or an incoming handoff addressed to this person. */
export async function visibleHandoff(
  service: Pick<HandoffService, 'current' | 'incoming'>,
  principal: Principal,
  id: string,
  view?: 'own' | 'incoming',
): Promise<VisibleHandoff | null> {
  if (view !== 'incoming' && principal.permissions.has('handoff.write')) {
    const own = (await service.current(principal)).handoff;
    if (own?.id === id) return own;
  }
  if (view !== 'own' && principal.permissions.has('handoff.ack')) {
    const incoming: IncomingHandoffs = await service.incoming(principal);
    return incoming.handoffs.find((handoff) => handoff.id === id) ?? null;
  }
  return null;
}
