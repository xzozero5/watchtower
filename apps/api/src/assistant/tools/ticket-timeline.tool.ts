import {
  TICKET_EVENT_TYPES,
  ticketRefSchema,
  timelineQuerySchema,
  type TimelineEntry,
} from '@watchtower/shared';
import { z } from 'zod';

import { ticketHref } from '../assistant-hrefs.js';
import {
  MAX_LIST,
  cutAtWord,
  plain,
  toolFact,
  untrusted,
  type ModuleToolContext,
  type ToolRegistrar,
} from './fact-kit.js';

/**
 * `ticket_timeline` (T-405): the conversation of one ticket, oldest first, as `GET /v1/tickets/:id/timeline` serves it
 * (`TimelineService.timeline`: the same reader, the same masking for a developer, the same keyset page). Message text
 * is customer or staff text and goes into the fact inside `<untrusted_content>` (C-14); an event is a line the system
 * wrote. The payload of an event is not passed on, except `from` and `to` of a status change.
 */
export const ticketTimelineInput = z.strictObject({
  ticket: ticketRefSchema,
  limit: z.number().int().min(1).max(MAX_LIST).default(10),
  /** `nextCursor` of the previous call, to read on. */
  cursor: z.string().min(1).max(500).optional(),
});

const message = z.strictObject({
  kind: z.literal('message'),
  id: z.uuid(),
  ticketKey: z.string().max(40),
  from: z.enum(['customer', 'staff', 'note']),
  senderName: z.string().max(300).nullable(),
  text: z.string().max(2000),
  createdAt: z.iso.datetime(),
});
const event = z.strictObject({
  kind: z.literal('event'),
  id: z.uuid(),
  ticketKey: z.string().max(40),
  type: z.string().max(100),
  actor: z.enum(['user', 'system', 'ai', 'anonymous']),
  actorName: z.string().max(300).nullable(),
  statusFrom: z.string().max(40).nullable(),
  statusTo: z.string().max(40).nullable(),
  createdAt: z.iso.datetime(),
});

export const ticketTimelineOutput = z.strictObject({
  entries: z.array(z.discriminatedUnion('kind', [message, event])).max(MAX_LIST),
  nextCursor: z.string().max(500).nullable(),
});
export type TicketTimelineOutput = z.infer<typeof ticketTimelineOutput>;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= 40 ? value : null;

function entryOf(entry: TimelineEntry): TicketTimelineOutput['entries'][number] {
  if (entry.kind === 'message') {
    return {
      kind: 'message',
      id: entry.id,
      ticketKey: entry.ticketKey,
      from:
        entry.visibility === 'internal'
          ? 'note'
          : entry.direction === 'inbound'
            ? 'customer'
            : 'staff',
      senderName: entry.sender.name === null ? null : cutAtWord(entry.sender.name, 300),
      text: cutAtWord(entry.bodyText.replaceAll(/\s+/g, ' ').trim(), 2000),
      createdAt: entry.createdAt,
    };
  }
  const status = entry.type === TICKET_EVENT_TYPES.statusChanged;
  return {
    kind: 'event',
    id: entry.id,
    ticketKey: entry.ticketKey,
    type: cutAtWord(entry.type, 100),
    actor: entry.actor.type,
    actorName: entry.actor.name === null ? null : cutAtWord(entry.actor.name, 300),
    statusFrom: status ? str(entry.payload.from) : null,
    statusTo: status ? str(entry.payload.to) : null,
    createdAt: entry.createdAt,
  };
}

export function ticketTimelineFacts(output: TicketTimelineOutput) {
  return output.entries.map((entry) => {
    const href = ticketHref(entry.ticketKey);
    if (entry.kind === 'event') {
      const change =
        entry.statusFrom !== null && entry.statusTo !== null
          ? ` from ${entry.statusFrom} to ${entry.statusTo}`
          : '';
      return toolFact({
        kind: 'ticket',
        id: entry.ticketKey,
        label: entry.ticketKey,
        text: plain(
          `${entry.ticketKey} event ${entry.type}${change} by ${entry.actor}${entry.actorName === null ? '' : ` ${entry.actorName}`} at ${entry.createdAt}.`,
        ),
        trust: 'system',
        href,
        names: entry.actorName === null ? [] : [entry.actorName],
      });
    }
    return toolFact({
      kind: entry.from === 'note' ? 'note' : 'ticket',
      id: entry.from === 'note' ? entry.id : entry.ticketKey,
      label: entry.ticketKey,
      text: untrusted(
        entry.text,
        `${entry.ticketKey} ${entry.from} message at ${entry.createdAt}: `,
      ),
      trust: entry.from === 'customer' ? 'customer' : 'staff',
      href,
      names: entry.senderName === null ? [] : [entry.senderName],
    });
  });
}

export function ticketTimelineTool(ctx: ModuleToolContext): ToolRegistrar {
  return (add) => {
    add(
      'ticket_timeline',
      {
        description:
          'Read the conversation of one ticket, oldest first: messages, internal notes and events. Pass nextCursor back as cursor to read on.',
        input: ticketTimelineInput,
        output: ticketTimelineOutput,
        async execute(input) {
          // Who may read the ticket is the reader's to say (organization, masking); the timeline asks it again.
          const view = await ctx.services.reader.viewRow(input.ticket, ctx.principal);
          await ctx.remember([view.t.orgId]);
          const query = timelineQuerySchema.parse({
            limit: input.limit,
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          });
          const page = await ctx.services.timeline.timeline(input.ticket, query, ctx.principal);
          ctx.onRead('ticket', view.t.id, ctx.keyOf(view.t.number));
          ctx.onRead('timeline', view.t.id);
          return {
            entries: page.entries.slice(0, input.limit).map(entryOf),
            nextCursor: page.nextCursor,
          };
        },
      },
      '{"ticket": "OPS-12", "limit"?: 10, "cursor"?: "nextCursor"}',
      (output) => ticketTimelineFacts(output),
    );
  };
}
