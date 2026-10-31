/**
 * Notifications (T-105): this feature's own audit actions, ticket event types and queue names (T-123a).
 *
 * The task that owns this feature adds entries here and nowhere else in `packages/shared`. The
 * global `AUDIT_ACTIONS`, `TICKET_EVENT_TYPES` and `QUEUE_NAMES` are composed from these records
 * (see `./index.ts`), and importing `@watchtower/shared` throws if two features use the same key
 * or the same value. Keys are camelCase; values are lowercase strings (dotted for audit actions and
 * ticket events, the BullMQ queue name for queues). Start a value with the feature name so
 * collisions are unlikely.
 */

/** Audit `action` strings written by this feature. */
export const NOTIFICATIONS_AUDIT_ACTIONS = {} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const NOTIFICATIONS_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api, consumer: worker). */
export const NOTIFICATIONS_QUEUES = {} as const satisfies Record<string, string>;
