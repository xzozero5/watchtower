import { z } from 'zod';

import { channelTypeSchema } from './channels.js';
import { csvList, cursorSchema, pageLimit, pageOf } from './common.js';
import { OTHER_MAIL_DISPOSITIONS } from './features/inbound.js';
import { ticketPrioritySchema } from './sla.js';

/**
 * HTTP contract of "Other mail" (PRD R-2.6, R-2.7, UI spec section 7): received messages that did not
 * become a ticket, and the one thing a person can do with them, turn one into a ticket.
 */

export const otherMailDispositionSchema = z.enum(OTHER_MAIL_DISPOSITIONS);
export type OtherMailDisposition = z.infer<typeof otherMailDispositionSchema>;

export const otherMailQuerySchema = z.object({
  /** Default: all three (`noise`, `auto_reply`, `internal`). */
  disposition: csvList(otherMailDispositionSchema),
  channelAccountId: z.uuid().optional(),
  /** Searches the sender, the subject and the beginning of the text. */
  q: z.string().trim().min(2).max(200).optional(),
  limit: pageLimit(50, 200),
  cursor: cursorSchema.optional(),
});
export type OtherMailQuery = z.infer<typeof otherMailQuerySchema>;

export const otherMailItemSchema = z.object({
  id: z.uuid(),
  channelAccountId: z.uuid(),
  channel: channelTypeSchema,
  disposition: otherMailDispositionSchema,
  /** The classifier's verdict, when there is one: label, confidence and whether AI or the rules gave it. */
  classification: z
    .object({
      type: z.string(),
      confidence: z.number().min(0).max(1).nullable(),
      source: z.enum(['ai', 'rules']),
    })
    .nullable(),
  /** Why the rules put it here (`out_of_office`, `bounce`, ...) when the headers said so. */
  automatedSubtype: z.string().nullable(),
  fromAddress: z.string().nullable(),
  fromName: z.string().nullable(),
  subject: z.string(),
  /** The first 200 characters of the text. */
  snippet: z.string(),
  attachmentCount: z.number().int().min(0),
  receivedAt: z.iso.datetime(),
});
export type OtherMailItem = z.infer<typeof otherMailItemSchema>;
export const otherMailPageSchema = pageOf(otherMailItemSchema);

export const otherMailDetailSchema = otherMailItemSchema.extend({
  /** The whole text; the HTML part is never returned. */
  bodyText: z.string(),
});
export type OtherMailDetail = z.infer<typeof otherMailDetailSchema>;

export const convertOtherMailSchema = z.object({
  priority: ticketPrioritySchema.optional(),
  intentKey: z.string().trim().min(1).max(64).optional(),
});
export type ConvertOtherMail = z.infer<typeof convertOtherMailSchema>;

export const convertOtherMailResultSchema = z.object({
  inboundMessageId: z.uuid(),
  ticketId: z.uuid(),
  ticketKey: z.string(),
  /** What the message was before a person said "this is a ticket". */
  convertedFrom: otherMailDispositionSchema,
});
export type ConvertOtherMailResult = z.infer<typeof convertOtherMailResultSchema>;
