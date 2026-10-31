import { z } from 'zod';

/** Channel types from the data model (PRD section 7, channel_account.type). */
export const CHANNEL_TYPES = ['gmail', 'line', 'portal', 'discord', 'webhook'] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const channelTypeSchema = z.enum(CHANNEL_TYPES);
