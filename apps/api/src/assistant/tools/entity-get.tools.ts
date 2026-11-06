import { z } from 'zod';

import { TOOL_PERMISSION } from '../assistant-access.js';
import { notFound } from '../../auth/http-errors.js';
import { visibleHandoff } from '../entity-readers.js';
import {
  requireRule,
  toolFact,
  untrusted,
  type ModuleToolContext,
  type ToolRegistrar,
} from './fact-kit.js';

export const entityGetInput = z.strictObject({ id: z.uuid() });
export const entityGetOutput = z.strictObject({
  id: z.uuid(),
  label: z.string().min(1).max(200),
  text: z.string().max(1200),
  names: z.array(z.string()).max(1000),
});

/** The missing entity summaries; deliberately project no URLs, integration fields or write capability. */
export function entityGetTools(ctx: ModuleToolContext): ToolRegistrar[] {
  const tools: ToolRegistrar[] = [];
  const services = ctx.services;
  const { organizations, intentDetail, catalog, handoffs } = services;
  if (organizations !== undefined)
    tools.push((add) => {
      add(
        'org_get',
        {
          description: 'Read one organization by its visible chip id.',
          input: entityGetInput,
          output: entityGetOutput,
          async execute({ id }) {
            requireRule(ctx.principal, TOOL_PERMISSION.org_get.rule);
            const org = await organizations.get(id, ctx.principal);
            await ctx.remember([org.id]);
            ctx.onReadRef?.('org', org.id);
            return {
              id: org.id,
              label: org.name.slice(0, 200),
              text: untrusted(
                `${org.name}. Status: ${org.status}. Tier: ${org.tier}. ${org.notes}`,
              ),
              names: [],
            };
          },
        },
        '{"id":"organization uuid"}',
        (row) => [
          toolFact({ kind: 'org', id: row.id, label: row.label, text: row.text, trust: 'staff' }),
        ],
      );
    });
  if (intentDetail !== undefined)
    tools.push((add) => {
      add(
        'intent_get',
        {
          description: 'Read the selected intent; never change its autonomy stage.',
          input: entityGetInput,
          output: entityGetOutput,
          async execute({ id }) {
            requireRule(ctx.principal, TOOL_PERMISSION.intent_get.rule);
            const intent = await intentDetail.get(id);
            ctx.onReadRef?.('intent', intent.id);
            return {
              id: intent.id,
              label: intent.name.slice(0, 200),
              text: untrusted(
                `${intent.name} (${intent.key}). Stage: ${String(intent.autonomyStage)}. ${intent.description}`,
              ),
              names: [],
            };
          },
        },
        '{"id":"intent uuid"}',
        (row) => [
          toolFact({
            kind: 'intent',
            id: row.id,
            label: row.label,
            text: row.text,
            trust: 'staff',
          }),
        ],
      );
    });
  if (catalog !== undefined)
    tools.push((add) => {
      add(
        'service_get',
        {
          description: 'Read the selected service name, slug, active state and owner queue.',
          input: entityGetInput,
          output: entityGetOutput,
          async execute({ id }) {
            requireRule(ctx.principal, TOOL_PERMISSION.service_get.rule);
            const service = await catalog.getService(id);
            ctx.onReadRef?.('service', service.id);
            return {
              id: service.id,
              label: service.name.slice(0, 200),
              text: untrusted(
                `${service.name} (${service.slug}). Active: ${String(service.active)}. Owner queue: ${service.ownerQueueId ?? 'none'}.`,
              ),
              names: [],
            };
          },
        },
        '{"id":"service uuid"}',
        (row) => [
          toolFact({
            kind: 'service',
            id: row.id,
            label: row.label,
            text: row.text,
            trust: 'staff',
          }),
        ],
      );
    });
  if (handoffs !== undefined)
    for (const view of ['own', 'incoming'] as const)
      tools.push((add) => {
        add(
          view === 'own' ? 'handoff_get' : 'handoff_incoming_get',
          {
            description: `Read one ${view} handoff visible through the handoff GET view.`,
            input: entityGetInput,
            output: entityGetOutput,
            async execute({ id }) {
              requireRule(
                ctx.principal,
                TOOL_PERMISSION[view === 'own' ? 'handoff_get' : 'handoff_incoming_get'].rule,
              );
              const handoff = await visibleHandoff(handoffs, ctx.principal, id, view);
              if (handoff === null) throw notFound('No such handoff');
              ctx.onReadRef?.('handoff', handoff.id);
              // The context resolver supplies the complete org dictionary before this call; the tool
              // also remembers every linked ticket it can read if invoked by the model without a chip.
              const orgIds: string[] = [];
              for (const item of handoff.items)
                if (item.ticket !== null) {
                  const ticket = await services.reader.viewRow(item.ticket.id, ctx.principal);
                  orgIds.push(ticket.t.orgId);
                  ctx.onRead('ticket', ticket.t.id, ctx.keyOf(ticket.t.number));
                }
              await ctx.remember(orgIds);
              return {
                id: handoff.id,
                label: 'Handoff',
                names: [
                  handoff.from.name,
                  ...handoff.items.flatMap((item) => item.ticket?.assignee?.name ?? []),
                ],
                text: untrusted(
                  `${handoff.notes} ${handoff.messageForNext} ${handoff.items.map((item) => `${item.title}: ${item.nextAction ?? ''}`).join('; ')}`,
                ),
              };
            },
          },
          '{"id":"handoff uuid"}',
          (row) => [
            toolFact({
              kind: 'handoff',
              id: row.id,
              label: row.label,
              text: row.text,
              names: row.names,
              trust: 'staff',
            }),
          ],
        );
      });
  return tools;
}
