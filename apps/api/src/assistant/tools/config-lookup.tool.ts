import { INTEGRATION_KEYS, TICKET_STATUSES } from '@watchtower/shared';
import { z } from 'zod';

import {
  MAX_LIST,
  cutAtWord,
  holds,
  plain,
  requireRule,
  toolFact,
  type ModuleToolContext,
  type ToolRegistrar,
} from './fact-kit.js';

/**
 * `config_lookup` (T-405, DoD C-6, N1; supersedes ADR-023 section 1 by ADR-029 section 11): how the instance is set up,
 * from the services the GET routes of those pages use: SLA policies (`GET /v1/sla-policies`), team queues
 * (`GET /v1/queues`), intents (`GET /v1/intents`), the ticket workflow (`GET /v1/ticket-workflow`) and integrations
 * (`GET /v1/admin/integrations`, head only).
 *
 * The output is an allow-list per kind (Zod `strictObject`, never a pass-through of the service object). Nothing in it
 * can be a credential, a secret, a token or a key, nor the metadata of one: an integration is `{kind, connected}` and
 * no more (no field list, no environment variable name, no saved-by, no endpoint, host or URL). A queue shows how many
 * people are in it, not who. An intent shows no reply template and no free-text description. The tests walk every
 * output for a secret-like key name and for `https?://`.
 */
export const CONFIG_KINDS = ['sla_policy', 'queue', 'intent', 'workflow', 'integration'] as const;
export type ConfigKind = (typeof CONFIG_KINDS)[number];

export const configLookupInput = z.strictObject({
  config: z.enum(CONFIG_KINDS),
  limit: z.number().int().min(1).max(MAX_LIST).default(MAX_LIST),
});

const target = z.strictObject({
  first_response_min: z.number().int().min(0),
  resolution_min: z.number().int().min(0),
  calendar: z.string().max(20),
});

const slaPolicy = z.strictObject({
  config: z.literal('sla_policy'),
  items: z
    .array(
      z.strictObject({
        id: z.uuid(),
        name: z.string().max(300),
        tier: z.string().max(40).nullable(),
        targets: z.strictObject({
          P1: target.optional(),
          P2: target.optional(),
          P3: target.optional(),
          P4: target.optional(),
        }),
      }),
    )
    .max(MAX_LIST),
});
const queue = z.strictObject({
  config: z.literal('queue'),
  items: z
    .array(
      z.strictObject({
        id: z.uuid(),
        name: z.string().max(300),
        assignmentMode: z.string().max(40),
        isDefault: z.boolean(),
        memberCount: z.number().int().min(0),
      }),
    )
    .max(MAX_LIST),
});
const intent = z.strictObject({
  config: z.literal('intent'),
  items: z
    .array(
      z.strictObject({
        id: z.uuid(),
        key: z.string().max(100),
        name: z.string().max(300),
        defaultPriority: z.string().max(4),
        isActive: z.boolean(),
        autonomyStage: z.number().int().min(0).max(4),
        slaPolicyId: z.uuid().nullable(),
      }),
    )
    .max(MAX_LIST),
});
const workflow = z.strictObject({
  config: z.literal('workflow'),
  /** One row per status: where a ticket in that status may go. */
  items: z
    .array(
      z.strictObject({
        from: z.enum(TICKET_STATUSES),
        to: z.array(z.enum(TICKET_STATUSES)).max(TICKET_STATUSES.length),
      }),
    )
    .max(TICKET_STATUSES.length),
});
const integration = z.strictObject({
  config: z.literal('integration'),
  items: z
    .array(
      z.strictObject({
        kind: z.enum(INTEGRATION_KEYS as [string, ...string[]]),
        connected: z.boolean(),
      }),
    )
    .max(MAX_LIST),
});

export const configLookupOutput = z.discriminatedUnion('config', [
  slaPolicy,
  queue,
  intent,
  workflow,
  integration,
]);
export type ConfigLookupOutput = z.infer<typeof configLookupOutput>;

/** One priority of a policy, field by field (an allow-list; the service object is never passed on). */
const pick = (
  t: { first_response_min: number; resolution_min: number; calendar: string } | undefined,
  priority: 'P1' | 'P2' | 'P3' | 'P4',
) =>
  t === undefined
    ? {}
    : {
        [priority]: {
          first_response_min: t.first_response_min,
          resolution_min: t.resolution_min,
          calendar: t.calendar,
        },
      };

const HREFS: Readonly<Record<ConfigKind, string>> = {
  sla_policy: '/admin/sla',
  queue: '/admin/queues',
  intent: '/admin/intents',
  workflow: '/admin',
  integration: '/admin/integrations',
};

