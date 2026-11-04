import { schema, type Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  PROCEDURE_REQUIRE_HUMAN_TAG,
  PROCEDURE_TICKET_EVENTS,
  procedureSimulationMetricsSchema,
  procedureStepsSchema,
  type ProcedureSimulationMetrics,
  type ProcedureSimulationResult,
  type ProcedureSteps,
} from '@watchtower/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { notFound } from '../errors.js';
import { Effects, type ReadExecutor } from '../types.js';

/**
 * What the AI runtime needs of a procedure (T-303c, T-303d): the version that is live for an intent, the
 * records an investigation leaves for a person (an escalation proposal, a call for a person), the tickets a
 * simulation replays and the simulation row itself. Reads and appends only; nothing here sends or changes
 * a ticket besides a tag (N2, N3).
 */

type Db = Database['db'];

export interface PublishedProcedure {
  readonly versionId: string;
  readonly version: number;
  readonly steps: ProcedureSteps;
}

/**
 * The version of the procedure the intent runs now (`intent.procedure_version_id`, status `published`), or null:
 * the default runbook. Steps that no longer fit the schema (a version written by a later release) are not run: the
 * intent falls back to the default runbook instead of failing the investigation.
 */
export async function readPublishedProcedure(
  db: ReadExecutor,
  intentId: string,
): Promise<PublishedProcedure | null> {
  const [row] = await db
    .select({
      id: schema.procedureVersion.id,
      version: schema.procedureVersion.version,
      steps: schema.procedureVersion.steps,
      status: schema.procedureVersion.status,
    })
    .from(schema.intent)
    .innerJoin(
      schema.procedureVersion,
      eq(schema.procedureVersion.id, schema.intent.procedureVersionId),
    )
    .where(eq(schema.intent.id, intentId))
    .limit(1);
  if (row === undefined || row.status !== 'published') return null;
  const parsed = procedureStepsSchema.safeParse(row.steps);
  return parsed.success ? { versionId: row.id, version: row.version, steps: parsed.data } : null;
}

export interface ProcedureOutcomeInput {
  readonly ticketId: string;
  readonly versionId: string;
  readonly escalations: readonly {
    readonly stepId: string;
    readonly to: { readonly queueKey: string } | { readonly role: 'lead' | 'head' };
    readonly priority?: string | undefined;
    readonly note: string;
  }[];
  readonly requireHuman: readonly { readonly stepId: string; readonly reason: string }[];
}

/**
 * Leaves what a procedure asked for on the ticket: one `procedure.escalation_proposed` event per escalate step
 * (the card in the AI sidebar waits for a person's click; nothing is done yet) and, when a step calls for a
 * person, one `procedure.require_human` event and the tag the queue shows (T-304 and the auto-send gate read the
 * event). A step already recorded for this ticket and version is not recorded twice, so a second investigation
 * does not pile up cards. Returns what was newly written.
 */
export async function recordProcedureOutcome(
  db: Db,
  input: ProcedureOutcomeInput,
): Promise<{ proposed: string[]; requiredHuman: string[] }> {
  const written = { proposed: [] as string[], requiredHuman: [] as string[] };
  if (input.escalations.length === 0 && input.requireHuman.length === 0) return written;
  await db.transaction(async (tx) => {
    const seen = await tx
      .select({
        type: schema.ticketEvent.type,
        stepId: sql<string>`${schema.ticketEvent.payload}->>'stepId'`,
      })
      .from(schema.ticketEvent)
      .where(
        and(
          eq(schema.ticketEvent.ticketId, input.ticketId),
          sql`${schema.ticketEvent.type} IN (${PROCEDURE_TICKET_EVENTS.procedureEscalationProposed}, ${PROCEDURE_TICKET_EVENTS.procedureRequireHuman})`,
          sql`${schema.ticketEvent.payload}->>'versionId' = ${input.versionId}`,
        ),
      );
    const done = new Set(seen.map((event) => `${event.type}:${event.stepId}`));
    for (const escalation of input.escalations) {
      const type = PROCEDURE_TICKET_EVENTS.procedureEscalationProposed;
      if (done.has(`${type}:${escalation.stepId}`)) continue;
      await tx.insert(schema.ticketEvent).values({
        ticketId: input.ticketId,
        type,
        actorType: 'ai',
        actorId: null,
        visibility: 'internal',
        payload: {
          versionId: input.versionId,
          stepId: escalation.stepId,
          to: escalation.to,
          ...(escalation.priority === undefined ? {} : { priority: escalation.priority }),
          note: escalation.note,
        },
      });
      written.proposed.push(escalation.stepId);
    }
    for (const step of input.requireHuman) {
      const type = PROCEDURE_TICKET_EVENTS.procedureRequireHuman;
      if (done.has(`${type}:${step.stepId}`)) continue;
      await tx.insert(schema.ticketEvent).values({
        ticketId: input.ticketId,
        type,
        actorType: 'ai',
        actorId: null,
        visibility: 'internal',
        payload: { versionId: input.versionId, stepId: step.stepId, reason: step.reason },
      });
      written.requiredHuman.push(step.stepId);
    }
    if (input.requireHuman.length > 0) {
      // The label a lead sees in the queue. At most 30 tags on a ticket (`ticketTagsSchema`).
      await tx
        .update(schema.ticket)
        .set({ tags: sql`array_append(${schema.ticket.tags}, ${PROCEDURE_REQUIRE_HUMAN_TAG})` })
        .where(
          and(
            eq(schema.ticket.id, input.ticketId),
            sql`NOT (${schema.ticket.tags} @> ARRAY[${PROCEDURE_REQUIRE_HUMAN_TAG}]::text[])`,
            sql`cardinality(${schema.ticket.tags}) < 30`,
          ),
        );
    }
  });
  return written;
}

