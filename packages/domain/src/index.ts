import { REOPEN_WINDOW_DAYS } from '@watchtower/shared';

import { assertAssignableStaff, nextRoundRobin, peekRoundRobin, takeTurn } from './assignment.js';
import { findOrCreateContactByEmail } from './contacts.js';
import { resolveIntent } from './intents.js';
import { NO_NOTIFIER, type TicketNotifier } from './notifier.js';
import { enqueueJob } from './outbox.js';
import type { PolicyGate } from './policy.js';
import {
  finishedSlaPauses,
  recomputeSla,
  resolveSlaPolicy,
  resumeSla,
  slaCalendarFor,
  slaForNewTicket,
} from './sla.js';
import { assignTicket } from './tickets/assign.js';
import { createTicket } from './tickets/create.js';
import { mergeTickets } from './tickets/merge.js';
import { addTicketNote, replyToTicket } from './tickets/messages.js';
import { changeTicketStatus } from './tickets/status.js';
import { updateTicket } from './tickets/update.js';
import type { Actor, DomainConfig, DomainContext } from './types.js';
import { workflowAllows } from './workflow.js';

export { recordAuditInTx, type AuditEntry, type AuditWriter } from './audit.js';
export {
  assertAssignableStaff,
  nextRoundRobin,
  peekRoundRobin,
  pickNextMember,
  takeTurn,
} from './assignment.js';
export {
  contactSnapshot,
  findOrCreateContactByEmail,
  type FindOrCreateContactInput,
} from './contacts.js';
export { DOMAIN_ERROR_CODES, DomainError, isDomainError, type DomainErrorCode } from './errors.js';
export { resolveIntent } from './intents.js';
export { NO_NOTIFIER, type TicketNotifier } from './notifier.js';
export { enqueueJob, type OutboxRequest } from './outbox.js';
export {
  requireCustomerSend,
  type CustomerSendRequest,
  type PolicyDecision,
  type PolicyGate,
} from './policy.js';
export type { ContactRow, IntentRow, MessageRow, SlaPolicyRow, TicketRow } from './rows.js';
export {
  FALLBACK_CALENDAR,
  calendarFromRow,
  finishedSlaPauses,
  recomputeSla,
  resolveSlaPolicy,
  resumeSla,
  slaCalendarFor,
  slaForNewTicket,
  targetsFromRow,
  type SlaDue,
  type TicketSla,
  type TicketSlaInput,
} from './sla.js';
export { TicketKeys } from './ticket-keys.js';
export { assignTicket, type AssignTicketInput } from './tickets/assign.js';
export { createTicket, type CreateTicketInput, type CreateTicketResult } from './tickets/create.js';
export { mergeTickets, type MergeTicketInput } from './tickets/merge.js';
export {
  addTicketNote,
  replyToTicket,
  type MessageResult,
  type NoteInput,
  type ReplyInput,
} from './tickets/messages.js';
export { changeTicketStatus, type ChangeStatusInput } from './tickets/status.js';
export {
  lockTicketRow,
  replyDeliveryStatus,
  ticketRefCondition,
  type Sender,
} from './tickets/support.js';
export { updateTicket, type UpdateTicketInput } from './tickets/update.js';
export {
  Effects,
  type Actor,
  type DbTransaction,
  type DomainConfig,
  type DomainContext,
  type DomainResult,
  type ReadExecutor,
} from './types.js';
export { workflowAllows } from './workflow.js';

export interface DomainOptions {
  /** Ticket key prefix, the same value in api and worker (`TICKET_KEY_PREFIX`). */
  readonly ticketKeyPrefix: string;
  /** The subkey that seals outbox secrets (`deriveSubkey(APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret)`). */
  readonly sealKey: Buffer;
  /** Days a resolved ticket still reopens on a customer reply. Default: `REOPEN_WINDOW_DAYS`. */
  readonly reopenWindowDays?: number;
  /** Absent means every customer-bound AI action is refused (fail closed, N3). */
  readonly policyGate?: PolicyGate | undefined;
  readonly now?: () => Date;
}

export interface ContextOptions {
  readonly actor: Actor;
  readonly auditMeta?: { readonly ip: string | null; readonly requestId: string | null };
  /** Default: no customer notices. */
  readonly notifier?: TicketNotifier;
}

/**
 * The domain, configured once at boot by the app (ADR-009). The apps validate their environment
 * and pass plain values in; nothing here reads `process.env`. Operations are plain functions
 * `(tx, ctx, input) => { value, events, audited }`; `context()` builds the `ctx`.
 */
export interface Domain {
  readonly config: DomainConfig;
  context(options: ContextOptions): DomainContext;
  readonly tickets: {
    readonly create: typeof createTicket;
    readonly update: typeof updateTicket;
    readonly changeStatus: typeof changeTicketStatus;
    readonly assign: typeof assignTicket;
    readonly merge: typeof mergeTickets;
    readonly reply: typeof replyToTicket;
    readonly note: typeof addTicketNote;
  };
  readonly contacts: { readonly findOrCreateByEmail: typeof findOrCreateContactByEmail };
  readonly intents: { readonly resolve: typeof resolveIntent };
  readonly workflow: { readonly allows: typeof workflowAllows };
  readonly sla: {
    readonly resolvePolicy: typeof resolveSlaPolicy;
    readonly calendarFor: typeof slaCalendarFor;
    readonly forNewTicket: typeof slaForNewTicket;
    readonly recompute: typeof recomputeSla;
    readonly finishedPauses: typeof finishedSlaPauses;
    readonly resume: typeof resumeSla;
  };
  readonly assignment: {
    readonly assertAssignableStaff: typeof assertAssignableStaff;
    readonly nextRoundRobin: typeof nextRoundRobin;
    readonly peekRoundRobin: typeof peekRoundRobin;
    readonly takeTurn: typeof takeTurn;
  };
  readonly outbox: { readonly enqueue: typeof enqueueJob };
}

export function createDomain(options: DomainOptions): Domain {
  const config: DomainConfig = {
    ticketKeyPrefix: options.ticketKeyPrefix,
    reopenWindowDays: options.reopenWindowDays ?? REOPEN_WINDOW_DAYS,
    sealKey: options.sealKey,
  };
  const now = options.now ?? ((): Date => new Date());
  return {
    config,
    context: (contextOptions) => ({
      actor: contextOptions.actor,
      auditMeta: contextOptions.auditMeta ?? { ip: null, requestId: null },
      now,
      config,
      policyGate: options.policyGate,
      notifier: contextOptions.notifier ?? NO_NOTIFIER,
    }),
    tickets: {
      create: createTicket,
      update: updateTicket,
      changeStatus: changeTicketStatus,
      assign: assignTicket,
      merge: mergeTickets,
      reply: replyToTicket,
      note: addTicketNote,
    },
    contacts: { findOrCreateByEmail: findOrCreateContactByEmail },
    intents: { resolve: resolveIntent },
    workflow: { allows: workflowAllows },
    sla: {
      resolvePolicy: resolveSlaPolicy,
      calendarFor: slaCalendarFor,
      forNewTicket: slaForNewTicket,
      recompute: recomputeSla,
      finishedPauses: finishedSlaPauses,
      resume: resumeSla,
    },
    assignment: { assertAssignableStaff, nextRoundRobin, peekRoundRobin, takeTurn },
    outbox: { enqueue: enqueueJob },
  };
}
