import {
  claimSchema,
  makeClaim,
  ticketStatusSchema,
  type AiInsightReason,
  type AssistantToolRun,
  type Claim,
  type ClaimEvidence,
  type ClaimEvidenceKind,
  type ProposalKind,
} from '@watchtower/shared';
import { z } from 'zod';

import type { AuditedResult } from '../audited.js';
import type { ScopedTools } from '../contract.js';
import { clipRedacted, joinRedacted } from '../redaction/redacted-text.js';
import { REDACTION_KINDS } from '../redaction/detectors.js';
import type {
  RedactionReport,
  RedactionSession,
  RedactionSnapshot,
  Redactor,
} from '../redaction/redactor.js';
import { renderPrompt } from '../prompts.js';
import { neutralizeTags } from './leak-check.js';
import type { FactTrust } from './untrusted.js';
import {
  askGuard,
  clip,
  extractJsonObject,
  failureFor,
  skippedFor,
  type AgentDeps,
} from './common.js';

export const ASSISTANT_PLAN_PROMPT_ID = 'assistant_plan';
export const ASSISTANT_ANSWER_PROMPT_ID = 'assistant_answer';

/** What the model reads about a tool. The host (the api) owns the text; the model owns nothing here. */
export interface AssistantToolInfo {
  readonly name: string;
  readonly description: string;
  /** A one-line JSON shape of the input, for the prompt. */
  readonly input: string;
}

/**
 * One thing a tool found, in two forms: what the model reads (`text`, redacted as tool output) and
 * what the person gets as a chip (`kind`, `label`, `href`). The host builds both from the validated
 * output of the tool with the person's own access, so a chip can only point at a page they may open
 * (ADR-023 section 9). The model refers to a fact by its id and writes no link.
 */
export interface AssistantFact {
  readonly kind: ClaimEvidenceKind;
  readonly label: string;
  readonly href?: string | undefined;
  readonly mock?: boolean | undefined;
  readonly text: string;
  /** Names of people the fact mentions, added to the dictionary of the answer's redactor. */
  readonly names?: readonly string[] | undefined;
  /** What the fact points at, `{kind, id}` with the real id (ADR-029 section 2); the host builds the chip from it. */
  readonly ref?: { readonly kind: ClaimEvidenceKind; readonly id: string } | undefined;
  /** Who wrote the free text in `text`. A tool wraps any text that is not `system` with `wrapUntrusted` (C-14). */
  readonly trust?: FactTrust | undefined;
}

export interface AssistantToolHost {
  readonly tools: ScopedTools;
  /** Descriptions of the tools that are callable, from the same allow-list as `tools`. */
  readonly info: readonly AssistantToolInfo[];
  facts(tool: string, output: unknown): readonly AssistantFact[];
}

export interface AssistantDeps extends AgentDeps {
  /** A redactor that also knows these names, for the answer step. Absent: the plain redactor. */
  redactorFor?(names: readonly string[]): Redactor;
}

// --- model output ------------------------------------------------------------------------------

export const assistantPlanSchema = z.object({
  calls: z
    .array(z.object({ tool: z.string().trim().min(1).max(64), input: z.unknown().optional() }))
    .max(12),
});

const ref = z.string().trim().min(1).max(64);
const shortText = (max: number) => z.string().trim().min(1).max(max);

/** What the model may ask for. Everything else on the card is read from the server. */
export const proposalIntentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('assign'),
    ticket: ref,
    assignee: z.string().trim().min(1).max(200).nullable(),
  }),
  z.object({
    kind: z.literal('status'),
    ticket: ref,
    status: ticketStatusSchema,
    reason: shortText(500).optional(),
  }),
  z.object({
    kind: z.literal('tag'),
    ticket: ref,
    add: z.array(shortText(64)).max(10).optional(),
    remove: z.array(shortText(64)).max(10).optional(),
  }),
  z.object({ kind: z.literal('note'), ticket: ref, body: shortText(5000) }),
  z.object({
    kind: z.literal('create_ticket'),
    org: shortText(200),
    subject: shortText(300),
    body: shortText(5000),
    requesterEmail: shortText(200).optional(),
    requesterName: shortText(200).optional(),
  }),
  z.object({ kind: z.literal('kb_draft'), title: shortText(200), bodyMd: shortText(10_000) }),
  z.object({
    kind: z.literal('reply_draft'),
    ticket: ref,
    instruction: shortText(500).optional(),
  }),
]);
export type ProposalIntent = z.infer<typeof proposalIntentSchema>;