/** True while a person has not been through a `require_human` call of this ticket's procedure (T-304 reads this). */
export async function ticketRequiresHuman(db: ReadExecutor, ticketId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.ticketEvent.id })
    .from(schema.ticketEvent)
    .where(
      and(
        eq(schema.ticketEvent.ticketId, ticketId),
        eq(schema.ticketEvent.type, PROCEDURE_TICKET_EVENTS.procedureRequireHuman),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// --- simulation ----------------------------------------------------------------------------------------------

export interface SimulationTarget {
  readonly versionId: string;
  readonly procedureId: string;
  readonly intentId: string;
  readonly intentKey: string;
  readonly intentStage: number;
  readonly status: string;
  readonly steps: ProcedureSteps;
  readonly stepsHash: string;
  /** The version live now, or null (the default runbook): what the new steps are compared with. */
  readonly baseline: PublishedProcedure | null;
}

/** The version to simulate and the one to compare it with. Null when the version, or its intent, is gone. */
export async function readSimulationTarget(
  db: ReadExecutor,
  versionId: string,
): Promise<SimulationTarget | null> {
  const [row] = await db
    .select({
      version: schema.procedureVersion,
      intentId: schema.intent.id,
      intentKey: schema.intent.key,
      stage: schema.intent.autonomyStage,
    })
    .from(schema.procedureVersion)
    .innerJoin(schema.procedure, eq(schema.procedure.id, schema.procedureVersion.procedureId))
    .innerJoin(schema.intent, eq(schema.intent.id, schema.procedure.intentId))
    .where(eq(schema.procedureVersion.id, versionId))
    .limit(1);
  if (row === undefined) return null;
  const steps = procedureStepsSchema.safeParse(row.version.steps);
  if (!steps.success) return null;
  const published = await readPublishedProcedure(db, row.intentId);
  return {
    versionId: row.version.id,
    procedureId: row.version.procedureId,
    intentId: row.intentId,
    intentKey: row.intentKey,
    intentStage: row.stage,
    status: row.version.status,
    steps: steps.data,
    stepsHash: row.version.stepsHash,
    baseline: published !== null && published.versionId === versionId ? null : published,
  };
}

export interface SimulationTicket {
  readonly id: string;
  readonly number: number;
  readonly subject: string;
  readonly channel: string;
  readonly priority: string;
  readonly reopenCount: number;
  readonly orgId: string;
  readonly orgTier: string | null;
  readonly requesterContactId: string | null;
  readonly seeded: boolean;
  /** The conversation up to the first reply a person sent (what the AI would have seen). */
  readonly messages: readonly {
    readonly direction: string;
    readonly visibility: string;
    readonly text: string;
    readonly emailMeta: unknown;
  }[];
  /** The first reply a person sent to the customer. */
  readonly humanReply: string;
}

const COLUMN_RECHECK = { present: false };

/** True when `ticket.seed_batch_id` exists (migration 0096): checked at run time, like the reports do. */
export async function ticketSeedColumnExists(
  db: ReadExecutor & Pick<Db, 'execute'>,
): Promise<boolean> {
  if (COLUMN_RECHECK.present) return true;
  const result = await db.execute(
    sql`SELECT 1 AS found FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'ticket' AND column_name = 'seed_batch_id'`,
  );
  COLUMN_RECHECK.present = result.rows.length > 0;
  return COLUMN_RECHECK.present;
}

/**
 * The newest resolved tickets of an intent a simulation can replay: tickets with a customer message and a reply
 * from a person. Tickets of a seed batch (demo data) come last and only to fill up to `limit`; they are marked
 * `seeded`, and a run that used any of them does not count at stage 3 (ADR-026 section 6).
 */
export async function readSimulationTickets(
  db: Db,
  input: { readonly intentId: string; readonly limit: number },
): Promise<SimulationTicket[]> {
  const hasSeed = await ticketSeedColumnExists(db);
  const pick = async (seeded: boolean, limit: number): Promise<SimulationTicket[]> => {
    const seedCondition = hasSeed
      ? seeded
        ? sql`AND t.seed_batch_id IS NOT NULL`
        : sql`AND t.seed_batch_id IS NULL`
      : seeded
        ? sql`AND false`
        : sql``;
    const found = await db.execute<{ id: string }>(sql`
      SELECT t.id FROM ticket t
      WHERE t.intent_id = ${input.intentId} AND t.status IN ('resolved', 'closed') ${seedCondition}
      ORDER BY COALESCE(t.resolved_at, t.closed_at, t.updated_at) DESC, t.id DESC
      LIMIT ${limit * 3}`);
    const tickets: SimulationTicket[] = [];
    for (const { id } of found.rows) {
      if (tickets.length >= limit) break;
      const [ticket] = await db
        .select({
          id: schema.ticket.id,
          number: schema.ticket.number,
          subject: schema.ticket.subject,
          channel: schema.ticket.channel,
          priority: schema.ticket.priority,
          reopenCount: schema.ticket.reopenCount,
          orgId: schema.ticket.orgId,
          orgTier: schema.organization.tier,
          requesterContactId: schema.ticket.requesterContactId,
        })
        .from(schema.ticket)
        .innerJoin(schema.organization, eq(schema.organization.id, schema.ticket.orgId))
        .where(eq(schema.ticket.id, id))
        .limit(1);
      if (ticket === undefined) continue;
      const all = await db
        .select({
          direction: schema.message.direction,
          visibility: schema.message.visibility,
          text: schema.message.bodyText,
          emailMeta: schema.message.emailMeta,
        })
        .from(schema.message)
        .where(eq(schema.message.ticketId, id))
        .orderBy(asc(schema.message.createdAt))
        .limit(60);
      const firstReply = all.findIndex(
        (message) => message.direction === 'outbound' && message.visibility !== 'internal',
      );
      if (firstReply <= 0) continue;
      const before = all.slice(0, firstReply);
      const reply = all[firstReply];
      if (
        reply === undefined ||
        !before.some((message) => message.direction === 'inbound') ||
        reply.text.trim() === ''
      ) {
        continue;
      }
      tickets.push({ ...ticket, seeded, messages: before, humanReply: reply.text });
    }
    return tickets;
  };
  const real = await pick(false, input.limit);
  if (real.length >= input.limit || !hasSeed) return real;
  return [...real, ...(await pick(true, input.limit - real.length))];
}

export interface RecordSimulationInput {
  readonly versionId: string;
  readonly passed: boolean;
  readonly seedOnly: boolean;
  readonly caseCount: number;
  readonly metrics: ProcedureSimulationMetrics;
  readonly ranBy: string | null;
}

/**
 * Appends the result of a simulation. The database does the rest: the row takes the hash of the steps it ran
 * on, and a trigger moves the version to `simulated` (passed) or keeps it `confirmed` (failed) (migration 0097).
 * An audit row `procedure.simulated` carries ids and counts only.
 */
export async function recordProcedureSimulation(
  db: Db,
  input: RecordSimulationInput,
): Promise<{ id: string }> {
  const metrics = procedureSimulationMetricsSchema.parse(input.metrics);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.procedureSimulation)
      .values({
        procedureVersionId: input.versionId,
        passed: input.passed,
        seedOnly: input.seedOnly,
        caseCount: input.caseCount,
        metrics,
        ranBy: input.ranBy,
      })
      .returning({ id: schema.procedureSimulation.id });
    if (row === undefined) throw new Error('procedure_simulation insert returned no row');
    await recordAuditInTx(
      tx,
      { actor: { type: 'system', id: null }, auditMeta: { ip: null, requestId: null } },
      new Effects(),
      {
        action: AUDIT_ACTIONS.procedureSimulated,
        outcome: input.passed ? 'success' : 'failure',
        targetType: 'procedure_version',
        targetId: input.versionId,
        metadata: {
          simulationId: row.id,
          passed: input.passed,
          seedOnly: input.seedOnly,
          caseCount: input.caseCount,
          failReasons: metrics.failReasons,
          requestedBy: input.ranBy,
        },
      },
    );
    return { id: row.id };
  });
}

