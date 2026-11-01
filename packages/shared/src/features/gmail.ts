/**
 * Gmail adapter (T-102): this feature's own audit actions, ticket event types and queue names (T-123a).
 *
 * The task that owns this feature adds entries here and nowhere else in `packages/shared`. The
 * global `AUDIT_ACTIONS`, `TICKET_EVENT_TYPES` and `QUEUE_NAMES` are composed from these records
 * (see `./index.ts`), and importing `@watchtower/shared` throws if two features use the same key
 * or the same value. Keys are camelCase; values are lowercase strings (dotted for audit actions and
 * ticket events, the BullMQ queue name for queues). Start a value with the feature name so
 * collisions are unlikely.
 */
import { z } from 'zod';

import { INTEGRATION_CATALOG } from './credentials.js';

/** Audit `action` strings written by this feature. Metadata holds counts and codes, never an address or a body. */
export const GMAIL_AUDIT_ACTIONS = {
  /** `history.list` could not be used (404) or there was no cursor, so a bounded full sync ran (R-2.1). */
  gmailFullSync: 'gmail.full_sync',
  /** `users.watch` failed; the mailbox may stop pushing within 7 days (R-2.1). */
  gmailWatchFailed: 'gmail.watch_failed',
  /** No push for the configured window: the mailbox is marked unhealthy (R-2.8). */
  gmailHeartbeatStale: 'gmail.heartbeat_stale',
  /** A head started the OAuth flow for the support mailbox (T-102e). Metadata: the mailbox is not recorded. */
  gmailOauthStart: 'gmail.oauth.start',
  /** The OAuth callback finished: `success` stored a refresh token, `failure` carries the reason code (T-102e). */
  gmailOauthConnect: 'gmail.oauth.connect',
  /** Google refused the stored refresh token (`invalid_grant`): the mailbox is marked unhealthy and not connected (T-102e). */
  gmailNotConnected: 'gmail.not_connected',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const GMAIL_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api receiver and worker, consumer: worker). */
export const GMAIL_QUEUES = {
  /** History sync, watch renewal and heartbeat of the Gmail mailboxes (T-102b to T-102d). */
  gmail: 'gmail',
} as const satisfies Record<string, string>;

export const GMAIL_JOBS = {
  /** Read what is new in one mailbox (from a push, the heartbeat or a continuation) and queue it for ingestion. */
  sync: 'sync',
  /** `users.watch` for every mailbox, once a day (the watch expires after 7 days, R-2.1). */
  renewWatch: 'renew-watch',
  /** Marks mailboxes that stopped pushing (R-2.8). */
  heartbeat: 'heartbeat',
} as const;

/** Why a sync job exists. Only for logs and the audit trail; the work is the same. */
export const GMAIL_SYNC_REASONS = ['push', 'heartbeat', 'continuation', 'renew', 'manual'] as const;

/** Payload of a `sync` job. The job id is built by the producer so a repeat is the same job. */
export const gmailSyncJobSchema = z.object({
  channelAccountId: z.uuid(),
  reason: z.enum(GMAIL_SYNC_REASONS),
  /** The history id the push announced; informational (the cursor in the database is what is read from). */
  pushHistoryId: z
    .string()
    .regex(/^[0-9]{1,20}$/)
    .optional(),
});
export type GmailSyncJob = z.infer<typeof gmailSyncJobSchema>;

/** `sync` jobs are repeatable and idempotent: retry a few times with backoff, then keep the failure for a week. */
export const GMAIL_SYNC_OUTBOX_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** `channel_account.health` values written by this feature. */
export const GMAIL_CHANNEL_HEALTH = ['unknown', 'healthy', 'unhealthy'] as const;
export type GmailChannelHealth = (typeof GMAIL_CHANNEL_HEALTH)[number];

/**
 * The Pub/Sub push request body (wrapped delivery, the default; Pub/Sub push docs read 2026-11-01).
 * `message.data` is base64; Gmail's payload inside it is `{emailAddress, historyId}` (see the Gmail
 * adapter). Extra fields are ignored: Pub/Sub adds some (`orderingKey`, `deliveryAttempt`).
 */
export const pubsubPushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string().min(1).max(4096),
    messageId: z.string().regex(/^[0-9]{1,30}$/),
    publishTime: z.string().max(64).optional(),
  }),
  subscription: z.string().max(300).optional(),
});
export type PubsubPushEnvelope = z.infer<typeof pubsubPushEnvelopeSchema>;

/** A Gmail address as the push payload and the state row spell it: compare in lower case. */
export function normaliseMailboxAddress(value: string): string {
  return value.trim().toLowerCase();
}

// --- OAuth connection of the support mailbox (T-102e) ----------------------------------------

/** The two ways to reach the mailbox (PRD R-2.4). OAuth is the default; delegation is an option. */
export const GMAIL_CONNECTION_METHODS = ['oauth', 'service_account'] as const;
export type GmailConnectionMethod = (typeof GMAIL_CONNECTION_METHODS)[number];