const answerShape = z.object({
  claims: z
    .array(
      z.object({
        text: shortText(600),
        evidenceIds: z.array(z.string().max(200)).max(20).default([]),
      }),
    )
    .max(10),
  proposals: z.array(z.unknown()).max(10).default([]),
});

// --- input and result --------------------------------------------------------------------------

export interface AssistantTurnInput {
  /** Redaction scope: the conversation id. */
  readonly scope: string;
  readonly locale: 'th' | 'en';
  /** The role of the person, for the model to know how much to say. */
  readonly role: string;
  readonly page?: string | undefined;
  /** The ticket number the person has a chip for. */
  readonly ticketInView?: string | undefined;
  /** `YYYY-MM-DD` in the instance time zone. */
  readonly today: string;
  readonly text: string;
  /** Earlier turns, already redacted when they were stored. Oldest first. */
  readonly history: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[];
  readonly host: AssistantToolHost;
  /** The proposal kinds this person may be offered (their permissions decide). */
  readonly proposalKinds: readonly ProposalKind[];
  readonly limits: {
    readonly maxToolCalls: number;
    readonly maxClaims: number;
    readonly maxProposals: number;
  };
  /** `dev`: show the person nothing the redactor took out of a ticket (ADR-023 section 5). */
  readonly masked: boolean;
  readonly abortSignal?: AbortSignal | undefined;
}

export interface AssistantUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
}

export type AssistantOutcome =
  | {
      readonly status: 'ok';
      readonly claims: Claim[];
      /**
       * The claims as the model wrote them, placeholders still in. This is what may be stored and sent
       * back to a model as history (N4); the restored text in `claims` is for the screen only.
       */
      readonly redactedText: string;
      /** Every name the tools gave the redactor in this turn, so the caller can redact what it stores with them too. */
      readonly names: string[];
      /** Free text restored for the person; structural fields restored only from what they typed. */
      readonly proposals: ProposalIntent[];
      readonly tools: AssistantToolRun[];
      readonly runIds: string[];
      readonly usage: AssistantUsage;
    }
  | { readonly status: 'skipped'; readonly reason: AiInsightReason }
  | { readonly status: 'failed'; readonly reason: AiInsightReason };

const MAX_FACTS = 24;
const MAX_FACT_CHARS = 500;
const MAX_HISTORY_CHARS = 1200;
const MAX_REQUEST_CHARS = 2000;

/** The tags of the prompt must not be closable from inside data. */
const neutralize = (text: string): string =>
  neutralizeTags(text).replaceAll(
    /<(\/?\s*(?:context|history|request|tool_results|tools)\b)/gi,
    '‹$1',
  );

function sumUsage(results: readonly AuditedResult[]): AssistantUsage {
  let cost: number | null = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const result of results) {
    inputTokens += result.run.inputTokens;
    outputTokens += result.run.outputTokens;
    cost = cost === null || result.run.costUsd === null ? null : cost + result.run.costUsd;
  }
  return { inputTokens, outputTokens, costUsd: cost };
}

function toolRunsOf(host: AssistantToolHost): AssistantToolRun[] {
  const mock = new Map(host.tools.list().map((tool) => [tool.name, tool.mock]));
  return host.tools.calls().map((call) => ({
    name: call.name,
    status: call.ok
      ? 'ok'
      : call.errorCode === 'ToolNotAllowedError' || call.errorCode === 'ToolBudgetError'
        ? 'denied'
        : 'error',
    mock: mock.get(call.name) ?? false,
  }));
}

function renderContext(input: AssistantTurnInput): string {
  const lines = [
    `today: ${input.today}`,
    `language: ${input.locale}`,
    `role: ${input.role}`,
    ...(input.page === undefined ? [] : [`page: ${input.page}`]),
    ...(input.ticketInView === undefined ? [] : [`ticket_in_view: ${input.ticketInView}`]),
  ];
  return `<context>\n${lines.join('\n')}\n</context>`;
}

