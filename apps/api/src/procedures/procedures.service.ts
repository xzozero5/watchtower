import { Inject, Injectable } from '@nestjs/common';
import { askGuard, compileProcedure } from '@watchtower/ai';
import { schema, type Database } from '@watchtower/db';
import {
  Effects,
  readProcedureSimulation,
  recordAuditInTx,
  type Actor,
  type DomainContext,
  type DomainResult,
} from '@watchtower/domain';
import {
  AUDIT_ACTIONS,
  PROCEDURE_GENERIC_TOOLS,
  PROCEDURE_LIMITS,
  PROCEDURE_SIMULATE_JOB_OPTIONS,
  QUEUE_NAMES,
  type CompileProcedureResult,
  type CreateProcedureVersion,
  type ProcedureSimulateQueued,
  type ProcedureSimulationAnswer,
  type ProcedureValidation,
  type ProcedureVersion,
  type ProcedureVersionList,
  type ProcedureVersionResult,
  type UpdateProcedureVersion,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { AI_RUNTIME, type AiRuntime } from '../ai/ai-runtime.js';
import { ApiHttpError, badRequest, notFound } from '../auth/http-errors.js';
import { DATABASE } from '../database/database.module.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import { UnitOfWorkService, type UnitOfWork } from '../realtime/unit-of-work.js';

const encoder = new TextEncoder();

/**
 * Procedures per intent (T-303b, ADR-026). The rules live in `@watchtower/domain` (validation, versions, publish);
 * the compiler agent is `compileProcedure` of `@watchtower/ai`. This is the Nest face of both: it builds the
 * context, hands the audit mark to the request, and answers refusals with the api's HTTP errors. The AI drafts
 * the steps into a draft version; only a person's `confirm` moves it on.
 */
@Injectable()
export class ProceduresService {
  constructor(
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AI_RUNTIME) private readonly runtime: AiRuntime,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

  list(intentId: string): Promise<ProcedureVersionList> {
    return translating(() => this.domain.procedures.readVersions(this.database.db, intentId));
  }

  get(intentId: string, versionId: string): Promise<ProcedureVersion> {
    return translating(() =>
      this.domain.procedures.readVersion(this.database.db, intentId, versionId),
    );
  }

  /** The steps of a version against this instance's tools, templates and queues. */
  async validation(intentId: string, versionId: string): Promise<ProcedureValidation> {
    return translating(async () => {
      const version = await this.domain.procedures.readVersion(
        this.database.db,
        intentId,
        versionId,
      );
      return this.domain.procedures.validate(this.database.db, intentId, version.steps);
    });
  }

  create(actor: Actor, intentId: string, body: CreateProcedureVersion): Promise<ProcedureVersion> {
    return this.write(actor, (uow, ctx) =>
      this.domain.procedures.createDraft(uow.tx, ctx, {
        intentId,
        sourceMd: body.sourceMd,
        steps: body.steps,
      }),
    );
  }

  update(
    actor: Actor,
    intentId: string,
    versionId: string,
    body: UpdateProcedureVersion,
  ): Promise<ProcedureVersion> {
    return this.write(actor, (uow, ctx) =>
      this.domain.procedures.updateDraft(uow.tx, ctx, {
        intentId,
        versionId,
        sourceMd: body.sourceMd,
        steps: body.steps,
      }),
    );
  }

  async confirm(
    actor: Actor,
    intentId: string,
    versionId: string,
  ): Promise<ProcedureVersionResult> {
    const version = await this.write(actor, (uow, ctx) =>
      this.domain.procedures.confirm(uow.tx, ctx, { intentId, versionId }),
    );
    return { version, validation: await this.validationOf(intentId, version) };
  }

  publish(actor: Actor, intentId: string, versionId: string): Promise<ProcedureVersion> {
    return this.write(actor, (uow, ctx) =>
      this.domain.procedures.publish(uow.tx, ctx, { intentId, versionId }),
    );
  }

  retire(actor: Actor, intentId: string, versionId: string): Promise<ProcedureVersion> {
    return this.write(actor, (uow, ctx) =>
      this.domain.procedures.retire(uow.tx, ctx, { intentId, versionId }),
    );
  }

  /**
   * Asks the compiler agent for the steps of a draft from its text and stores them in the draft. The draft stays
   * a draft: the answer also carries what is wrong with the steps (the tools, templates and queues must exist)
   * and what the model guessed, and a person confirms after reading both.
   */
  async compile(
    actor: Actor,
    intentId: string,
    versionId: string,
  ): Promise<CompileProcedureResult> {
    const version = await this.get(intentId, versionId);
    if (version.status !== 'draft') {
      throw new ApiHttpError(
        409,
        'conflict',
        `A version in status ${version.status} cannot be compiled: write a new version`,
      );
    }
    if (version.sourceMd.trim() === '') throw badRequest('Write the procedure in the text first');
    if (encoder.encode(version.sourceMd).length > PROCEDURE_LIMITS.maxSourceBytes) {
      throw badRequest('The text is over 8 KB');
    }
    if (!this.runtime.ready) {
      throw unavailable(503, this.runtime.notReadyReason ?? 'provider_unavailable');
    }
    const [intent] = await this.database.db
      .select({ key: schema.intent.key })
      .from(schema.intent)
      .where(eq(schema.intent.id, intentId))
      .limit(1);
    if (intent === undefined) throw notFound('No such intent');
    const context = await this.domain.procedures.validationContext(this.database.db, intentId);

    const outcome = await compileProcedure(this.runtime.deps, {
      intentId,
      intentKey: intent.key,
      sourceMd: version.sourceMd,
      tools: [...PROCEDURE_GENERIC_TOOLS, ...context.allowedTools],
      templates: context.templates,
      queueKeys: context.queueKeys,
    });
    if (outcome.status === 'skipped') throw unavailable(503, outcome.reason);
    if (outcome.status === 'failed') {
      throw unavailable(outcome.reason === 'model_output_invalid' ? 502 : 503, outcome.reason);
    }

    const saved = await this.write(actor, (uow, ctx) =>
      this.domain.procedures.recordCompile(uow.tx, ctx, {
        intentId,
        versionId,
        steps: outcome.value.steps,
        aiRunId: outcome.runId,
        promptVersion: outcome.value.promptVersion,
      }),
    );
    return {
      version: saved,
      validation: await this.validationOf(intentId, saved),
      assumptions: [...outcome.value.assumptions],
      promptVersion: outcome.value.promptVersion,
    };
  }

  /**
   * Queues a simulation of a confirmed version (T-303d, ADR-026 section 6): the worker replays resolved tickets of
   * the intent with the steps and writes `procedure_simulation`. The job is idempotent per version and minute, so a
   * double click does not run it twice. Refused (409) for a draft, a published or a retired version, and (503)
   * while the AI cannot run: a simulation is model calls.
   */
  async simulate(
    actor: Actor,
    intentId: string,
    versionId: string,
  ): Promise<ProcedureSimulateQueued> {
    const version = await this.get(intentId, versionId);
    if (version.status !== 'confirmed' && version.status !== 'simulated') {
      throw new ApiHttpError(
        409,
        'conflict',
        `A version in status ${version.status} cannot be simulated: confirm a draft first`,
      );
    }
    if (actor.id === null) throw badRequest('Only a signed-in person may start a simulation');
    if (!this.runtime.ready) {
      throw unavailable(503, this.runtime.notReadyReason ?? 'provider_unavailable');
    }
    // The kill switch and the daily budget say no before a job is queued (the worker asks again for each call).
    const decision = await askGuard(this.runtime.deps.guard, {
      agent: 'investigator',
      ticketId: null,
      action: 'procedure.simulate',
    });
    if (!decision.allowed) throw unavailable(503, decision.reason);
    const requestedBy = actor.id;
    await this.write(actor, async (uow, ctx) => {
      const fx = new Effects();
      await this.domain.outbox.enqueue(uow.tx, this.domain.config, {
        queue: QUEUE_NAMES.procedureSimulate,
        name: 'simulate',
        jobId: `procedure-simulate-${versionId}-${String(Math.floor(Date.now() / 60_000))}`,
        payload: { versionId, requestedBy },
        options: PROCEDURE_SIMULATE_JOB_OPTIONS,
      });
      await recordAuditInTx(uow.tx, ctx, fx, {
        action: AUDIT_ACTIONS.procedureSimulationRequested,
        targetType: 'procedure_version',
        targetId: versionId,
        metadata: {
          intentId,
          versionId,
          version: version.version,
          stepsDigest: version.stepsHash.slice(0, 16),
        },
      });
      return fx.result(undefined);
    });
    return { versionId, queued: true };
  }

  /** The latest simulation of a version; `simulation` is null while none has finished. */
  async simulation(intentId: string, versionId: string): Promise<ProcedureSimulationAnswer> {
    return translating(async () => ({
      versionId,
      simulation: await readProcedureSimulation(this.database.db, intentId, versionId),
    }));
  }

  private validationOf(intentId: string, version: ProcedureVersion): Promise<ProcedureValidation> {
    return translating(() =>
      this.domain.procedures.validate(this.database.db, intentId, version.steps),
    );
  }

  private write<T>(
    actor: Actor,
    work: (uow: UnitOfWork, ctx: DomainContext) => Promise<DomainResult<T>>,
  ): Promise<T> {
    return translating(() =>
      this.uow.run(async (uow) => settle(uow, await work(uow, domainContext(this.domain, actor)))),
    );
  }
}

function unavailable(status: 502 | 503, reason: string): ApiHttpError {
  return new ApiHttpError(
    status,
    'ai_unavailable',
    status === 502
      ? `The compiler's answer did not fit the step schema (${reason}): try again or write the steps by hand`
      : `The compiler is not available (${reason}): write the steps by hand or try later`,
  );
}
