import type { TicketStatus } from '@watchtower/shared';

import type { MessageRow, TicketRow } from './rows.js';
import type { DbTransaction } from './types.js';

/**
 * Customer-facing notices that go with a ticket change. They write to the transactional outbox in
 * the same transaction, in the order the domain calls them (ADR-006). The api implements this with
 * the portal's emails (`PortalNotifier`); moving that into the domain is a later step of ADR-009.
 */
export interface TicketNotifier {
  /** The ticket was closed: its tracking links stop working (C-13). */
  closeLinks(tx: DbTransaction, ticketId: string): Promise<unknown>;
  /** A status change the customer can see. */
  statusChange(
    tx: DbTransaction,
    ticket: TicketRow,
    ticketKey: string,
    from: TicketStatus,
    to: TicketStatus,
  ): Promise<void>;
  /** The customer of a merged ticket learns which ticket carries the conversation now (R-1.5). */
  merged(tx: DbTransaction, source: TicketRow, sourceKey: string, intoKey: string): Promise<void>;
  /** A public reply from staff; `ticket` is the ticket after the reply and any status change. */
  staffReply(
    tx: DbTransaction,
    ticket: TicketRow,
    ticketKey: string,
    message: MessageRow,
  ): Promise<void>;
}

/** Sends nothing. A process that has no customer notices (a test, a job that only reads) says so. */
export const NO_NOTIFIER: TicketNotifier = {
  closeLinks: () => Promise.resolve(0),
  statusChange: () => Promise.resolve(),
  merged: () => Promise.resolve(),
  staffReply: () => Promise.resolve(),
};