function renderHistory(input: AssistantTurnInput, session: RedactionSession) {
  if (input.history.length === 0) return [];
  const lines = input.history.map(
    (turn) => `[${turn.role}] ${neutralize(clip(turn.text, MAX_HISTORY_CHARS))}`,
  );
  // Whatever placeholders the history holds were issued by an earlier session and mean something else
  // here. `fromModel` keeps a token that this session also issued, which would bind an old [EMAIL_1] to
  // a different person; `redactToolOutput` escapes every token-shaped piece of text instead.
  return [session.redactToolOutput('history', `<history>\n${lines.join('\n')}\n</history>`)];
}

function renderToolList(info: readonly AssistantToolInfo[]): string {
  return info.length === 0
    ? '(none: answer from the context alone)'
    : info.map((tool) => `- ${tool.name}: ${tool.description} Input: ${tool.input}`).join('\n');
}

/**
 * The personal assistant (PRD section 6.2) in two model calls: step one picks read-only tools from the
 * list the host allows this person; the host runs them with the person's own access; step two writes
 * claims that cite the facts by id and, only if asked, proposals. Same rules as the other agents:
 * guard first, redaction before every model call (N4), one `ai_run` row per call (N4), and `skipped` /
 * `failed` instead of throwing. Nothing here can write: a proposal is only an intent that the host
 * turns into a card and a person presses (ADR-023).
 */
