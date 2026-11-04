import { randomUUID } from 'node:crypto';

import {
  buildAllowList,
  createToolRegistry,
  investigationTools,
  runProcedureSimulation,
  withToolBudget,
  type AgentDeps,
  type AutonomyStage,
  type SimulationCaseInput,
  type SimulationEnv,
  type TicketTurn,
} from '@watchtower/ai';
import { schema } from '@watchtower/db';
import {
  TicketKeys,
  createDbToolLedger,
  effectiveStage,
  readSimulationTarget,
  readSimulationTickets,
  recordProcedureSimulation,
  type SimulationTicket,
} from '@watchtower/domain';
import {
  PROCEDURE_SIMULATION,
  detectLanguage,
  type AiInsightReason,
  type ProcedureSimulationMetrics,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { disclosureFor, senderAuthenticated, type InvestigationDeps } from './investigation.js';
import { ticketPeopleNames, warnIfIncomplete } from './people-names.js';
import {
  createKbSearchPort,
  createOrgContextPort,
  createSimilarTicketsPort,
} from './tool-ports.js';

/** `[ASSUMED]` a simulation of 30 tickets and two variants each may run this long before it is stopped. */
export const SIMULATION_DEADLINE_MS = 30 * 60_000;

export type SimulationJobResult =
  | { readonly status: 'recorded'; readonly passed: boolean; readonly simulationId: string }
  | {
      readonly status: 'stopped';
      readonly reason: AiInsightReason | 'tool_ceiling' | 'deadline';
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'missing' | 'status' | 'provider_unavailable';
    };

const emptyMetrics = (mode: ProcedureSimulationMetrics['mode']): ProcedureSimulationMetrics => ({
  mode,
  caseCount: 0,
  failedCases: 0,
  seededCases: 0,
  candidate: { editDistance: 0, uncitedClaims: 0, drafted: 0, violations: 0, disclosureLeaks: 0 },
  baseline: null,
  baselineVersionId: null,
  deadSteps: [],
  toolCalls: 0,
  failReasons: ['no_cases'],
  cases: [],
});

/**
 * T-303d (ADR-026 section 6): runs the steps of a confirmed version on the newest resolved tickets of its intent
 * and writes `procedure_simulation`. The investigator and the drafter run twice per ticket, with the new steps and
 * with the version live now (or the default runbook); the new draft is compared with the reply a person sent, and
 * the grader looks for a policy violation. The tools are the instance's own, read-only, through the budget bucket
 * `simulation` (lower per-minute share, a ceiling of calls per run); every model call is redacted and audited like
 * a live one, with `ai_run.procedure_version_id` set. Nothing is sent and no ticket is changed (N2, N3).
 *
 * A run that is stopped (kill switch, daily budget, offline provider, tool ceiling, deadline) writes no row: a
 * half-finished simulation must not look like a pass or a fail.
 */
export async function runProcedureSimulationJob(
  deps: InvestigationDeps,
  job: { readonly versionId: string; readonly requestedBy: string | null },
): Promise<SimulationJobResult> {
  const db = deps.database.db;
  const target = await readSimulationTarget(db, job.versionId);
  if (target === null) return { status: 'skipped', reason: 'missing' };
  // A draft cannot be simulated (the database says so too); a published one is already live.
  if (target.status !== 'confirmed' && target.status !== 'simulated') {
    return { status: 'skipped', reason: 'status' };
  }
  const runtime = deps.ai;
  if (runtime === undefined) return { status: 'skipped', reason: 'provider_unavailable' };

  const tickets = await readSimulationTickets(db, {
    intentId: target.intentId,
    limit: PROCEDURE_SIMULATION.caseCount,
  });
  if (tickets.length === 0) {
    const row = await recordProcedureSimulation(db, {
      versionId: target.versionId,
      passed: false,
      seedOnly: false,
      caseCount: 0,
      metrics: emptyMetrics('instance'),
      ranBy: job.requestedBy,
    });
    return { status: 'recorded', passed: false, simulationId: row.id };
  }

  const [intent] = await db
    .select({ key: schema.intent.key, allowedTools: schema.intent.allowedTools })
    .from(schema.intent)
    .where(eq(schema.intent.id, target.intentId))
    .limit(1);
  if (intent === undefined) return { status: 'skipped', reason: 'missing' };
  const stage = Math.min(4, Math.max(0, effectiveStage(target.intentStage))) as AutonomyStage;
  const keys = new TicketKeys(deps.ticketKeyPrefix);
  const settings = await runtime.settings.load();
  const signal = AbortSignal.timeout(SIMULATION_DEADLINE_MS);

  // One entry per ticket: its case, its agents (the redaction dictionary is that ticket's people) and its names.
  const prepared = new Map<
    string,
    { input: SimulationCaseInput; agents: AgentDeps; names: readonly string[] }
  >();
  for (const ticket of tickets) {
    const people = await ticketPeopleNames(db, ticket);
    warnIfIncomplete(deps.logger, ticket.id, people);
    const [contact] =
      ticket.requesterContactId === null
        ? []
        : await db
            .select({
              verifiedAt: schema.contact.verifiedAt,
              lineVerifiedAt: schema.contact.lineVerifiedAt,
            })
            .from(schema.contact)
            .where(eq(schema.contact.id, ticket.requesterContactId))
            .limit(1);
    prepared.set(ticket.id, {
      input: caseOf(ticket, keys, stage, intent.key, contact),
      agents: runtime.agentDeps(people.names, { dictionaryIncomplete: !people.complete }),
      names: people.names,
    });
  }

  const ledger = createDbToolLedger({
    db,
    limits: PROCEDURE_SIMULATION.toolBudgets,
    ...(deps.budgetProject === undefined ? {} : { project: deps.budgetProject }),
  });
  const env: SimulationEnv = {
    mode: 'instance',
    abortSignal: signal,
    agentsFor: (input) => {
      const found = prepared.get(input.ticketId);
      if (found === undefined) throw new Error('simulation case without agents');
      return found.agents;
    },
    toolsFor: (input) => {
      const found = prepared.get(input.ticketId);
      if (found === undefined) throw new Error('simulation case without tools');
      const registry = createToolRegistry(
        buildAllowList([
          { key: intent.key, allowedTools: deps.allowSystemTools ? intent.allowedTools : [] },
        ]),
      );
      for (const tool of investigationTools({
        kb: createKbSearchPort({ db, ai: runtime, names: found.names }),
        tickets: createSimilarTicketsPort(deps.readDb, keys),
        org: createOrgContextPort(deps.readDb),
        systems: deps.systems,
      })) {
        registry.register(tool);
      }
      return withToolBudget({
        scoped: registry.scope(
          { agent: 'investigator', intent: intent.key, stage },
          { abortSignal: signal, ticketId: input.ticketId },
        ),
        ledger,
        runKey: randomUUID(),
        ticketId: input.ticketId,
        // The bucket of the simulation: its own rows in `tool_execution`, a lower share of the per-minute budget.
        agent: 'simulation',
        intent: intent.key,
        stage,
        hashKey: settings.inputHashKey,
      });
    },
  };

  const outcome = await runProcedureSimulation(env, {
    cases: [...prepared.values()].map((item) => item.input),
    candidate: { versionId: target.versionId, steps: target.steps },
    baseline:
      target.baseline === null
        ? { versionId: null, steps: undefined }
        : { versionId: target.baseline.versionId, steps: target.baseline.steps },
  });
  if (outcome.status === 'stopped') {
    return {
      status: 'stopped',
      reason: signal.aborted ? 'deadline' : outcome.reason,
    };
  }
  const row = await recordProcedureSimulation(db, {
    versionId: target.versionId,
    passed: outcome.passed,
    // A run that used any seeded ticket does not count for an intent at stage 3 (migration 0097).
    seedOnly: outcome.metrics.seededCases > 0,
    caseCount: outcome.metrics.caseCount,
    metrics: outcome.metrics,
    ranBy: job.requestedBy,
  });
  return { status: 'recorded', passed: outcome.passed, simulationId: row.id };
}

/** The case of one ticket: what the AI would have seen before the first reply of a person. */
function caseOf(
  ticket: SimulationTicket,
  keys: TicketKeys,
  stage: AutonomyStage,
  intentKey: string,
  contact: { verifiedAt: Date | null; lineVerifiedAt: Date | null } | undefined,
): SimulationCaseInput {
  const disclosure = disclosureFor(ticket.channel, contact, senderAuthenticated(ticket.messages));
  const turns: TicketTurn[] = ticket.messages.map((message) => ({
    from:
      message.visibility === 'internal'
        ? 'note'
        : message.direction === 'inbound'
          ? 'customer'
          : 'staff',
    text: message.text,
  }));
  const customerText = turns
    .filter((turn) => turn.from === 'customer')
    .map((turn) => turn.text)
    .join(' ');
  return {
    ticketId: ticket.id,
    ticketKey: keys.format(ticket.number),
    seeded: ticket.seeded,
    channel: ticket.channel,
    subject: ticket.subject,
    turns,
    humanReply: ticket.humanReply,
    intentKey,
    stage,
    customerLanguage: detectLanguage(customerText),
    disclosure,
    facts: {
      'ticket.priority': ticket.priority,
      'ticket.channel': ticket.channel,
      'org.tier': ticket.orgTier ?? undefined,
      'contact.verified': disclosure === 'verified',
      'ticket.reopenCount': ticket.reopenCount,
    },
  };
}
