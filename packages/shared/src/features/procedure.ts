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
  /** A simulation of a version finished (written by the simulation runner, T-303d). */
  procedureSimulated: 'procedure.simulated',
  /** A version went live for its intent. Metadata: version, hash, simulation id, the version it replaced. */
  procedurePublished: 'procedure.published',
  /** A version was retired (live one: the intent returns to the default runbook) or a draft thrown away. */
  procedureRetired: 'procedure.retired',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature (T-303c adds the escalation and require-human events). */
export const PROCEDURE_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (T-303d adds `procedure-simulate`). */
export const PROCEDURE_QUEUES = {} as const satisfies Record<string, string>;
