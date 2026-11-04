import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  EMPTY_PROCEDURE_STEPS,
  procedureStepsSchema,
  type ProcedureSteps,
  type ProcedureValidation,
  type ProcedureVersion,
  type ProcedureVersionList,
  type ProcedureVersionStatus,
} from '@watchtower/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { recordAuditInTx, type AuditEntry } from '../audit.js';
import { DomainError, badRequest, conflict, notFound } from '../errors.js';
import {
  Effects,
  type DbTransaction,
  type DomainContext,
  type DomainResult,
  type ReadExecutor,
} from '../types.js';
import { validateProcedureSteps, type ProcedureValidationContext } from './validate.js';

type VersionRow = typeof schema.procedureVersion.$inferSelect;
type SimulationRow = typeof schema.procedureSimulation.$inferSelect;

/** Postgres error codes raised by `publish_procedure_version()` and `retire_procedure_version()` (migration 0097). */
const SQLSTATE_BAD_STATUS = 'WT110';
const SQLSTATE_NO_SIMULATION = 'WT111';
const SQLSTATE_SIMULATION_OLD = 'WT112';
const SQLSTATE_SAME_PERSON = 'WT113';
const SQLSTATE_SEEDED = 'WT114';
const SQLSTATE_ARCHIVED = 'WT115';
const SQLSTATE_NO_ROW = 'P0002';
const SQLSTATE_UNIQUE = '23505';

function pgCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  // Drizzle wraps driver errors; the SQLSTATE sits on `cause`.
  if ('cause' in error) return pgCode(error.cause);
  return undefined;
}

/** Only a signed-in person writes a procedure: neither the AI nor a system sender (ADR-026 section 3). */
function requirePerson(ctx: DomainContext, what: string): string {
  if (ctx.actor.type !== 'user' || ctx.actor.id === null) {
    throw new DomainError('policy_denied', `Only a signed-in person may ${what}`, {
      reason: 'actor_not_a_person',
    });
  }
  return ctx.actor.id;
}

