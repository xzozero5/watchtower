/**
 * Channel accounts (T-131): this feature's own audit actions, ticket event types and queue names
 * (T-123a), and the HTTP schemas of `/v1/admin/channel-accounts`.
 *
 * A channel account is one LINE Official Account or one Gmail mailbox. Credentials are kept apart
 * (ADR-012, `./credentials.ts`); this is the row they connect to. Browser-safe.
 */
import { z } from 'zod';

import { INTEGRATION_STATUSES } from './credentials.js';
import { normaliseMailboxAddress } from './gmail.js';

/** Audit `action` strings written by this feature. Metadata holds the type and ids, never an address. */
export const CHANNEL_ACCOUNTS_AUDIT_ACTIONS = {
  /** A LINE Official Account or a Gmail mailbox was registered. */
  channelAccountCreate: 'channel_account.create',
  /** An account was switched off: it stops receiving and syncing; its history stays. */
  channelAccountDisable: 'channel_account.disable',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const CHANNEL_ACCOUNTS_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api, consumer: worker). */
export const CHANNEL_ACCOUNTS_QUEUES = {} as const satisfies Record<string, string>;

/** The channel types an administrator registers by hand. The portal account is created by migration. */
export const MANAGED_CHANNEL_TYPES = ['line', 'gmail'] as const;
export type ManagedChannelType = (typeof MANAGED_CHANNEL_TYPES)[number];
export const managedChannelTypeSchema = z.enum(MANAGED_CHANNEL_TYPES);

/** Path of the LINE webhook receiver for one account (the URL to paste into the LINE console). */
export function lineWebhookPath(channelAccountId: string): string {
  return `/v1/inbound/line/${channelAccountId}`;
}

const nameSchema = z.string().trim().min(1).max(120);

/** `POST /v1/admin/channel-accounts`. A LINE account has a name only; a Gmail mailbox needs its address. */
export const createChannelAccountSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('line'), name: nameSchema }),
  z.strictObject({
    type: z.literal('gmail'),
    name: nameSchema,
    emailAddress: z.string().max(254).transform(normaliseMailboxAddress).pipe(z.email()),
  }),
]);
export type CreateChannelAccount = z.infer<typeof createChannelAccountSchema>;

export const channelAccountIdParamSchema = z.object({ id: z.uuid() });
export type ChannelAccountIdParam = z.infer<typeof channelAccountIdParamSchema>;

export const channelAccountSchema = z.object({
  id: z.uuid(),
  type: managedChannelTypeSchema,
  name: z.string(),
  /** `unknown` until the first sync or push says otherwise. */
  health: z.string(),
  /** False once disabled. */
  enabled: z.boolean(),
  disabledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** Gmail only: the mailbox (lower case). */
  emailAddress: z.string().nullable(),
  /** LINE only: the absolute URL to paste into the LINE Developers console as the webhook URL. */
  webhookUrl: z.string().nullable(),
  /** State of the integration's credentials (ADR-012): the account does nothing until `configured`. */
  credentials: z.enum(INTEGRATION_STATUSES),
  /** Why it is not usable yet or what to do next, in plain language. */
  notes: z.array(z.string()),
});
export type ChannelAccount = z.infer<typeof channelAccountSchema>;

export const channelAccountListSchema = z.object({ items: z.array(channelAccountSchema) });
export type ChannelAccountList = z.infer<typeof channelAccountListSchema>;
