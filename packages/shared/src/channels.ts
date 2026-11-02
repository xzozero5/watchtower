import { z } from 'zod';

/** Channel types from the data model (PRD section 7, channel_account.type). */
export const CHANNEL_TYPES = ['gmail', 'line', 'portal', 'discord', 'webhook'] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const channelTypeSchema = z.enum(CHANNEL_TYPES);

/**
 * Where a person says a request came from when they file a ticket by hand (T-136): a phone call, someone
 * at the desk, a chat that is not connected, anything else. There is no channel account behind them and
 * nothing is delivered on them, so a public reply on such a ticket is refused (see `NO_OUTBOUND_CHANNELS`).
 * `channel_account.type` does not accept them.
 */
export const MANUAL_CHANNELS = ['phone', 'walk_in', 'chat', 'other'] as const;
export type ManualChannel = (typeof MANUAL_CHANNELS)[number];
export const manualChannelSchema = z.enum(MANUAL_CHANNELS);

/**
 * Channels a ticket can come from: the account channels, the manual ones (T-136), and `internal` (T-200),
 * for a ticket the system or a person opens without a customer (a usage anomaly, an alert follow-up).
 * `internal` has no channel account and nothing is ever delivered on it.
 */
export const TICKET_CHANNELS = [...CHANNEL_TYPES, ...MANUAL_CHANNELS, 'internal'] as const;

export type TicketChannel = (typeof TICKET_CHANNELS)[number];
export const ticketChannelSchema = z.enum(TICKET_CHANNELS);

/** A ticket channel that stands for a customer (everything except `internal`). */
export type CustomerTicketChannel = Exclude<TicketChannel, 'internal'>;

/**
 * Ticket channels on which Watchtower cannot send a public reply `[ASSUMED]` (T-136, `po` to confirm):
 * nothing would be delivered, so the reply is refused with `channel_no_outbound` instead of being stored
 * as sent. The person records what was said on the phone as an internal note, or writes to the customer
 * on a channel that exists.
 */
export const NO_OUTBOUND_CHANNELS: readonly TicketChannel[] = [...MANUAL_CHANNELS, 'internal'];

export function hasOutboundChannel(channel: string): boolean {
  return !(NO_OUTBOUND_CHANNELS as readonly string[]).includes(channel);
}
