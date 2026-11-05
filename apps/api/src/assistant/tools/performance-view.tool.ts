import { z } from 'zod';

import { assigneeHref } from '../assistant-hrefs.js';
import {
  MAX_LIST,
  holds,
  plain,
  requireRule,
  toolFact,
  type ModuleToolContext,
  type ToolRegistrar,
} from './fact-kit.js';

/**
 * `performance_view` (T-404, DoD C-16): what each agent has open and resolved over the last N days, from the same
 * per-agent figures as `GET /v1/dashboard/ops` (`DashboardService.performance`).
 *
 * Two locks: the person holds `performance.read.all` or `performance.read.own`; and a `userId` is honoured only
 * for `performance.read.all`. A person who holds only `.own` gets their own row whatever `userId` was passed: the
 * argument is ignored, not refused (so a model that was told to look at somebody else's row learns nothing).
 */
export const performanceViewInput = z.strictObject({
  days: z.number().int().min(1).max(90).default(7),
  userId: z.uuid().optional(),
});

export const performanceViewOutput = z.strictObject({
  window: z.strictObject({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    days: z.number().int().min(0),
  }),
  scope: z.enum(['all', 'own']),
  agents: z
    .array(
      z.strictObject({
        userId: z.uuid(),
        name: z.string().max(200),
        open: z.number().int().min(0),
        resolved: z.number().int().min(0),
      }),
    )
    .max(MAX_LIST),
});
export type PerformanceViewOutput = z.infer<typeof performanceViewOutput>;

export function performanceViewFacts(output: PerformanceViewOutput) {
  const days = String(output.window.days);
  return output.agents.map((row) =>
    toolFact({
      kind: 'person',
      id: row.userId,
      label: row.name,
      text: plain(
        `${row.name}: ${String(row.open)} tickets open now, ${String(row.resolved)} resolved in the last ${days} days.`,
      ),
      trust: 'system',
      // Only a person who may see everyone is sent to the queue of somebody else.
      ...(output.scope === 'all' ? { href: assigneeHref(row.userId) } : {}),
      names: [row.name],
    }),
  );
}

export function performanceViewTool(ctx: ModuleToolContext): ToolRegistrar {
  return (add) => {
    add(
      'performance_view',
      {
        description:
          'Open and resolved tickets per agent over the last N days. A lead or head may ask for one agent by userId; an agent sees only their own row.',
        input: performanceViewInput,
        output: performanceViewOutput,
        async execute(input) {
          requireRule(ctx.principal, { anyOf: ['performance.read.own', 'performance.read.all'] });
          const asked = holds(ctx.principal, 'performance.read.all') ? input.userId : undefined;
          const view = await ctx.services.dashboard.performance(input.days, ctx.principal, asked);
          const agents = view.agents.slice(0, MAX_LIST);
          for (const row of agents) ctx.onRead('performance', row.userId);
          return { window: view.window, scope: view.scope, agents };
        },
      },
      '{"days"?: 7, "userId"?: "uuid (lead and head only)"}',
      (output) => performanceViewFacts(output),
    );
  };
}
