import {
  OTHER_MAIL_DISPOSITIONS,
  otherMailDispositionSchema,
  otherMailQuerySchema,
  type OtherMailItem,
} from '@watchtower/shared';
import { z } from 'zod';

import {
  MAX_LIST,
  toolFact,
  untrusted,
  type ModuleToolContext,
  type ToolRegistrar,
} from './fact-kit.js';

/**
 * `conversation_search` and `conversation_get` (T-405): the messages that did not become a ticket (noise, automatic
 * replies, internal or machine mail), as `GET /v1/inbound/other-mail` and `GET /v1/inbound/other-mail/:id` serve them
 * (`OtherMailService.list` / `get`). What a sender wrote (subject, text, name) is customer text: it goes into the fact
 * between `<untrusted_content>` tags and the fact carries `trust: 'customer'` (C-14). The HTML part is never read.
 */
const item = z.strictObject({
  id: z.uuid(),
  channel: z.string().max(20),
  disposition: otherMailDispositionSchema,
  fromName: z.string().max(1000).nullable(),
  fromAddress: z.string().max(320).nullable(),
  subject: z.string().max(4000),
  snippet: z.string().max(4000),
  receivedAt: z.iso.datetime(),
});
type ConversationItem = z.infer<typeof item>;

export const conversationSearchInput = z.strictObject({
  query: z.string().trim().min(2).max(100).optional(),
  disposition: z.array(otherMailDispositionSchema).max(OTHER_MAIL_DISPOSITIONS.length).optional(),
  limit: z.number().int().min(1).max(MAX_LIST).default(5),
});
export const conversationSearchOutput = z.strictObject({ items: z.array(item).max(MAX_LIST) });

export const conversationGetInput = z.strictObject({ id: z.uuid() });
export const conversationGetOutput = z.strictObject({
  conversation: item.extend({ bodyText: z.string().max(8000) }),
});

const HREF = '/other-mail';

const itemOf = (row: OtherMailItem): ConversationItem => ({
  id: row.id,
  channel: row.channel,
  disposition: row.disposition,
  fromName: row.fromName === null ? null : row.fromName.slice(0, 1000),
  fromAddress: row.fromAddress,
  subject: row.subject.slice(0, 4000),
  snippet: row.snippet.slice(0, 4000),
  receivedAt: row.receivedAt,
});

/** The words of the system around the sender's text; the text itself stays inside the untrusted block. */
const lead = (row: ConversationItem): string =>
  `Other mail (${row.disposition}) on ${row.channel}, received ${row.receivedAt}: `;

export function conversationFact(row: ConversationItem, text: string) {
  return toolFact({
    kind: 'conversation',
    id: row.id,
    label: row.subject === '' ? `${row.channel} ${row.receivedAt}` : row.subject,
    text,
    trust: 'customer',
    href: HREF,
    names: [row.fromName, row.fromAddress].filter((name): name is string => name !== null),
  });
}

export function conversationSearchFacts(output: z.infer<typeof conversationSearchOutput>) {
  return output.items.map((row) =>
    conversationFact(
      row,
      untrusted(
        `${row.fromName ?? row.fromAddress ?? ''} - ${row.subject}: ${row.snippet}`,
        lead(row),
      ),
    ),
  );
}

export function conversationGetFacts(output: z.infer<typeof conversationGetOutput>) {
  const row = output.conversation;
  return [
    conversationFact(
      row,
      untrusted(
        `${row.fromName ?? row.fromAddress ?? ''} - ${row.subject}: ${row.bodyText}`,
        lead(row),
      ),
    ),
  ];
}

export function conversationSearchTool(ctx: ModuleToolContext): ToolRegistrar {
  return (add) => {
    add(
      'conversation_search',
      {
        description:
          'Search the mail that did not become a ticket (noise, automatic replies, internal mail) by sender, subject or the start of the text. Newest first.',
        input: conversationSearchInput,
        output: conversationSearchOutput,
        async execute(input) {
          const query = otherMailQuerySchema.parse({
            q: input.query,
            disposition: input.disposition,
            limit: input.limit,
          });
          const page = await ctx.services.otherMail.list(query);
          const items = page.items.slice(0, input.limit).map(itemOf);
          for (const row of items) ctx.onRead('conversation', row.id);
          return { items };
        },
      },
      '{"query"?: "words", "disposition"?: ["noise","auto_reply","internal"], "limit"?: 5}',
      (output) => conversationSearchFacts(output),
    );
  };
}

export function conversationGetTool(ctx: ModuleToolContext): ToolRegistrar {
  return (add) => {
    add(
      'conversation_get',
      {
        description: 'Read one message of Other mail with its text (the HTML part is never shown).',
        input: conversationGetInput,
        output: conversationGetOutput,
        async execute(input) {
          const detail = await ctx.services.otherMail.get(input.id);
          ctx.onRead('conversation', detail.id);
          return {
            conversation: { ...itemOf(detail), bodyText: detail.bodyText.slice(0, 8000) },
          };
        },
      },
      '{"id": "uuid"}',
      (output) => conversationGetFacts(output),
    );
  };
}
