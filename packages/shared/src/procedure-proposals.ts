/**
 * The escalation cards of a ticket (T-303f, ADR-026 sections 7 and 10): what a procedure step `escalate` proposed
 * while the AI investigated, and what a person's one click does. Pure: no I/O.
 *
 *  - `to: { queueKey }`: move the ticket to that team queue, keep the assignee (the queue assigns again);
 *  - `to: { role }`: tell the lead/head who are on shift (all of that role when none is) and leave an internal note;
 *    nobody is assigned;
 *  - `priority`, when the step names one, is set in both cases.
 */
import { z } from 'zod';

import { escalateTargetSchema, stepIdSchema } from './procedure.js';
import { ticketPrioritySchema } from './sla.js';

export const PROCEDURE_PROPOSAL_STATUSES = ['pending', 'applied', 'expired'] as const;
export type ProcedureProposalStatus = (typeof PROCEDURE_PROPOSAL_STATUSES)[number];

/** Why a card cannot be pressed: the procedure changed (`version_changed`) or the ticket is done (`ticket_closed`). */
export const PROCEDURE_PROPOSAL_EXPIRED_REASONS = ['version_changed', 'ticket_closed'] as const;
export type ProcedureProposalExpiredReason = (typeof PROCEDURE_PROPOSAL_EXPIRED_REASONS)[number];

export const procedureProposalSchema = z.object({
  /** The id of the `procedure.escalation_proposed` ticket event. */
  id: z.uuid(),
  stepId: stepIdSchema,
  versionId: z.uuid(),
  to: escalateTargetSchema,
  priority: ticketPrioritySchema.optional(),
  /** The note of the step, written by the lead who made the procedure. */
  note: z.string().max(300),
  status: z.enum(PROCEDURE_PROPOSAL_STATUSES),
  expiredReason: z.enum(PROCEDURE_PROPOSAL_EXPIRED_REASONS).optional(),
  createdAt: z.iso.datetime(),
  appliedAt: z.iso.datetime().optional(),
});
export type ProcedureProposal = z.infer<typeof procedureProposalSchema>;

export const procedureProposalListSchema = z.object({
  items: z.array(procedureProposalSchema).max(20),
});
export type ProcedureProposalList = z.infer<typeof procedureProposalListSchema>;

export const procedureProposalParamsSchema = z.object({
  id: z.string().trim().min(1).max(80),
  proposalId: z.uuid(),
});

/** What the click did. `alreadyApplied`: a second press changes nothing and answers the same. */
export const procedureProposalAppliedSchema = z.object({
  proposalId: z.uuid(),
  alreadyApplied: z.boolean(),
  action: z.enum(['moved_queue', 'asked_role']),
  /** People told (role target only); 0 for a queue move. */
  notified: z.number().int().nonnegative(),
  priority: ticketPrioritySchema.optional(),
});
export type ProcedureProposalApplied = z.infer<typeof procedureProposalAppliedSchema>;
