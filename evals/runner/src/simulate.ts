import {
  buildAllowList,
  createMemoryToolLedger,
  createToolRegistry,
  investigationTools,
  runProcedureSimulation,
  withToolBudget,
  type AutonomyStage,
  type KbHit,
  type OrgContext,
  type SimilarTicket,
  type SimulationCaseInput,
  type SimulationEnv,
  type SimulationOutcome,
  type SystemToolPorts,
} from '@watchtower/ai';
import {
  PROCEDURE_SIMULATION,
  procedureStepsSchema,
  type ProcedureSimulationMetrics,
  type ProcedureSteps,
} from '@watchtower/shared';
import { z } from 'zod';

import { caseTicketId, type Rig } from './rig.js';

/**
 * Simulation of a procedure version without an instance (T-303d, ADR-026 section 6): made-up cases and made-up
 * tools, so CI can run the same engine the worker runs on real resolved tickets (`runProcedureSimulation` of
 * `@watchtower/ai`). The model is the provider of the rig (mock by default: it checks the plumbing and the rules,
 * not the quality of a real model). A case holds made-up or redacted text only (N1, N4).
 */

const turnSchema = z.object({
  from: z.enum(['customer', 'staff', 'note']),
  text: z.string().min(1).max(8000),
});

export const simulationFixtureCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,80}$/, 'id: lowercase letters, digits, . _ -'),
  subject: z.string().min(1).max(500),
  channel: z.string().min(1).max(40).default('email'),
  language: z.enum(['th', 'en']).default('en'),
  disclosure: z.enum(['verified', 'restricted']).default('restricted'),
  intent: z.string().min(1).max(80).default('fixture_intent'),
  stage: z.number().int().min(0).max(4).default(2),
  turns: z.array(turnSchema).min(1).max(20),
  /** The reply a person sent: what the draft is compared with. */
  humanReply: z.string().min(1).max(8000),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  names: z.array(z.string().min(1).max(128)).max(50).optional(),
  seeded: z.boolean().default(false),
});
export type SimulationFixtureCase = z.infer<typeof simulationFixtureCaseSchema>;

export const simulationFixtureSchema = z.object({
  cases: z.array(simulationFixtureCaseSchema).min(1).max(100),
});

const HASH_KEY = 'eval-simulation-hash-key-not-a-secret-0000';

const KB_HIT: KbHit = {
  articleId: 'fixture-article',
  slug: 'fixture-article',
  title: 'Fixture article',
  section: 'Check the endpoint',
  snippet: 'Make sure the endpoint answers with a success status within ten seconds.',
  score: 0.9,
  kind: 'runbook',
  lang: 'en',
  customerVisible: true,
  isRunbook: true,
  href: '/kb/fixture-article',
};
const SIMILAR: SimilarTicket = {
  id: '22222222-2222-4222-8222-222222222222',
  key: 'OPS-1',
  subject: 'A similar question',
  intentKey: 'fixture_intent',
  status: 'resolved',
  snippet: 'The answer was to retry after the endpoint recovered.',
  similarity: 0.7,
  sameOrg: false,
  href: '/tickets/OPS-1',
};
const ORG: OrgContext = {
  orgName: 'Fixture Org',
  tier: 'standard',
  status: 'active',
  openTickets: 1,
  ticketsLast30Days: 3,
  href: '/orgs/fixture',
};
const SYSTEMS: SystemToolPorts = {
  logs: {
    mock: true,
    run: () =>
      Promise.resolve({
        items: [
          {
            timestamp: '2026-01-01T00:00:00Z',
            severity: 'ERROR',
            service: 'fixture',
            message: 'delivery failed',
          },
        ],
      }),
  },
};

export interface SimulateFixtureOptions {
  readonly rig: Rig;
  readonly cases: readonly SimulationFixtureCase[];
  readonly steps: ProcedureSteps;
  /** The version to compare with; absent: the default runbook. */
  readonly baselineSteps?: ProcedureSteps | undefined;
  readonly maxToolCalls?: number;
}

