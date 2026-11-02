import {
  createToolRegistry,
  defineTool,
  type AssistantFact,
  type AssistantToolHost,
  type AssistantToolInfo,
  type ToolDefinition,
} from '@watchtower/ai';
import { schema, type Database } from '@watchtower/db';
import {
  MIN_SEARCH_LENGTH,
  OPEN_STATUSES,
  kbSearchQuerySchema,
  slaStateSchema,
  ticketListQuerySchema,
  ticketPrioritySchema,
  ticketRefSchema,
  ticketStatsQuerySchema,
  ticketStatusSchema,
  type AssistantLocale,
} from '@watchtower/shared';
import { desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { Principal } from '../auth/principal.js';
import type { KbService } from '../kb/kb.service.js';
import type { BriefService } from '../shifts/brief.service.js';
import type { SlaRemaining } from '../tickets/sla-remaining.js';
import type { TicketKeys } from '../tickets/ticket-keys.js';
import type { TicketReader } from '../tickets/ticket-reader.js';
import type { ToolRunner } from '../tools/tool-runner.service.js';
import { toolsFor, type AssistantToolName } from './assistant-access.js';
import { assigneeHref, ticketHref } from './assistant-hrefs.js';
import { loadLine, memberLine, slaLine, ticketLine } from './assistant-text.js';

/** `[ASSUMED]` A person with this many open tickets, or this many past SLA, is called overloaded. */
export const OVERLOADED_OPEN = 10;
export const OVERLOADED_BREACHED = 2;

export interface AssistantToolDeps {
  readonly database: Database;
  readonly reader: TicketReader;
  readonly keys: TicketKeys;
  readonly sla: SlaRemaining;
  readonly kb: KbService;
  readonly brief: BriefService;
  readonly runner: ToolRunner;
  /** Knowledge base scores come from mock embeddings (`EMBEDDING_PROVIDER=mock`). */
  readonly embeddingMock: boolean;
  /** The tickets' own AI results were made by the mock provider. */
  readonly aiMock: boolean;
}

export interface AssistantToolEnv {
  readonly principal: Principal;
  readonly locale: AssistantLocale;
  /** `dev`: nothing that identifies the customer goes into a fact. */
  readonly masked: boolean;
  readonly now: Date;
  /** Told of each ticket whose content a tool read, for the audit of personal data read (PRD 8.2). */
  readonly onRead?: ((ticket: { readonly id: string; readonly key: string }) => void) | undefined;
}

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const person = z.string().max(200);
const refInput = z.strictObject({ ticket: ticketRefSchema });

// --- shapes --------------------------------------------------------------------------------------

const ticketRow = z.object({
  key: z.string().max(40),
  subject: z.string().max(300),
  status: z.string().max(40),
  priority: z.string().max(4),
  org: z.string().max(300),
  assignee: person.nullable(),
  slaState: slaStateSchema.nullable(),
});

const searchInput = z.strictObject({
  query: z.string().trim().min(MIN_SEARCH_LENGTH).max(100).optional(),
  status: z.array(ticketStatusSchema).max(8).optional(),
  priority: z.array(ticketPrioritySchema).max(4).optional(),
  assignee: z.enum(['me', 'unassigned']).optional(),
  slaState: z.array(slaStateSchema).max(4).optional(),
  limit: z.number().int().min(1).max(8).default(5),
});
const searchOutput = z.object({ items: z.array(ticketRow).max(8) });

const summarizeOutput = z.object({
  ticket: ticketRow,
  intent: z.object({ key: z.string().max(100), name: z.string().max(200) }).nullable(),
  /** Null for a masked reader. */
  requester: person.nullable(),
  aiSummary: z.string().max(1000).nullable(),
  recent: z
    .array(z.object({ from: z.enum(['customer', 'staff', 'note']), text: z.string().max(400) }))
    .max(4),
  /** Contact names of the ticket's organization, for the redactor dictionary. Never shown. */
  people: z.array(person).max(50),
});

const slaOutput = z.object({
  ticket: ticketRow,
  sla: z
    .object({
      target: z.enum(['first_response', 'resolution']),
      state: slaStateSchema,
      dueAt: z.string().max(40),
      calendar: z.enum(['business', '24x7']),
      minutesLeft: z.number().int().nullable(),
    })
    .nullable(),
});

const loadOutput = z.object({
  rows: z
    .array(
      z.object({
        userId: z.uuid(),
        name: person,
        open: z.number().int().min(0),
        atRisk: z.number().int().min(0),
        breached: z.number().int().min(0),
        overloaded: z.boolean(),
      }),
    )
    .max(8),
  unassignedOpen: z.number().int().min(0),
});

const statusOutput = z.object({
  members: z
    .array(
      z.object({
        name: person,
        role: z.string().max(20),
        onShift: z.boolean(),
        openTickets: z.number().int().min(0),
      }),
    )
    .max(10),
});

const kbInput = z.strictObject({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(5).default(4),
});
const kbOutput = z.object({
  mode: z.enum(['hybrid', 'keyword']),
  items: z
    .array(
      z.object({
        title: z.string().max(300),
        section: z.string().max(300),
        snippet: z.string().max(400),
        lang: z.string().max(10),
      }),
    )
    .max(5),
});

const investigateOutput = z.object({
  key: z.string().max(40),
  note: z.enum(['no_template']).nullable(),
  card: z
    .object({
      kind: z.enum(['logs', 'data', 'repo', 'metrics']),
      title: z.string().max(300),
      summary: z.string().max(600),
      excerpt: z.string().max(700),
      resultCount: z.number().int().min(0),
      mock: z.boolean(),
    })
    .nullable(),
});

type TicketRowShape = z.infer<typeof ticketRow>;

/**
 * The tools of the assistant for one person (ADR-017). Built per request and closed over the person's
 * principal: a tool reads through the same readers and services as the routes, so it can see what
 * the person can see and nothing else, and only the tools their role and permissions allow are
 * registered at all. Every tool is read-only (N2) and has Zod input and output.
 */
export function buildAssistantTools(
  deps: AssistantToolDeps,
  env: AssistantToolEnv,
): AssistantToolHost {
  const { principal, locale, masked } = env;
  const allowed = new Set<AssistantToolName>(toolsFor(principal));
  const registry = createToolRegistry([
    { agent: 'personal_assistant', intent: '*', tools: [...allowed] },
  ]);
  const facts = new Map<string, (output: never) => readonly AssistantFact[]>();
  const info: AssistantToolInfo[] = [];
  let investigations = 0;

  function add<I extends z.ZodType, O extends z.ZodType>(
    name: AssistantToolName,
    tool: Omit<ToolDefinition<I, O>, 'name' | 'readOnly'>,
    hint: string,
    toFacts: (output: z.output<O>) => readonly AssistantFact[],
  ): void {
    if (!allowed.has(name)) return;
    registry.register(defineTool<I, O>({ ...tool, name, readOnly: true }));
    facts.set(name, toFacts);
    info.push({ name, description: tool.description, input: hint });
  }

  const rowOf = async (
    view: Awaited<ReturnType<TicketReader['viewRow']>>,
  ): Promise<TicketRowShape> => {
    const sla = await deps.sla.view(view.t, env.now);
    env.onRead?.({ id: view.t.id, key: deps.keys.format(view.t.number) });
    return {
      key: deps.keys.format(view.t.number),
      subject: cut(view.t.subject, 300),
      status: view.t.status,
      priority: view.t.priority,
      org: cut(view.orgName, 300),
      assignee: view.assigneeName,
      slaState: sla?.state ?? null,
    };
  };
  const lineOf = (row: TicketRowShape): string => ticketLine(locale, row);
  const ticketFact = (
    row: TicketRowShape,
    text: string,
    extra?: Partial<AssistantFact>,
  ): AssistantFact => ({
    kind: 'ticket',
    label: row.key,
    href: ticketHref(row.key),
    text,
    // The staff member named in the sentence is in the dictionary too (N4).
    ...(row.assignee === null ? {} : { names: [row.assignee] }),
    ...extra,
  });

  // --- search_tickets ---------------------------------------------------------------------------
  add(
    'search_tickets',
    {
      description:
        'Find tickets you may see: by words, status, priority, "me" or "unassigned", or SLA state. Open tickets unless you give a status or words.',
      input: searchInput,
      output: searchOutput,
      async execute(input) {
        const query = ticketListQuerySchema.parse({
          q: input.query,
          status: input.status ?? (input.query === undefined ? [...OPEN_STATUSES] : undefined),
          priority: input.priority,
          assignee: input.assignee,
          slaState: input.slaState,
          sort: input.slaState === undefined ? 'updated_desc' : 'sla_due_asc',
          limit: input.limit,
        });
        const page = await deps.reader.list(query, principal);
        const items: TicketRowShape[] = [];
        for (const item of page.items) {
          if (!('org' in item)) continue;
          env.onRead?.({ id: item.id, key: item.key });
          items.push({
            key: item.key,
            subject: cut(item.subject, 300),
            status: item.status,
            priority: item.priority,
            org: cut(item.org.name, 300),
            assignee: item.assignee?.name ?? null,
            slaState: item.sla?.state ?? null,
          });
        }
        return { items };
      },
    },
    '{"query"?: "words", "status"?: ["open"], "priority"?: ["P1"], "assignee"?: "me"|"unassigned", "slaState"?: ["at_risk","breached"], "limit"?: 5}',
    (output) => output.items.map((row) => ticketFact(row, lineOf(row))),
  );

  // --- summarize_ticket -------------------------------------------------------------------------
  add(
    'summarize_ticket',
    {
      description:
        'Read one ticket: its state, the AI summary if there is one, and the last few messages.',
      input: refInput,
      output: summarizeOutput,
      async execute(input) {
        const view = await deps.reader.viewRow(input.ticket, principal);
        const recent = await deps.database.db
          .select({
            direction: schema.message.direction,
            visibility: schema.message.visibility,
            text: schema.message.bodyText,
          })
          .from(schema.message)
          .where(eq(schema.message.ticketId, view.t.id))
          .orderBy(desc(schema.message.createdAt))
          .limit(4);
        const contacts = await deps.database.db
          .select({ name: schema.contact.name })
          .from(schema.contact)
          .where(eq(schema.contact.orgId, view.t.orgId))
          .limit(50);
        return {
          ticket: await rowOf(view),
          intent:
            view.intentKey === null
              ? null
              : { key: view.intentKey, name: view.intentName ?? view.intentKey },
          requester: masked ? null : view.requesterName,
          aiSummary: view.aiSummary === null ? null : cut(view.aiSummary, 1000),
          recent: recent.reverse().map((message) => ({
            from:
              message.visibility === 'internal'
                ? ('note' as const)
                : message.direction === 'inbound'
                  ? ('customer' as const)
                  : ('staff' as const),
            text: cut(message.text.replaceAll(/\s+/g, ' ').trim(), 400),
          })),
          people: contacts.map((contact) => contact.name),
        };
      },
    },
    '{"ticket": "OPS-12"}',
    (output) => {
      const out: AssistantFact[] = [
        ticketFact(
          output.ticket,
          `${lineOf(output.ticket)}${
            output.requester === null
              ? ''
              : locale === 'th'
                ? ` ผู้แจ้ง ${output.requester}.`
                : ` Requester ${output.requester}.`
          }${
            output.intent === null
              ? ''
              : locale === 'th'
                ? ` หัวข้อ ${output.intent.name}.`
                : ` Intent ${output.intent.name}.`
          }`,
          {
            names: [
              ...output.people,
              ...(output.ticket.assignee === null ? [] : [output.ticket.assignee]),
            ],
          },
        ),
      ];
      if (output.aiSummary !== null) {
        out.push(
          ticketFact(
            output.ticket,
            `${locale === 'th' ? 'สรุปโดย AI' : 'AI summary'}: ${output.aiSummary}`,
            { mock: deps.aiMock },
          ),
        );
      }
      for (const message of output.recent) {
        out.push({
          kind: message.from === 'note' ? 'note' : 'ticket',
          label: output.ticket.key,
          href: ticketHref(output.ticket.key),
          text: `[${message.from}] ${message.text}`,
        });
      }
      return out;
    },
  );

  // --- explain_sla ------------------------------------------------------------------------------
  add(
    'explain_sla',
    {
      description:
        'Explain the SLA target that is running on one ticket: which target, how much time is left, when it is due.',
      input: refInput,
      output: slaOutput,
      async execute(input) {
        const view = await deps.reader.viewRow(input.ticket, principal);
        const sla = await deps.sla.view(view.t, env.now);
        return { ticket: await rowOf(view), sla };
      },
    },
    '{"ticket": "OPS-12"}',
    (output) => [
      ticketFact(
        output.ticket,
        output.sla === null
          ? locale === 'th'
            ? `${output.ticket.key} ไม่มีเป้า SLA ที่กำลังนับ (สถานะ${output.ticket.status}).`
            : `${output.ticket.key} has no SLA target running (status ${output.ticket.status}).`
          : slaLine(locale, { key: output.ticket.key, ...output.sla }),
      ),
    ],
  );

  // --- team_load (lead, head) -------------------------------------------------------------------
  add(
    'team_load',
    {
      description:
        'Open tickets, tickets at risk and past SLA per person, and who looks overloaded. For leads and heads.',
      input: z.strictObject({}),
      output: loadOutput,
      async execute() {
        const stats = await deps.reader.stats(ticketStatsQuerySchema.parse({}), principal);
        const owned = stats.byAssignee.filter(
          (bucket): bucket is typeof bucket & { assigneeId: string } => bucket.assigneeId !== null,
        );
        const names = new Map(
          (owned.length === 0
            ? []
            : await deps.database.db
                .select({ id: schema.users.id, name: schema.users.name })
                .from(schema.users)
                .where(
                  inArray(
                    schema.users.id,
                    owned.map((bucket) => bucket.assigneeId),
                  ),
                )
          ).map((row) => [row.id, row.name]),
        );
        const rows = owned
          .filter((bucket) => bucket.open > 0)
          .map((bucket) => ({
            userId: bucket.assigneeId,
            name: names.get(bucket.assigneeId) ?? '?',
            open: bucket.open,
            atRisk: bucket.sla.at_risk,
            breached: bucket.sla.breached,
            overloaded:
              bucket.open >= OVERLOADED_OPEN || bucket.sla.breached >= OVERLOADED_BREACHED,
          }))
          .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name))
          .slice(0, 8);
        const unassigned = stats.byAssignee.find((bucket) => bucket.assigneeId === null);
        return { rows, unassignedOpen: unassigned?.open ?? 0 };
      },
    },
    '{}',
    (output) => [
      ...output.rows.map((row): AssistantFact => ({
        kind: 'person',
        label: row.name,
        href: assigneeHref(row.userId),
        text: loadLine(locale, row),
        names: [row.name],
      })),
      ...(output.unassignedOpen === 0
        ? []
        : [
            {
              kind: 'ticket' as const,
              label: locale === 'th' ? 'ยังไม่มีผู้รับผิดชอบ' : 'Unassigned',
              href: '/?assignee=unassigned',
              text:
                locale === 'th'
                  ? `ยังไม่มีผู้รับผิดชอบ ${String(output.unassignedOpen)} งานที่เปิดอยู่.`
                  : `${String(output.unassignedOpen)} open tickets have no assignee.`,
            },
          ]),
    ],
  );

  // --- team_status ------------------------------------------------------------------------------
  add(
    'team_status',
    {
      description: 'Who is on shift now and how many open tickets each person holds.',
      input: z.strictObject({}),
      output: statusOutput,
      async execute() {
        const list = await deps.brief.assignees({});
        const members = [...list.assignees]
          .sort((a, b) => Number(b.onShift) - Number(a.onShift) || a.name.localeCompare(b.name))
          .slice(0, 10)
          .map((member) => ({
            name: member.name,
            role: member.role,
            onShift: member.onShift,
            openTickets: member.openTickets,
          }));
        return { members };
      },
    },
    '{}',
    (output) =>
      output.members.map((member): AssistantFact => ({
        kind: 'person',
        label: member.name,
        text: memberLine(locale, member),
        names: [member.name],
      })),
  );

  // --- kb_search --------------------------------------------------------------------------------
  add(
    'kb_search',
    {
      description: 'Search the knowledge base (the live articles) for a question or a topic.',
      mock: deps.embeddingMock,
      input: kbInput,
      output: kbOutput,
      async execute(input) {
        const result = await deps.kb.search(
          kbSearchQuerySchema.parse({ q: input.query, limit: input.limit, audience: 'staff' }),
        );
        return {
          mode: result.mode,
          items: result.hits.slice(0, input.limit).map((hit) => ({
            title: cut(hit.title, 300),
            section: cut(hit.section, 300),
            snippet: cut(hit.snippet.replaceAll(/\s+/g, ' ').trim(), 400),
            lang: hit.lang,
          })),
        };
      },
    },
    '{"query": "words", "limit"?: 4}',
    (output) =>
      output.items.map((item): AssistantFact => ({
        kind: 'kb',
        label: cut(item.section === '' ? item.title : `${item.title} - ${item.section}`, 200),
        // No knowledge base page exists in the web yet: the chip says there is no link (N5).
        ...(deps.embeddingMock && output.mode === 'hybrid' ? { mock: true } : {}),
        text: `${item.title}${item.section === '' ? '' : ` - ${item.section}`}: ${item.snippet}`,
      })),
  );

  // --- investigate_run --------------------------------------------------------------------------
  add(
    'investigate_run',
    {
      description:
        'Run the first ready investigation template of the ticket (logs, product data) within the shared rate budget and show what it found. Nothing is pinned to the ticket. At most once per message.',
      input: refInput,
      output: investigateOutput,
      async execute(input) {
        investigations += 1;
        if (investigations > 1) throw new Error('one investigation per message');
        const subject = await deps.runner.ticketSubject(input.ticket, principal);
        if (subject.kind !== 'ticket') throw new Error('not a ticket');
        const key = deps.keys.format((await deps.reader.viewRow(input.ticket, principal)).t.number);
        env.onRead?.({ id: subject.ticketId, key });
        // Only a template the AI may run for this ticket (ADR-016); never one made for a person's button.
        const templateId = await deps.runner.aiTemplateOf(subject);
        if (templateId === null) return { key, note: 'no_template' as const, card: null };
        // The AI's own run (N2): the AI's budget, actor `ai`, and no evidence card is written.
        const card = await deps.runner.runForAssistant(subject, templateId, principal);
        return {
          key,
          note: null,
          card: {
            kind: card.kind,
            title: cut(card.title, 300),
            summary: cut(card.summary, 600),
            excerpt: cut(card.excerpt, 700),
            resultCount: card.resultCount,
            mock: card.mock,
          },
        };
      },
    },
    '{"ticket": "OPS-12"}',
    (output) => {
      const href = ticketHref(output.key);
      if (output.card === null) {
        return [
          {
            kind: 'ticket',
            label: output.key,
            href,
            text:
              locale === 'th'
                ? `${output.key} ยังไม่มี template สืบค้นที่ AI รันได้ (ต้องมี intent ที่ทีมยืนยัน และระบบต้องเชื่อมต่อแล้ว).`
                : `${output.key} has no investigation template the AI may run (it needs an intent staff set and a connected system).`,
          },
        ];
      }
      const kind =
        output.card.kind === 'logs' ? 'log' : output.card.kind === 'repo' ? 'repo' : 'data';
      return [
        {
          kind,
          label: cut(output.card.title, 200),
          href,
          mock: output.card.mock,
          text: `${output.card.title}. ${output.card.summary}. ${output.card.excerpt}`,
        },
      ];
    },
  );

  const scoped = registry.scope(
    { agent: 'personal_assistant', intent: null, stage: 2 },
    { maxCalls: 8 },
  );
  return {
    tools: scoped,
    info,
    facts: (tool, output) => facts.get(tool)?.(output as never) ?? [],
  };
}
