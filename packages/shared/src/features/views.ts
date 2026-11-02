/**
 * Saved views, bulk actions and linked tickets (T-119): this feature's own audit actions, ticket
 * event types and queue names (T-123a). The HTTP contracts are in `../views.ts` (they need the
 * ticket schemas, which import this directory).
 *
 * The task that owns this feature adds entries here and nowhere else in `packages/shared`. The
 * global `AUDIT_ACTIONS`, `TICKET_EVENT_TYPES` and `QUEUE_NAMES` are composed from these records
 * (see `./index.ts`), and importing `@watchtower/shared` throws if two features use the same key
 * or the same value. Keys are camelCase; values are lowercase strings (dotted for audit actions and
 * ticket events, the BullMQ queue name for queues). Start a value with the feature name so
 * collisions are unlikely.
 */

/** Audit `action` strings written by this feature. */
export const VIEWS_AUDIT_ACTIONS = {
  /** A saved view was created (personal or shared). */
  viewCreate: 'view.create',
  viewUpdate: 'view.update',
  viewDelete: 'view.delete',
  /**
   * One row per bulk request: the action, how many tickets, how many succeeded or failed. Every
   * ticket also has its own row (`ticket.assign`, `ticket.update`, ...) with the person as actor.
   */
  ticketBulk: 'ticket.bulk',
  /** Two tickets were linked as duplicate or related. */
  ticketLink: 'ticket.link',
  ticketUnlink: 'ticket.unlink',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const VIEWS_TICKET_EVENTS = {
  /** Written on both tickets of a link (internal). */
  linked: 'ticket.linked',
  unlinked: 'ticket.unlinked',
} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api, consumer: worker). */
export const VIEWS_QUEUES = {} as const satisfies Record<string, string>;