/** Parses a steps file the way the api does: the strict schema of ADR-026 section 2. */
export function parseStepsFile(value: unknown): ProcedureSteps {
  return procedureStepsSchema.parse(value);
}

export async function simulateFixture(options: SimulateFixtureOptions): Promise<SimulationOutcome> {
  const byId = new Map(options.cases.map((item) => [caseTicketId(item.id), item]));
  const inputs: SimulationCaseInput[] = options.cases.map((item) => ({
    ticketId: caseTicketId(item.id),
    ticketKey: `FIX-${item.id.slice(0, 12)}`,
    seeded: item.seeded,
    channel: item.channel,
    subject: item.subject,
    turns: item.turns,
    humanReply: item.humanReply,
    intentKey: item.intent,
    stage: item.stage as AutonomyStage,
    customerLanguage: item.language,
    disclosure: item.disclosure,
    facts: item.facts ?? {},
  }));
  const env: SimulationEnv = {
    mode: 'fixture',
    agentsFor: (input) => options.rig.depsForNames(byId.get(input.ticketId)?.names ?? [], {}),
    toolsFor: (input) => {
      const registry = createToolRegistry(
        buildAllowList([{ key: input.intentKey ?? '', allowedTools: ['gcp_logs'] }]),
      );
      for (const tool of investigationTools({
        kb: { search: () => Promise.resolve([KB_HIT]) },
        tickets: { find: () => Promise.resolve([SIMILAR]) },
        org: { get: () => Promise.resolve(ORG) },
        systems: SYSTEMS,
      })) {
        registry.register(tool);
      }
      return withToolBudget({
        scoped: registry.scope(
          { agent: 'investigator', intent: input.intentKey, stage: input.stage },
          { ticketId: input.ticketId },
        ),
        ledger: createMemoryToolLedger(PROCEDURE_SIMULATION.toolBudgets),
        runKey: `${input.ticketId}-${String(Math.random())}`,
        ticketId: input.ticketId,
        agent: 'simulation',
        intent: input.intentKey,
        stage: input.stage,
        hashKey: HASH_KEY,
      });
    },
  };
  return runProcedureSimulation(env, {
    cases: inputs,
    candidate: { versionId: caseTicketId('candidate-version'), steps: options.steps },
    baseline:
      options.baselineSteps === undefined
        ? { versionId: null, steps: undefined }
        : { versionId: caseTicketId('baseline-version'), steps: options.baselineSteps },
    ...(options.maxToolCalls === undefined ? {} : { maxToolCalls: options.maxToolCalls }),
  });
}

export function formatSimulation(outcome: SimulationOutcome): string {
  if (outcome.status === 'stopped') return `simulation stopped (${outcome.reason}): no verdict`;
  const m: ProcedureSimulationMetrics = outcome.metrics;
  const lines = [
    `simulation (${m.mode}): ${outcome.passed ? 'PASS' : 'FAIL'}`,
    `  cases ${String(m.caseCount)} (failed ${String(m.failedCases)}, seeded ${String(m.seededCases)}), tool calls ${String(m.toolCalls)}`,
    `  candidate: edit distance ${String(m.candidate.editDistance)}, uncited ${String(m.candidate.uncitedClaims)}, violations ${String(m.candidate.violations)}, disclosure leaks ${String(m.candidate.disclosureLeaks)}`,
    m.baseline === null
      ? '  baseline: none'
      : `  baseline: edit distance ${String(m.baseline.editDistance)}, uncited ${String(m.baseline.uncitedClaims)}`,
    `  dead steps: ${m.deadSteps.length === 0 ? 'none' : m.deadSteps.join(', ')}`,
  ];
  if (m.failReasons.length > 0) lines.push(`  fail reasons: ${m.failReasons.join(', ')}`);
  return lines.join('\n');
}
