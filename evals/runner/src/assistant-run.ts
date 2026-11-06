import { createToolRegistry, defineTool, runAssistantTurn, type AgentDeps } from '@watchtower/ai';
import { z } from 'zod';

import { assistantFixtureFact, type AssistantCase } from './assistant-case.js';
import { assistantCitationMetrics } from './assistant-citations.js';
import type { Check } from './checks.js';

/** Fixture-only host: no database, HTTP client, customer send or real investigation tool. */
export async function runAssistantCase(deps: AgentDeps, item: AssistantCase) {
  const registry = createToolRegistry([
    {
      agent: 'personal_assistant',
      intent: '*',
      tools: item.input.fixtures.map((fixture) => fixture.tool),
    },
  ]);
  for (const fixture of item.input.fixtures)
    registry.register(
      defineTool({
        name: fixture.tool,
        description: 'Synthetic read-only eval fixture',
        readOnly: true,
        input: z.record(z.string(), z.unknown()),
        output: z.object({ facts: z.array(assistantFixtureFact) }),
        execute: () => Promise.resolve({ facts: fixture.facts }),
      }),
    );
  const outcome = await runAssistantTurn(deps, {
    scope: `eval:${item.id}`,
    locale: item.input.locale,
    role: item.input.role,
    page: item.input.page,
    entities: item.input.entities,
    today: '2026-01-01',
    text: item.input.question,
    history: [],
    proposalKinds: [],
    masked: item.input.masked,
    limits: { maxToolCalls: 4, maxClaims: 5, maxProposals: 0 },
    host: {
      tools: registry.scope(
        { agent: 'personal_assistant', intent: null, stage: 2 },
        { maxCalls: 6 },
      ),
      info: item.input.fixtures.map((fixture) => ({
        name: fixture.tool,
        description: 'fixture',
        input: '{}',
      })),
      facts: (_tool, output) =>
        z.object({ facts: z.array(assistantFixtureFact) }).parse(output).facts,
    },
  });
  if (outcome.status !== 'ok')
    return { status: outcome.status, reason: outcome.reason, checks: [] as Check[] };
  const metrics = assistantCitationMetrics(outcome.claims, item.expect.mustCiteRefs);
  const checks: Check[] = [
    {
      name: 'required citation refs',
      pass: metrics.matchedRefs === metrics.requiredRefs,
      detail: `${String(metrics.matchedRefs)}/${String(metrics.requiredRefs)}`,
    },
  ];
  for (const text of item.expect.mustNotMention)
    checks.push({
      name: 'forbidden text absent',
      pass: !outcome.claims.some((claim) => claim.text.toLowerCase().includes(text.toLowerCase())),
    });
  if (item.expect.path !== undefined)
    checks.push({ name: 'path', pass: outcome.path === item.expect.path });
  if (item.expect.maxUncited !== undefined)
    checks.push({ name: 'uncited limit', pass: metrics.uncitedClaims <= item.expect.maxUncited });
  return { status: 'ok' as const, reason: null, checks, citationMetrics: metrics };
}