function parseSteps(value: unknown): ProcedureSteps {
  const parsed = procedureStepsSchema.safeParse(value);
  if (!parsed.success) {
    throw conflict('The stored steps do not match this version of the schema');
  }
  return parsed.data;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function toProcedureVersion(
  row: VersionRow,
  intentId: string,
  simulation: SimulationRow | undefined,
): ProcedureVersion {
  return {
    id: row.id,
    procedureId: row.procedureId,
    intentId,
    version: row.version,
    status: row.status as ProcedureVersionStatus,
    sourceMd: row.sourceMd,
    steps: parseSteps(row.steps),
    schemaVersion: row.schemaVersion,
    stepsHash: row.stepsHash,
    compiledByAiRunId: row.compiledByAiRunId,
    authoredBy: row.authoredBy,
    confirmedBy: row.confirmedBy,
    confirmedAt: iso(row.confirmedAt),
    publishedBy: row.publishedBy,
    publishedAt: iso(row.publishedAt),
    retiredBy: row.retiredBy,
    retiredAt: iso(row.retiredAt),
    createdAt: row.createdAt.toISOString(),
    simulation:
      simulation === undefined
        ? null
        : {
            id: simulation.id,
            passed: simulation.passed,
            seedOnly: simulation.seedOnly,
            caseCount: simulation.caseCount,
            createdAt: simulation.createdAt.toISOString(),
          },
  };
}

async function latestSimulations(
  executor: ReadExecutor,
  versionIds: readonly string[],
): Promise<Map<string, SimulationRow>> {
  const latest = new Map<string, SimulationRow>();
  if (versionIds.length === 0) return latest;
  const rows = await executor
    .select()
    .from(schema.procedureSimulation)
    .where(inArray(schema.procedureSimulation.procedureVersionId, [...versionIds]))
    .orderBy(desc(schema.procedureSimulation.createdAt), desc(schema.procedureSimulation.id));
  for (const row of rows) {
    if (!latest.has(row.procedureVersionId)) latest.set(row.procedureVersionId, row);
  }
  return latest;
}

async function requireIntent(
  executor: ReadExecutor,
  intentId: string,
): Promise<typeof schema.intent.$inferSelect> {
  const [intent] = await executor
    .select()
    .from(schema.intent)
    .where(eq(schema.intent.id, intentId))
    .limit(1);
  if (intent === undefined) throw notFound('No such intent');
  return intent;
}

/** The versions of an intent's procedure, newest first (at most 100), and which one runs now. */
export async function readProcedureVersions(
  executor: ReadExecutor,
  intentId: string,
): Promise<ProcedureVersionList> {
  const intent = await requireIntent(executor, intentId);
  const [procedure] = await executor
    .select()
    .from(schema.procedure)
    .where(eq(schema.procedure.intentId, intentId))
    .limit(1);
  if (procedure === undefined) {
    return { procedureId: null, publishedVersionId: intent.procedureVersionId, items: [] };
  }
  const rows = await executor
    .select()
    .from(schema.procedureVersion)
    .where(eq(schema.procedureVersion.procedureId, procedure.id))
    .orderBy(desc(schema.procedureVersion.version))
    .limit(100);
  const simulations = await latestSimulations(
    executor,
    rows.map((row) => row.id),
  );
  return {
    procedureId: procedure.id,
    publishedVersionId: intent.procedureVersionId,
    items: rows.map((row) => toProcedureVersion(row, intentId, simulations.get(row.id))),
  };
}

async function loadVersion(
  executor: ReadExecutor,
  intentId: string,
  versionId: string,
): Promise<{ row: VersionRow; version: ProcedureVersion }> {
  const [found] = await executor
    .select({ row: schema.procedureVersion })
    .from(schema.procedureVersion)
    .innerJoin(schema.procedure, eq(schema.procedure.id, schema.procedureVersion.procedureId))
    .where(and(eq(schema.procedureVersion.id, versionId), eq(schema.procedure.intentId, intentId)))
    .limit(1);
  if (found === undefined) throw notFound('No such procedure version');
  const simulations = await latestSimulations(executor, [versionId]);
  return {
    row: found.row,
    version: toProcedureVersion(found.row, intentId, simulations.get(versionId)),
  };
}

export async function readProcedureVersion(
  executor: ReadExecutor,
  intentId: string,
  versionId: string,
): Promise<ProcedureVersion> {
  return (await loadVersion(executor, intentId, versionId)).version;
}

/** What the steps of this intent are checked against: its granted tools, its AI templates and the team queues. */
export async function readProcedureValidationContext(
  executor: ReadExecutor,
  intentId: string,
): Promise<ProcedureValidationContext> {
  const intent = await requireIntent(executor, intentId);
  const [templates, queues] = await Promise.all([
    executor
      .select({ name: schema.toolTemplate.name, kind: schema.toolTemplate.kind })
      .from(schema.toolTemplate)
      .where(
        and(
          eq(schema.toolTemplate.intentId, intentId),
          eq(schema.toolTemplate.active, true),
          eq(schema.toolTemplate.runByAi, true),
        ),
      )
      .orderBy(asc(schema.toolTemplate.name)),
    executor.select({ name: schema.teamQueue.name }).from(schema.teamQueue),
  ]);
  return {
    allowedTools: intent.allowedTools,
    templates: templates.flatMap((template) =>
      template.kind === 'logs' || template.kind === 'data'
        ? [{ name: template.name, kind: template.kind }]
        : [],
    ),
    queueKeys: queues.map((queue) => queue.name),
  };
}

export async function validateProcedureVersion(
  executor: ReadExecutor,
  intentId: string,
  steps: ProcedureSteps,
): Promise<ProcedureValidation> {
  return validateProcedureSteps(steps, await readProcedureValidationContext(executor, intentId));
}

function metadata(
  version: ProcedureVersion,
  extra: Record<string, unknown> = {},
): AuditEntry['metadata'] {
  // Ids, version and hash only (ADR-026 section 8): the text and the steps stay in the version row.
  return {
    intentId: version.intentId,
    procedureId: version.procedureId,
    versionId: version.id,
    version: version.version,
    // The first 16 hex characters: the audit redactor masks a full 256-bit hash, and the row has the whole one.
    stepsDigest: version.stepsHash.slice(0, 16),
    ...extra,
  };
}

async function audit(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  action: string,
  version: ProcedureVersion,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await recordAuditInTx(tx, ctx, fx, {
    action,
    targetType: 'procedure_version',
    targetId: version.id,
    metadata: metadata(version, extra),
  });
}

export interface CreateProcedureDraftInput {
  readonly intentId: string;
  readonly sourceMd: string;
  readonly steps?: ProcedureSteps | undefined;
}

/** A new draft version; the first one creates the intent's procedure. */
export async function createProcedureDraft(
  tx: DbTransaction,
  ctx: DomainContext,
  input: CreateProcedureDraftInput,
): Promise<DomainResult<ProcedureVersion>> {
  const fx = new Effects();
  const actor = requirePerson(ctx, 'write a procedure');
  await requireIntent(tx, input.intentId);
  let createdProcedure = false;
  const inserted = await tx
    .insert(schema.procedure)
    .values({ intentId: input.intentId, createdBy: actor })
    .onConflictDoNothing({ target: schema.procedure.intentId })
    .returning({ id: schema.procedure.id });
  let procedureId = inserted[0]?.id;
  if (procedureId === undefined) {
    const [existing] = await tx
      .select({ id: schema.procedure.id, archivedAt: schema.procedure.archivedAt })
      .from(schema.procedure)
      .where(eq(schema.procedure.intentId, input.intentId))
      .limit(1);
    if (existing === undefined) throw conflict('The procedure could not be created: try again');
    if (existing.archivedAt !== null) throw conflict('The procedure of this intent is archived');
    procedureId = existing.id;
  } else {
    createdProcedure = true;
  }
  const [row] = await tx
    .insert(schema.procedureVersion)
    .values({
      procedureId,
      sourceMd: input.sourceMd,
      steps: input.steps ?? EMPTY_PROCEDURE_STEPS,
      schemaVersion: 1,
      authoredBy: actor,
    })
    .returning();
  if (row === undefined) throw conflict('The version could not be created: try again');
  const version = toProcedureVersion(row, input.intentId, undefined);
  if (createdProcedure) {
    await recordAuditInTx(tx, ctx, fx, {
      action: AUDIT_ACTIONS.procedureCreated,
      targetType: 'procedure',
      targetId: procedureId,
      metadata: {
        intentId: input.intentId,
        procedureId,
        versionId: version.id,
        version: version.version,
      },
    });
  } else {
    await audit(tx, ctx, fx, AUDIT_ACTIONS.procedureDraftSaved, version, { created: true });
  }
  return fx.result(version);
}

export interface UpdateProcedureDraftInput {
  readonly intentId: string;
  readonly versionId: string;
  readonly sourceMd?: string | undefined;
  readonly steps?: ProcedureSteps | undefined;
}

/** Edits a draft. Anything that left draft is frozen (the database refuses too): write a new version. */
export async function updateProcedureDraft(
  tx: DbTransaction,
  ctx: DomainContext,
  input: UpdateProcedureDraftInput,
): Promise<DomainResult<ProcedureVersion>> {
  const fx = new Effects();
  requirePerson(ctx, 'write a procedure');
  const { row } = await loadVersion(tx, input.intentId, input.versionId);
  if (row.status !== 'draft') {
    throw conflict(`A version in status ${row.status} cannot be edited: write a new version`);
  }
  const set: Partial<typeof schema.procedureVersion.$inferInsert> = {};
  if (input.sourceMd !== undefined) set.sourceMd = input.sourceMd;
  if (input.steps !== undefined) set.steps = input.steps;
  if (Object.keys(set).length === 0) throw badRequest('Send sourceMd, steps or both');
  const [updated] = await tx
    .update(schema.procedureVersion)
    .set(set)
    .where(and(eq(schema.procedureVersion.id, row.id), eq(schema.procedureVersion.status, 'draft')))
    .returning();
  if (updated === undefined) throw conflict('The version was changed by someone else: reload it');
  const version = toProcedureVersion(updated, input.intentId, undefined);
  await audit(tx, ctx, fx, AUDIT_ACTIONS.procedureDraftSaved, version, {
    changed: Object.keys(set).map((key) => (key === 'sourceMd' ? 'source' : 'steps')),
  });
  return fx.result(version);
}

export interface RecordProcedureCompileInput {
  readonly intentId: string;
  readonly versionId: string;
  readonly steps: ProcedureSteps;
  readonly aiRunId: string | null;
  readonly promptVersion: number;
}

/** Stores the steps the compiler wrote into the draft. The draft stays a draft: a person confirms (ADR-026 section 3). */
export async function recordProcedureCompile(
  tx: DbTransaction,
  ctx: DomainContext,
  input: RecordProcedureCompileInput,
): Promise<DomainResult<ProcedureVersion>> {
  const fx = new Effects();
  requirePerson(ctx, 'compile a procedure');
  const { row } = await loadVersion(tx, input.intentId, input.versionId);
  if (row.status !== 'draft') {
    throw conflict(`A version in status ${row.status} cannot be compiled: write a new version`);
  }
  const [updated] = await tx
    .update(schema.procedureVersion)
    .set({ steps: input.steps, compiledByAiRunId: input.aiRunId })
    .where(and(eq(schema.procedureVersion.id, row.id), eq(schema.procedureVersion.status, 'draft')))
    .returning();
  if (updated === undefined) throw conflict('The version was changed by someone else: reload it');
  const version = toProcedureVersion(updated, input.intentId, undefined);
  await audit(tx, ctx, fx, AUDIT_ACTIONS.procedureCompiled, version, {
    aiRunId: input.aiRunId,
    promptVersion: input.promptVersion,
  });
  return fx.result(version);
}

function describeIssues(validation: ProcedureValidation): string {
  const shown = validation.issues.slice(0, 5).map((issue) => issue.message);
  const more =
    validation.issues.length > 5 ? ` (and ${String(validation.issues.length - 5)} more)` : '';
  return `${shown.join('; ')}${more}`;
}

/** A person confirms the steps of a draft. Refused while the semantic validation finds a problem. */
export async function confirmProcedureVersion(
  tx: DbTransaction,
  ctx: DomainContext,
  input: { readonly intentId: string; readonly versionId: string },
): Promise<DomainResult<ProcedureVersion>> {
  const fx = new Effects();
  const actor = requirePerson(ctx, 'confirm a procedure');
  const { row, version: current } = await loadVersion(tx, input.intentId, input.versionId);
  if (row.status !== 'draft')
    throw conflict(`A version in status ${row.status} cannot be confirmed`);
  if (current.steps.steps.length === 0) {
    throw badRequest('A procedure with no steps cannot be confirmed');
  }
  const validation = await validateProcedureVersion(tx, input.intentId, current.steps);
  if (!validation.ok) throw badRequest(`The steps have problems: ${describeIssues(validation)}`);
  const [updated] = await tx
    .update(schema.procedureVersion)
    .set({ status: 'confirmed', confirmedBy: actor, confirmedAt: ctx.now() })
    .where(and(eq(schema.procedureVersion.id, row.id), eq(schema.procedureVersion.status, 'draft')))
    .returning();
  if (updated === undefined) throw conflict('The version was changed by someone else: reload it');
  const version = toProcedureVersion(updated, input.intentId, undefined);
  await audit(tx, ctx, fx, AUDIT_ACTIONS.procedureConfirmed, version, {
    compiledByAi: version.compiledByAiRunId !== null,
  });
  return fx.result(version);
}

/** Maps the SQLSTATEs of the two SECURITY DEFINER functions to the domain's refusals. */
function translateFunctionError(error: unknown): never {
  switch (pgCode(error)) {
    case SQLSTATE_NO_ROW:
      throw notFound('No such procedure version');
    case SQLSTATE_BAD_STATUS:
      throw conflict('This version cannot go there from its status');
    case SQLSTATE_NO_SIMULATION:
      throw conflict('Publishing needs a simulation of these exact steps that passed');
    case SQLSTATE_SIMULATION_OLD:
      throw conflict('The simulation is older than 30 days: run it again');
    case SQLSTATE_SAME_PERSON:
      throw new DomainError(
        'policy_denied',
        'For an intent at stage 3 the person who publishes must not be the person who confirmed',
        { reason: 'same_person' },
      );
    case SQLSTATE_SEEDED:
      throw new DomainError(
        'policy_denied',
        'For an intent at stage 3 a simulation on seeded tickets does not count',
        { reason: 'seed_simulation' },
      );
    case SQLSTATE_ARCHIVED:
      throw conflict('The procedure of this intent is archived');
    case SQLSTATE_UNIQUE:
      throw conflict('Another version was published at the same time: reload it');
    default:
      throw error;
  }
}

/**
 * Publishes a version through `publish_procedure_version()`: the database insists on a passing, recent
 * simulation of the same steps and does the retire-and-point in one transaction. The steps are checked
 * again here, because the intent's tools and templates may have changed since the person confirmed.
 */
export async function publishProcedureVersion(
  tx: DbTransaction,
  ctx: DomainContext,
  input: { readonly intentId: string; readonly versionId: string },
): Promise<DomainResult<ProcedureVersion>> {
  const fx = new Effects();
  const actor = requirePerson(ctx, 'publish a procedure');
  const { version: before } = await loadVersion(tx, input.intentId, input.versionId);
  if (before.status === 'published') throw conflict('This version is already published');
  const validation = await validateProcedureVersion(tx, input.intentId, before.steps);
  if (!validation.ok) throw badRequest(`The steps have problems: ${describeIssues(validation)}`);
  let previous: string | null;
  try {
    const result = await tx.execute<{ previous: string | null }>(
      sql`SELECT public.publish_procedure_version(${input.versionId}::uuid, ${actor}::uuid) AS previous`,
    );
    previous = result.rows[0]?.previous ?? null;
  } catch (error) {
    translateFunctionError(error);
  }
  const { version } = await loadVersion(tx, input.intentId, input.versionId);
  await audit(tx, ctx, fx, AUDIT_ACTIONS.procedurePublished, version, {
    simulationId: version.simulation?.id ?? null,
    replacedVersionId: previous,
    rollback: before.status === 'retired',
  });
  return fx.result(version);
}

/** Retires the live version (the intent returns to the default runbook) or throws a draft away. */
export async function retireProcedureVersion(
  tx: DbTransaction,
  ctx: DomainContext,
  input: { readonly intentId: string; readonly versionId: string },
): Promise<DomainResult<ProcedureVersion>> {
  const fx = new Effects();
  const actor = requirePerson(ctx, 'retire a procedure version');
  const { version: before } = await loadVersion(tx, input.intentId, input.versionId);
  let wasLive: boolean;
  try {
    const result = await tx.execute<{ was: boolean }>(
      sql`SELECT public.retire_procedure_version(${input.versionId}::uuid, ${actor}::uuid) AS was`,
    );
    wasLive = result.rows[0]?.was ?? false;
  } catch (error) {
    translateFunctionError(error);
  }
  const { version } = await loadVersion(tx, input.intentId, input.versionId);
  await audit(tx, ctx, fx, AUDIT_ACTIONS.procedureRetired, version, {
    wasLive,
    statusBefore: before.status,
  });
  return fx.result(version);
}
