import type { AssistantEntityKind, AssistantPage } from '@watchtower/shared';

import type { MessageKey } from '@/i18n';

export interface LocalStarter {
  /** Stable, for tests. */
  id: string;
  /** The words in the app language. */
  key: MessageKey;
}

/**
 * Prompts the web knows without asking the api: two per page kind and two per kind of entity, in the
 * message catalogues (TH and EN). The api's own starters (they know the person's permissions) come
 * first for a page or a ticket; these fill in when it has none, when the call failed, and for every
 * other kind of entity (the api only knows `ticket`). A prompt is only text for the input: the
 * person still presses send, and the server still checks what the question touches.
 */
export function pageStarters(page: AssistantPage): LocalStarter[] {
  return [
    { id: `page.${page}.a`, key: `assistant.localStarters.page.${page}.a` },
    { id: `page.${page}.b`, key: `assistant.localStarters.page.${page}.b` },
  ];
}

export function entityStarters(kind: AssistantEntityKind): LocalStarter[] {
  return [
    { id: `entity.${kind}.a`, key: `assistant.localStarters.entity.${kind}.a` },
    { id: `entity.${kind}.b`, key: `assistant.localStarters.entity.${kind}.b` },
  ];
}

/** Whether the api's starters cannot speak for this chip, so the entity's own prompts are shown. */
export function entityNeedsLocalStarters(kind: AssistantEntityKind | null): boolean {
  return kind !== null && kind !== 'ticket';
}
