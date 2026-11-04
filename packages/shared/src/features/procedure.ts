/**
 * Procedures per intent (T-303b, ADR-026): this feature's own audit actions, ticket event types and queue names.
 *
 * The task that owns this feature adds entries here and nowhere else in `packages/shared`. The
 * global `AUDIT_ACTIONS`, `TICKET_EVENT_TYPES` and `QUEUE_NAMES` are composed from these records
 * (see `./index.ts`). The contract and the step schema are in `../procedure.ts`.
 */

/** Audit `action` strings written by this feature. Metadata: ids, version and the first 16 hex characters of the steps hash only (ADR-026 section 8). */
export const PROCEDURE_AUDIT_ACTIONS = {
  /** The first draft of an intent's procedure (creates the procedure). */
  procedureCreated: 'procedure.created',
  /** A person saved a draft (text or steps). Metadata: version, hash, which parts changed. */
  procedureDraftSaved: 'procedure.draft_saved',
  /** The compiler agent wrote the steps of a draft. Metadata: ai_run id, prompt version, hash. */
  procedureCompiled: 'procedure.compiled',
  /** A person confirmed the steps of a draft. */
  procedureConfirmed: 'procedure.confirmed',
  /** A person asked for a simulation of a version (the request, T-303d). Metadata: version id and hash digest. */
  procedureSimulationRequested: 'procedure.simulation_requested',
  /** A simulation of a version finished (written by the simulation runner, T-303d). */
  procedureSimulated: 'procedure.simulated',
  /** A version went live for its intent. Metadata: version, hash, simulation id, the version it replaced. */
  procedurePublished: 'procedure.published',
  /** A version was retired (live one: the intent returns to the default runbook) or a draft thrown away. */
  procedureRetired: 'procedure.retired',
  /** A person pressed an escalation card (T-303f). Metadata: via=procedure, proposal id, step id, version id, target kind. */
  procedureEscalationApplied: 'procedure.escalation_applied',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature (T-303c adds the escalation and require-human events). */
export const PROCEDURE_TICKET_EVENTS = {
  /** A procedure step `escalate` matched: a card in the AI sidebar waits for one click (ADR-026 section 7). Payload: step id, target, version id. */
  procedureEscalationProposed: 'procedure.escalation_proposed',
  /** A procedure step `require_human` matched: nothing of this ticket goes out by itself (T-304 reads it, ADR-025 condition 11). Payload: step id, reason, version id. */
  procedureRequireHuman: 'procedure.require_human',
  /** A person pressed the card of an escalation proposal (T-303f). Payload: proposal id (the event id of the proposal), step id, version id, what was done. */
  procedureEscalationApplied: 'procedure.escalation_applied',
} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature. */
export const PROCEDURE_QUEUES = {
  /** Runs the steps of a version on resolved tickets before publish (T-303d). */
  procedureSimulate: 'procedure-simulate',
} as const satisfies Record<string, string>;
