/**
 * LINE adapter (T-103): this feature's own audit actions, ticket event types and queue names (T-123a).
 *
 * The task that owns this feature adds entries here and nowhere else in `packages/shared`. The
 * global `AUDIT_ACTIONS`, `TICKET_EVENT_TYPES` and `QUEUE_NAMES` are composed from these records
 * (see `./index.ts`), and importing `@watchtower/shared` throws if two features use the same key
 * or the same value. Keys are camelCase; values are lowercase strings (dotted for audit actions and
 * ticket events, the BullMQ queue name for queues). Start a value with the feature name so
 * collisions are unlikely.
 */
import { z } from 'zod';

/**
 * Audit `action` strings written by this feature. Metadata never holds a link code, a reply token,
 * a LINE user id or a message body.
 */
export const LINE_AUDIT_ACTIONS = {
  /** A staff member generated a one-time code for a contact to send in LINE (R-2.11). */
  lineLinkCodeIssued: 'line.link_code_issued',
  /** A LINE user was linked to a contact (by link code or LINE Login). */
  lineLinked: 'line.linked',
  /** The monthly LINE quota counter was reconciled with the quota API (ADR-010 section 6). */
  lineQuotaReconciled: 'line.quota_reconciled',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const LINE_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: worker schedule, consumer: worker). */
export const LINE_QUEUES = {
  /** Housekeeping of LINE accounts: the hourly quota reconcile. */
  line: 'line',
} as const satisfies Record<string, string>;

export const LINE_JOBS = {
  /** Compare the local push counter with `GET /v2/bot/message/quota(/consumption)` for each LINE account. */
  reconcileQuota: 'reconcile-quota',
} as const;

// -- HTTP contract (apps/api/src/line) ------------------------------------------------------------

/** How long a link code works. Short on purpose: staff hand it over while the customer is chatting. */
export const LINE_LINK_CODE_TTL_SECONDS = 15 * 60;

export const lineLinkCodeRequestSchema = z.object({ contactId: z.uuid() });

export const lineLinkCodeResultSchema = z.object({
  /** Shown once. Only a hash is stored. */
  code: z.string(),
  expiresAt: z.iso.datetime(),
  contactId: z.uuid(),
});
export type LineLinkCodeResult = z.infer<typeof lineLinkCodeResultSchema>;

export const lineLoginStartSchema = z.object({
  /** Where to send the browser (the LINE Login authorization endpoint, or the fake one in mock mode). */
  authorizeUrl: z.string(),
});

export const lineLoginCallbackQuerySchema = z.object({
  code: z.string().min(1).max(512).optional(),
  state: z.string().min(1).max(2048),
  error: z.string().max(200).optional(),
});

export const lineQuotaAccountSchema = z.object({
  channelAccountId: z.uuid(),
  name: z.string(),
  /** `YYYY-MM`. */
  period: z.string(),
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative().nullable(),
  remaining: z.number().int().nonnegative().nullable(),
  percentUsed: z.number().nullable(),
  /** `warn` from 80% (R-2.10), `exhausted` at the cap: push is refused and email is suggested. */
  level: z.enum(['ok', 'warn', 'exhausted', 'unknown']),
  reconciledAt: z.iso.datetime().nullable(),
});

export const lineQuotaSchema = z.object({ accounts: z.array(lineQuotaAccountSchema) });
export type LineQuota = z.infer<typeof lineQuotaSchema>;
