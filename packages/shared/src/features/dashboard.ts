/**
 * Ops dashboard read models (T-206): this feature's own audit actions, ticket event types and queue names (T-200).
 *
 * Created empty by T-200 so the Phase 2 tasks that run in parallel never edit the same lines of
 * `./index.ts`, `auth.ts`, `ticketing.ts` or `queues.ts`. The task that owns this feature adds its
 * entries here and nowhere else in `packages/shared` (see `./gmail.ts` for the conventions).
 */

/** Audit `action` strings written by this feature. */
export const DASHBOARD_AUDIT_ACTIONS = {} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const DASHBOARD_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature. */
export const DASHBOARD_QUEUES = {} as const satisfies Record<string, string>;
