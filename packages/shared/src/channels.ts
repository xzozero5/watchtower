import { z } from 'zod';

/** Channel types from the data model (PRD section 7, channel_account.type). */
export const CHANNEL_TYPES = ['gmail', 'line', 'portal', 'discord', 'webhook'] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const channelTypeSchema = z.enum(CHANNEL_TYPES);

/**
 * Channels a ticket can come from: the account channels plus `internal` (T-200), for a ticket the
 * system or a person opens without a customer (a usage anomaly, an alert follow-up). `internal` has
 * no channel account and nothing is ever delivered on it; `channel_account.type` does not accept it.
 */
export const TICKET_CHANNELS = [...CHANNEL_TYPES, 'internal'] as const;

export type TicketChannel = (typeof TICKET_CHANNELS)[number];
export const ticketChannelSchema = z.enum(TICKET_CHANNELS);
