import type { schema } from '@watchtower/db';

export type TicketRow = typeof schema.ticket.$inferSelect;
export type MessageRow = typeof schema.message.$inferSelect;
export type ContactRow = typeof schema.contact.$inferSelect;
export type IntentRow = typeof schema.intent.$inferSelect;
export type SlaPolicyRow = typeof schema.slaPolicy.$inferSelect;
export type OutboundDeliveryRow = typeof schema.outboundDelivery.$inferSelect;
export type AiDraftRow = typeof schema.aiDraft.$inferSelect;