export async function runAssistantTurn(
  deps: AssistantDeps,
  input: AssistantTurnInput,
): Promise<AssistantOutcome> {
  const decision = await askGuard(deps.guard, {
    agent: 'personal_assistant',
    ticketId: null,
    action: 'assistant.plan',
  });
  if (!decision.allowed) return { status: 'skipped', reason: decision.reason };

  const planPrompt = deps.prompts.latest(ASSISTANT_PLAN_PROMPT_ID);
  const answerPrompt = deps.prompts.latest(ASSISTANT_ANSWER_PROMPT_ID);
  const results: AuditedResult[] = [];
  const request = neutralize(clip(input.text, MAX_REQUEST_CHARS));

  // --- step one: which tools -------------------------------------------------------------------
  const planSession = deps.redactor.session({ scope: input.scope });
  let planned: z.infer<typeof assistantPlanSchema>;
  try {
    const system = planSession.redact(
      renderPrompt(planPrompt.body, {
        tools: renderToolList(input.host.info),
        maxCalls: String(input.limits.maxToolCalls),
      }),
    );
    const user = joinRedacted(
      [
        planSession.redact(renderContext(input)),
        ...renderHistory(input, planSession),
        planSession.redact(`<request>\n${request}\n</request>`),
      ],
      '\n',
    );
    const result = await deps.llm.generate({
      agent: 'personal_assistant',
      prompt: planPrompt.ref,
      system,
      messages: [{ role: 'user', content: user }],
      redaction: planSession,
      ticketId: null,
      maxOutputTokens: 400,
      temperature: 0,
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    });
    results.push(result);
    const parsed = assistantPlanSchema.safeParse(extractJsonObject(result.response.text));
    if (!parsed.success) return { status: 'failed', reason: 'model_output_invalid' };
    planned = parsed.data;
  } catch (error) {
    const reason = skippedFor(error);
    if (reason !== null) return { status: 'skipped', reason };
    return failureFor(error);
  }

  // --- run the tools (the host's allow-list decides; the model's word does not) -----------------
  const facts: AssistantFact[] = [];
  for (const call of planned.calls.slice(0, input.limits.maxToolCalls)) {
    let output: unknown;
    try {
      output = await input.host.tools.call(
        call.tool,
        restoreStrings(call.input ?? {}, planSession),
      );
    } catch {
      // Denied, over budget, bad input, or the tool failed: recorded in `calls()`, shown as a gap.
      continue;
    }
    for (const fact of input.host.facts(call.tool, output)) {
      if (facts.length < MAX_FACTS) facts.push(fact);
    }
  }
  const tools = toolRunsOf(input.host);

  // --- step two: the answer --------------------------------------------------------------------
  // A switch or a budget can change while the tools run: ask again before the second call.
  const again = await askGuard(deps.guard, {
    agent: 'personal_assistant',
    ticketId: null,
    action: 'assistant.answer',
  });
  if (!again.allowed) return { status: 'skipped', reason: again.reason };
  const names = [...new Set(facts.flatMap((fact) => fact.names ?? []))];
  const answerRedactor = deps.redactorFor?.(names) ?? deps.redactor;
  const session = answerRedactor.session({ scope: input.scope });
  // A masked reader must not be able to confirm a masked value by guessing it (PRD 103): what they typed
  // and what a tool returned are separate namespaces. Typed values are numbered from 1001 in a session of
  // their own, tool values from 1, so a correct guess gets a token no other than a wrong one would, and
  // neither the model nor the answer can tell the two apart. Staff, who may see it all, share one session.
  const typed = input.masked
    ? answerRedactor.session({ scope: input.scope, snapshot: typedNamespace(input.scope) })
    : session;
  const report = (): RedactionReport => {
    const a = session.report();
    const b = typed === session ? { total: 0, byKind: {} } : typed.report();
    const byKind: Record<string, number> = { ...a.byKind };
    for (const [kind, count] of Object.entries(b.byKind))
      byKind[kind] = (byKind[kind] ?? 0) + count;
    return { total: a.total + b.total, byKind };
  };
  /** Typed values first (only those tokens are in `typed`), then what the tools returned. */
  const restoreText = (text: string, audience: 'internal' | 'customer'): string =>
    session.restore(typed === session ? text : typed.restore(text, 'customer').text, audience).text;
  let answer: z.infer<typeof answerShape>;
  try {
    const system = session.redact(
      renderPrompt(answerPrompt.body, {
        language: input.locale === 'th' ? 'Thai' : 'English',
        maxClaims: String(input.limits.maxClaims),
        maxProposals: String(input.limits.maxProposals),
        proposalKinds: input.proposalKinds.length === 0 ? 'none' : input.proposalKinds.join(', '),
      }),
    );
    const factLines = facts
      .map((fact, index) =>
        session.redactToolOutput(
          'assistant',
          `[e${String(index + 1)}] ${fact.kind}${fact.mock === true ? ' (mock data)' : ''}: ${neutralize(fact.text)}`,
        ),
      )
      .map((line) => clipRedacted(line, MAX_FACT_CHARS + 40));
    const results_ =
      factLines.length === 0
        ? [
            session.redact(
              '<tool_results>\n(no tool was run or nothing was found)\n</tool_results>',
            ),
          ]
        : [session.redact('<tool_results>'), ...factLines, session.redact('</tool_results>')];
    const user = joinRedacted(
      [
        session.redact(renderContext(input)),
        ...renderHistory(input, session),
        ...results_,
        typed.redact(`<request>\n${request}\n</request>`),
      ],
      '\n',
    );
    const result = await deps.llm.generate({
      agent: 'personal_assistant',
      prompt: answerPrompt.ref,
      system,
      messages: [{ role: 'user', content: user }],
      redaction: { report },
      ticketId: null,
      toolCalls: () => input.host.tools.calls(),
      maxOutputTokens: 900,
      temperature: 0,
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    });
    results.push(result);
    const parsed = answerShape.safeParse(extractJsonObject(result.response.text));
    if (!parsed.success) return { status: 'failed', reason: 'model_output_invalid' };
    answer = parsed.data;
  } catch (error) {
    const reason = skippedFor(error);
    if (reason !== null) return { status: 'skipped', reason };
    return failureFor(error);
  }

  // Claims: the model cites ids; the chips come from the facts the host built, never from the model.
  const audience = input.masked ? 'customer' : 'internal';
  const restore = (text: string): string => restoreText(text, audience);
  const claims: Claim[] = [];
  const redactedParts: string[] = [];
  for (const item of answer.claims) {
    const evidence: ClaimEvidence[] = [];
    for (const id of new Set(item.evidenceIds)) {
      const index = /^e(\d{1,3})$/.exec(id)?.[1];
      const fact = index === undefined ? undefined : facts[Number(index) - 1];
      if (fact === undefined) continue;
      evidence.push({
        kind: fact.kind,
        label: fact.label,
        ...(fact.href === undefined ? {} : { href: fact.href }),
        ...(fact.mock === true ? { mock: true } : {}),
      });
    }
    const candidate = makeClaim(stripLinks(restore(item.text)).slice(0, 600), evidence);
    if (claimSchema.safeParse(candidate).success) {
      claims.push(candidate);
      // Model words coming back in: placeholders it was given stay, anything else that looks like personal
      // data becomes a placeholder too, so what is stored holds nothing the redactor would have caught (N4).
      redactedParts.push(session.fromModel(item.text));
    }
    if (claims.length >= input.limits.maxClaims) break;
  }

  // Proposals: structural fields come back only as far as the person typed them; free text as read.
  const proposals: ProposalIntent[] = [];
  for (const raw of answer.proposals) {
    const parsed = proposalIntentSchema.safeParse(raw);
    if (!parsed.success || !input.proposalKinds.includes(parsed.data.kind)) continue;
    proposals.push(
      restoreIntent(
        parsed.data,
        { restore: (text, who) => ({ text: restoreText(text, who) }) },
        audience,
      ),
    );
    if (proposals.length >= input.limits.maxProposals) break;
  }

  return {
    status: 'ok',
    claims,
    redactedText: redactedParts.join('\n'),
    names,
    proposals,
    tools,
    runIds: results.flatMap((result) => (result.runId === null ? [] : [result.runId])),
    usage: sumUsage(results),
  };
}

