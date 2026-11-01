import { z } from 'zod';

import type { ChannelType, TicketPriority } from '@watchtower/shared';

/**
 * What Watchtower posts to a Discord webhook. Limits are from the Execute Webhook and Message
 * resource pages of the Discord developer documentation (checked 2026-11-01, see README):
 * `content` 2,000; at most 10 embeds; title 256; description 4,096; field name 256 and value 1,024;
 * footer 2,048; 25 fields; and 6,000 characters across all embeds of one message.
 *
 * The type has no `allowed_mentions`, `username`, `tts` or `components`: `buildPayload` sets
 * `allowed_mentions: { parse: [] }` itself, so nothing that ends up in a message can ping
 * `@everyone`, a role or a person.
 */

export const DISCORD_MAX_CONTENT = 2000;
export const DISCORD_MAX_EMBEDS = 10;
export const DISCORD_MAX_EMBED_TOTAL = 6000;

const embedFieldSchema = z.object({
  name: z.string().min(1).max(256),
  value: z.string().min(1).max(1024),
  inline: z.boolean().optional(),
});

export const discordEmbedSchema = z.object({
  title: z.string().min(1).max(256).optional(),
  description: z.string().min(1).max(4096).optional(),
  /** Makes the title a link. */
  url: z
    .url()
    .refine((value) => /^https?:\/\//i.test(value))
    .optional(),
  /** 0xRRGGBB. */
  color: z.number().int().min(0).max(0xffffff).optional(),
  fields: z.array(embedFieldSchema).max(25).optional(),
  footer: z.object({ text: z.string().min(1).max(2048) }).optional(),
  /** ISO 8601. */
  timestamp: z.iso.datetime().optional(),
});
export type DiscordEmbed = z.infer<typeof discordEmbedSchema>;

function embedCharacters(embed: DiscordEmbed): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  );
}

export const discordWebhookMessageSchema = z
  .object({
    content: z.string().min(1).max(DISCORD_MAX_CONTENT).optional(),
    embeds: z.array(discordEmbedSchema).min(1).max(DISCORD_MAX_EMBEDS).optional(),
  })
  .strict()
  .refine((message) => message.content !== undefined || message.embeds !== undefined, {
    message: 'a message needs content or at least one embed',
  })
  .refine(
    (message) =>
      (message.embeds ?? []).reduce((sum, embed) => sum + embedCharacters(embed), 0) <=
      DISCORD_MAX_EMBED_TOTAL,
    { message: 'embeds are over 6000 characters in total' },
  );

export type DiscordWebhookMessage = z.infer<typeof discordWebhookMessageSchema>;

/** The JSON body that is POSTed: the message plus the fixed "mention nobody" rule. */
export function buildPayload(message: DiscordWebhookMessage): Record<string, unknown> {
  return { ...message, allowed_mentions: { parse: [] } };
}

// --- ticket created -----------------------------------------------------------------------------

export interface TicketCreatedNotice {
  /** `OPS-123`. */
  readonly ticketKey: string;
  readonly priority: TicketPriority;
  /** The channel the ticket arrived through. */
  readonly channel: ChannelType;
  /** Link to the ticket in Watchtower, when the instance knows its public address. */
  readonly link?: string | undefined;
  readonly at: Date;
}

const PRIORITY_LABEL: Record<TicketPriority, string> = {
  P1: 'P1 (critical)',
  P2: 'P2 (high)',
  P3: 'P3 (normal)',
  P4: 'P4 (low)',
};

// Priority is also written as text in the first field: colour alone never carries the severity.
const PRIORITY_COLOR: Record<TicketPriority, number> = {
  P1: 0xd92d20,
  P2: 0xf79009,
  P3: 0x2e90fa,
  P4: 0x98a2b3,
};

const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,15}$/;

/**
 * "A ticket was created": key, priority, channel and a link. No subject, no customer, no message
 * text: those are customer data (N1, N4) and the people reading the channel can open the link.
 * Throws when the key is not shaped like a ticket key, so free text can never ride in this field.
 */
export function buildTicketCreatedMessage(notice: TicketCreatedNotice): DiscordWebhookMessage {
  if (!TICKET_KEY.test(notice.ticketKey)) throw new Error('ticketKey is not a ticket key');
  const embed: DiscordEmbed = {
    title: `New ticket ${notice.ticketKey}`,
    color: PRIORITY_COLOR[notice.priority],
    fields: [
      { name: 'Priority', value: PRIORITY_LABEL[notice.priority], inline: true },
      { name: 'Channel', value: notice.channel, inline: true },
    ],
    timestamp: notice.at.toISOString(),
  };
  if (notice.link !== undefined && /^https?:\/\//i.test(notice.link) && URL.canParse(notice.link)) {
    embed.url = notice.link;
  }
  return discordWebhookMessageSchema.parse({ embeds: [embed] });
}