/** The latest simulation of a version of this intent, or null. 404 when the version is not this intent's. */
export async function readProcedureSimulation(
  db: ReadExecutor,
  intentId: string,
  versionId: string,
): Promise<ProcedureSimulationResult | null> {
  const [owned] = await db
    .select({ id: schema.procedureVersion.id })
    .from(schema.procedureVersion)
    .innerJoin(schema.procedure, eq(schema.procedure.id, schema.procedureVersion.procedureId))
    .where(and(eq(schema.procedureVersion.id, versionId), eq(schema.procedure.intentId, intentId)))
    .limit(1);
  if (owned === undefined) throw notFound('No such procedure version');
  const [row] = await db
    .select()
    .from(schema.procedureSimulation)
    .where(eq(schema.procedureSimulation.procedureVersionId, versionId))
    .orderBy(desc(schema.procedureSimulation.createdAt), desc(schema.procedureSimulation.id))
    .limit(1);
  if (row === undefined) return null;
  const metrics = procedureSimulationMetricsSchema.safeParse(row.metrics);
  if (!metrics.success) return null;
  return {
    id: row.id,
    versionId: row.procedureVersionId,
    stepsHash: row.stepsHash,
    passed: row.passed,
    seedOnly: row.seedOnly,
    caseCount: row.caseCount,
    metrics: metrics.data,
    ranBy: row.ranBy,
    createdAt: row.createdAt.toISOString(),
  };
}