export function configLookupFacts(output: ConfigLookupOutput) {
  const href = HREFS[output.config];
  const make = (id: string, label: string, text: string) =>
    toolFact({ kind: 'config', id, label, text: plain(text), trust: 'system', href });
  switch (output.config) {
    case 'sla_policy':
      return output.items.map((row) => {
        const targets = (['P1', 'P2', 'P3', 'P4'] as const).flatMap((priority) => {
          const t = row.targets[priority];
          return t === undefined
            ? []
            : [
                `${priority} first response ${String(t.first_response_min)} min, resolution ${String(t.resolution_min)} min (${t.calendar})`,
              ];
        });
        return make(
          `sla_policy:${row.id}`,
          row.name,
          `SLA policy "${row.name}"${row.tier === null ? '' : ` (default for tier ${row.tier})`}: ${targets.length === 0 ? 'no targets' : targets.join('; ')}.`,
        );
      });
    case 'queue':
      return output.items.map((row) =>
        make(
          `queue:${row.id}`,
          row.name,
          `Queue "${row.name}": assignment ${row.assignmentMode.replaceAll('_', ' ')}, ${String(row.memberCount)} members${row.isDefault ? ', the default queue' : ''}.`,
        ),
      );
    case 'intent':
      return output.items.map((row) =>
        make(
          `intent:${row.id}`,
          row.name,
          `Intent "${row.name}" (${row.key})${row.isActive ? '' : ' [inactive]'}: default priority ${row.defaultPriority}, autonomy stage ${String(row.autonomyStage)}.`,
        ),
      );
    case 'workflow':
      return [
        make(
          'workflow:ticket',
          'Ticket workflow',
          `Ticket status workflow: ${output.items.map((row) => `${row.from} to ${row.to.length === 0 ? 'nothing' : row.to.join(' or ')}`).join('; ')}.`,
        ),
      ];
    case 'integration':
      return [
        make(
          'integration:status',
          'Integrations',
          `Integrations: ${output.items.map((row) => `${row.kind} ${row.connected ? 'connected' : 'not connected'}`).join(', ')}. "Connected" means its credentials are set, not that a live check passed.`,
        ),
      ];
  }
}

export function configLookupTool(ctx: ModuleToolContext): ToolRegistrar {
  const mayReadIntegrations = holds(ctx.principal, 'integration.manage');
  return (add) => {
    add(
      'config_lookup',
      {
        description:
          'How the instance is set up: SLA policies, team queues, intents, the ticket status workflow, and which integrations are connected (yes or no only). Never shows a credential or a secret.',
        input: configLookupInput,
        output: configLookupOutput,
        async execute(input) {
          // The route of an SLA policy, a queue, an intent and the workflow is `ticket.read`; integrations are `integration.manage`.
          requireRule(ctx.principal, { all: ['ticket.read'] });
          switch (input.config) {
            case 'sla_policy': {
              const rows = (await ctx.services.sla.listPolicies()).slice(0, input.limit);
              return {
                config: 'sla_policy' as const,
                items: rows.map((row) => ({
                  id: row.id,
                  name: cutAtWord(row.name, 300),
                  tier: row.tier,
                  targets: {
                    ...pick(row.targets.P1, 'P1'),
                    ...pick(row.targets.P2, 'P2'),
                    ...pick(row.targets.P3, 'P3'),
                    ...pick(row.targets.P4, 'P4'),
                  },
                })),
              };
            }
            case 'queue': {
              const rows = (await ctx.services.queues.list()).slice(0, input.limit);
              return {
                config: 'queue' as const,
                items: rows.map((row) => ({
                  id: row.id,
                  name: cutAtWord(row.name, 300),
                  assignmentMode: row.assignmentMode,
                  isDefault: row.isDefault,
                  memberCount: row.members.length,
                })),
              };
            }
            case 'intent': {
              const rows = (await ctx.services.intents.list()).slice(0, input.limit);
              return {
                config: 'intent' as const,
                items: rows.map((row) => ({
                  id: row.id,
                  key: cutAtWord(row.key, 100),
                  name: cutAtWord(row.name, 300),
                  defaultPriority: row.defaultPriority,
                  isActive: row.isActive,
                  autonomyStage: row.autonomyStage,
                  slaPolicyId: row.slaPolicyId,
                })),
              };
            }
            case 'workflow': {
              const transitions = await ctx.services.workflow.list();
              return {
                config: 'workflow' as const,
                items: TICKET_STATUSES.map((from) => ({
                  from,
                  to: transitions.filter((entry) => entry.from === from).map((entry) => entry.to),
                })),
              };
            }
            case 'integration': {
              requireRule(ctx.principal, { all: ['integration.manage'] });
              const list = await ctx.services.credentials.list();
              return {
                config: 'integration' as const,
                items: list.items
                  .slice(0, input.limit)
                  .map((row) => ({ kind: row.key, connected: row.status === 'configured' })),
              };
            }
          }
        },
      },
      mayReadIntegrations
        ? '{"config": "sla_policy"|"queue"|"intent"|"workflow"|"integration", "limit"?: 20}'
        : '{"config": "sla_policy"|"queue"|"intent"|"workflow", "limit"?: 20}',
      (output) => configLookupFacts(output),
    );
  };
}