/** A session start whose numbering begins at 1001, so what it issues cannot be mistaken for a token of the main session. */
function typedNamespace(scope: string): RedactionSnapshot {
  return {
    scope,
    tokens: Object.fromEntries(
      REDACTION_KINDS.map((kind) => [`[${kind}_1000]`, { value: '', origin: 'model' as const }]),
    ),
  };
}

/**
 * A link in a sentence a model wrote is not a link the person gets (only the chips the host built are).
 * Taken out so a screen that makes URLs clickable cannot be used to send someone off the app.
 */
export function stripLinks(text: string): string {
  // Up to the end of the word, leaving the full stop or comma that closed the sentence.
  return text.replaceAll(
    /\b(?:https?:\/\/|ftp:\/\/|www\.|javascript:|data:)\S*?(?=[.,;:!?)\]]*(?:\s|$))/gi,
    '[link removed]',
  );
}

/**
 * Tool arguments are written by the model from a redacted request, so a search for an address
 * arrives as a placeholder. Only the person's own words are put back (`customer` audience restores
 * `ticket` origin tokens, which is what a typed request is); a placeholder the model invented stays
 * a placeholder and finds nothing.
 */
function restoreStrings(value: unknown, session: RedactionSession): unknown {
  if (typeof value === 'string') return session.restore(value, 'customer').text;
  if (Array.isArray(value)) return value.map((item) => restoreStrings(item, session));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, restoreStrings(item, session)]),
    );
  }
  return value;
}

/**
 * A model can print any placeholder, so a structural field (who to assign, which address) is
 * restored only from tokens of the person's own message (`customer` audience restores `ticket`
 * origin only). Free text the person reads on the card before pressing is restored for them.
 */
function restoreIntent(
  intent: ProposalIntent,
  session: { restore(text: string, audience: 'internal' | 'customer'): { text: string } },
  freeTextAudience: 'internal' | 'customer',
): ProposalIntent {
  const own = (text: string): string => session.restore(text, 'customer').text;
  const free = (text: string): string => session.restore(text, freeTextAudience).text;
  switch (intent.kind) {
    case 'assign':
      return {
        ...intent,
        ticket: own(intent.ticket),
        assignee: intent.assignee && own(intent.assignee),
      };
    case 'status':
      return {
        ...intent,
        ticket: own(intent.ticket),
        ...(intent.reason === undefined ? {} : { reason: free(intent.reason) }),
      };
    case 'tag':
      return {
        ...intent,
        ticket: own(intent.ticket),
        ...(intent.add === undefined ? {} : { add: intent.add.map(own) }),
        ...(intent.remove === undefined ? {} : { remove: intent.remove.map(own) }),
      };
    case 'note':
      return { ...intent, ticket: own(intent.ticket), body: free(intent.body) };
    case 'create_ticket':
      return {
        ...intent,
        org: own(intent.org),
        subject: free(intent.subject),
        body: free(intent.body),
        ...(intent.requesterEmail === undefined
          ? {}
          : { requesterEmail: own(intent.requesterEmail) }),
        ...(intent.requesterName === undefined ? {} : { requesterName: own(intent.requesterName) }),
      };
    case 'kb_draft':
      return { ...intent, title: free(intent.title), bodyMd: free(intent.bodyMd) };
    case 'reply_draft':
      return {
        ...intent,
        ticket: own(intent.ticket),
        ...(intent.instruction === undefined ? {} : { instruction: free(intent.instruction) }),
      };
  }
}