/**
 * Where the browser lands after Google redirects back (`<APP_URL>/admin/integrations?gmail_oauth=<result>`).
 * T-116c shows a message for each; the value never carries a token, a code or an address.
 */
export const GMAIL_OAUTH_RESULTS = [
  'connected',
  /** The person pressed Cancel at Google, or Google returned an error. */
  'denied',
  /** State missing, expired, already used, or started in another session. */
  'state_invalid',
  /** Google granted other scopes than gmail.readonly + gmail.send. Nothing was saved. */
  'scope_mismatch',
  /** The signed-in Google account is not the mailbox that was asked for. Nothing was saved. */
  'mailbox_mismatch',
  /** Google issued no refresh token. Nothing was saved. */
  'no_refresh_token',
  /** The mailbox, refresh token or client credentials are set by the environment, so the database cannot hold them. */
  'env_locked',
  /** Google could not be reached or answered something unusable. Nothing was saved. */
  'unavailable',
] as const;
export type GmailOauthResult = (typeof GMAIL_OAUTH_RESULTS)[number];

/** `POST /v1/admin/integrations/gmail/oauth/start`. */
export const gmailOauthStartSchema = z.object({
  /** The support mailbox that will be connected. The callback refuses any other Google account. */
  mailbox: z
    .string()
    .trim()
    .max(254)
    .pipe(z.email())
    .transform((value) => value.toLowerCase()),
});
export type GmailOauthStart = z.infer<typeof gmailOauthStartSchema>;

export const gmailOauthStartResultSchema = z.object({
  /** Send the browser here. */
  authorizationUrl: z.url(),
  /** The state stops being accepted at this time. */
  expiresAt: z.iso.datetime(),
  /** The redirect URI to register on the OAuth client in the Google Cloud console. */
  redirectUri: z.url(),
});
export type GmailOauthStartResult = z.infer<typeof gmailOauthStartResultSchema>;

/** `GET /v1/admin/integrations/gmail/oauth/status`: what the admin page needs, never a value. */
export const gmailConnectionStatusSchema = z.object({
  /** Client ID and secret are set (so a person can start the flow). */
  oauthClientConfigured: z.boolean(),
  /** A refresh token and its mailbox are stored (or set by the environment). */
  oauthConnected: z.boolean(),
  /** The mailbox the OAuth grant belongs to, when connected. A non-secret identity. */
  oauthMailbox: z.string().nullable(),
  /** The service-account option is complete too. */
  serviceAccountConfigured: z.boolean(),
  /** What the worker uses (precedence in `packages/channels/src/gmail/README.md`), null when neither is complete. */
  effectiveMethod: z.enum(GMAIL_CONNECTION_METHODS).nullable(),
  /** The mailbox is connected in the credential store but Google refused the token (`invalid_grant`): connect again. */
  needsReconnect: z.boolean(),
  /** Where to register: the OAuth redirect URI. */
  redirectUri: z.url(),
});
export type GmailConnectionStatus = z.infer<typeof gmailConnectionStatusSchema>;

/** Why a mailbox shows as not connected. Stored in `gmail_account_state.last_error_code`. */
export const GMAIL_NOT_CONNECTED_CODE = 'not_connected';

/** The part of a credential-store field status that picks a method. */
export interface GmailFieldPresence {
  readonly field: string;
  readonly configured: boolean;
  readonly source: 'env' | 'db' | 'none';
}

/**
 * Which way the worker reaches the mailbox (T-102e). A way is usable when all of its fields are
 * configured (`INTEGRATION_CATALOG.gmail.alternatives`). When both are usable:
 *  1. the one with a field set by the ENVIRONMENT wins over one that lives only in the database
 *     (ADR-004/ADR-012: the environment is the operator's deployment-level decision, a head's
 *     click on the admin page must not override it);
 *  2. otherwise OAuth (the default, PRD R-2.4 and owner decision).
 * Pure: reads no value, only where each field comes from.
 */
export function chooseGmailMethod(
  fields: readonly GmailFieldPresence[],
): GmailConnectionMethod | null {
  const alternatives = INTEGRATION_CATALOG.gmail.alternatives;
  const presence = (name: string): GmailFieldPresence | undefined =>
    fields.find((entry) => entry.field === name);
  const usable = (method: GmailConnectionMethod): boolean =>
    alternatives[method].every((name) => presence(name)?.configured === true);
  const fromEnv = (method: GmailConnectionMethod): boolean =>
    alternatives[method].some((name) => presence(name)?.source === 'env');
  const oauth = usable('oauth');
  const delegation = usable('service_account');
  if (oauth && delegation) {
    if (fromEnv('service_account') && !fromEnv('oauth')) return 'service_account';
    return 'oauth';
  }
  if (oauth) return 'oauth';
  if (delegation) return 'service_account';
  return null;
}
