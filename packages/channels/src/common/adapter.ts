import { z } from 'zod';

import { channelTypeSchema } from '@watchtower/shared';

/**
 * The adapter interface every channel implements (PRD section 4.2): `ingest`, `send`, `markRead`,
 * `capabilities`. The generics keep each channel's own input and output types while the worker and
 * the dispatcher program against one shape.
 */

export const channelCapabilitiesSchema = z.object({
  channel: channelTypeSchema,
  /** Messages arrive by push (webhook / Pub/Sub). */
  receive: z.boolean(),
  send: z.boolean(),
  /** `native`: the provider groups messages (Gmail threadId). `headers`: by RFC headers only. */
  threading: z.enum(['native', 'headers', 'none']),
  markRead: z.boolean(),
  /** A free, single-use token authorises one reply (LINE). */
  replyToken: z.boolean(),
  attachments: z.boolean(),
  html: z.boolean(),
  /** Longest single text body the provider accepts, in UTF-16 code units. `null` = no fixed cap. */
  maxTextLength: z.number().int().positive().nullable(),
});

export type ChannelCapabilities = z.infer<typeof channelCapabilitiesSchema>;

export interface ChannelAdapter<TIngestInput, TInbound, TSendInput, TSendResult, TMarkReadInput> {
  capabilities(): ChannelCapabilities;
  /** Turns a provider notification (or a message id taken from one) into normalised messages. */
  ingest(input: TIngestInput): Promise<readonly TInbound[]>;
  send(input: TSendInput): Promise<TSendResult>;
  /** Rejects with `ChannelError` of kind `unsupported` when `capabilities().markRead` is false. */
  markRead(input: TMarkReadInput): Promise<void>;
}
