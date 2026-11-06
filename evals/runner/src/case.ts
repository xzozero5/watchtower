import { insightElementKeySchema, insightFactSchema } from '@watchtower/shared';
import { z } from 'zod';
import { assistantCaseSchema } from './assistant-case.js';

/**
 * One eval case (PRD 6.5 step 3): an input an agent gets, and what a good answer must satisfy.
 * A case holds ticket text only after redaction: the replay export redacts before it writes, and a
 * golden case is written by a person from a made-up or anonymised ticket (N1, N4).
 *
 * `mockAnswer` is what the offline mock provider answers for this case. It exists so the harness and
 * the checks can be tested with no key: it is ignored by every real provider.
 */

export const EVAL_AGENTS = [
  'classifier',
  'drafter',
  'grader',
  'kb_author',
  'insight_narrator',
  'personal_assistant',
] as const;
export const evalAgentSchema = z.enum(EVAL_AGENTS);
export type EvalAgent = z.infer<typeof evalAgentSchema>;

/** The prompt each agent runs, so a report can say which version produced a result. */
export const PROMPT_OF_AGENT: Readonly<Record<EvalAgent, string>> = {
  classifier: 'classifier',
  drafter: 'drafter',
  grader: 'grader',
  kb_author: 'kb_author',
  insight_narrator: 'element_insight',
  personal_assistant: 'assistant_turn',
};

export const EVAL_SOURCES = ['golden', 'replay', 'smoke', 'proposal'] as const;
export type EvalSource = (typeof EVAL_SOURCES)[number];

const turnSchema = z.object({
  from: z.enum(['customer', 'staff', 'note']),
  text: z.string().min(1).max(8000),
});

const base = {
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,80}$/, 'id: lowercase letters, digits, . _ -'),
  description: z.string().max(500).optional(),
  /** Intent the case is about, for the report. */
  intent: z.string().max(80).optional(),
  /** What the mock provider answers. Text, or an object that is sent as JSON. */
  mockAnswer: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  /** Names the redactor must know for this case (people in the text). */
  names: z.array(z.string().min(1).max(128)).max(50).optional(),
};

const classifierCase = z.object({
  ...base,
  agent: z.literal('classifier'),
  input: z.object({
    channel: z.string().min(1).max(40),
    subject: z.string().max(500),
    body: z.string().max(8000),
    intents: z
      .array(z.object({ key: z.string().min(1).max(120), name: z.string().min(1).max(200) }))
      .min(1)
      .max(100),
  }),
  expect: z.object({
    /** `null`: the message fits no intent. */
    intentKey: z.string().nullable(),
    type: z.string().optional(),
    minConfidence: z.number().min(0).max(1).optional(),
  }),
});

const evidenceSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(['kb', 'ticket', 'log', 'data', 'repo']),
  title: z.string().max(300),
  snippet: z.string().max(1000),
  confidence: z.number().min(0).max(1).default(0.8),
  tool: z.string().min(1).max(60).default('kb_search'),
  customerSafe: z.boolean().default(false),
  mock: z.boolean().default(true),
  href: z.string().max(2000).optional(),
});

const drafterCase = z.object({
  ...base,
  agent: z.literal('drafter'),
  input: z.object({
    subject: z.string().max(500),
    turns: z.array(turnSchema).min(1).max(40),
    intentKey: z.string().nullable().default(null),
    customerLanguage: z.enum(['th', 'en']),
    disclosure: z.enum(['verified', 'restricted']).default('restricted'),
    evidence: z.array(evidenceSchema).max(20).default([]),
  }),
  expect: z.object({
    language: z.enum(['th', 'en']).optional(),
    mustContain: z.array(z.string().min(1)).max(20).optional(),
    mustNotContain: z.array(z.string().min(1)).max(20).optional(),
    maxUncitedClaims: z.number().int().min(0).optional(),
    /** Default true: a draft with a stray placeholder or the wrong language needs review and is a failure. */
    noReviewFlag: z.boolean().default(true),
  }),
});

const graderCase = z.object({
  ...base,
  agent: z.literal('grader'),
  input: z.object({
    ticketKey: z.string().max(40).default('EVAL-1'),
    turns: z.array(turnSchema).min(1).max(40),
    sentReply: z.string().max(8000).optional(),
    draftText: z.string().max(8000).optional(),
    csat: z
      .object({
        score: z.number().int().min(1).max(5).nullable(),
        resolved: z.boolean().nullable(),
        comment: z.string().max(1000).optional(),
      })
      .optional(),
    kbCited: z.boolean().default(false),
    locale: z.enum(['th', 'en']).default('en'),
  }),
  expect: z.object({
    resolutionClass: z.enum(['verified', 'contained', 'assumed']).optional(),
    resolutionClassIn: z
      .array(z.enum(['verified', 'contained', 'assumed']))
      .min(1)
      .optional(),
    draftVerdictIn: z
      .array(z.enum(['matches', 'partial', 'differs', 'no_draft']))
      .min(1)
      .optional(),
    minDraftQuality: z.number().min(0).max(1).optional(),
    maxViolations: z.number().int().min(0).optional(),
    minViolations: z.number().int().min(0).optional(),
    kbGap: z.boolean().optional(),
  }),
});

const kbAuthorCase = z.object({
  ...base,
  agent: z.literal('kb_author'),
  input: z.object({
    subject: z.string().max(500),
    turns: z.array(turnSchema).min(1).max(40),
    intentKey: z.string().nullable().default(null),
    knownIntents: z.array(z.string().max(63)).max(100).default([]),
  }),
  expect: z.object({
    /** `false`: the ticket holds too little to write from (no article). */
    drafted: z.boolean().default(true),
    titleContains: z.array(z.string().min(1)).max(10).optional(),
    bodyMustNotContain: z.array(z.string().min(1)).max(20).optional(),
    tagsInclude: z.array(z.string().min(1)).max(10).optional(),
  }),
});

/**
 * Embedded insights (T-417, ADR-029 section 9.8): a batch of elements of one viewer group, each with the facts
 * its builder gave, and what the narration may and may not say. Facts are made-up figures (N1); `names` are the
 * made-up staff the redactor must know, so a person fact reaches the model as a placeholder (N4).
 *
 * The checks that hold for every case, whatever `expect` says: no number that is not in a fact the claim cites,
 * no claim without a fact id, the language of the list, no placeholder-less personal data, and for an element
 * with people the same tone check the agent applies (read again here, so a change to the agent cannot hide it).
 */
const insightCase = z.object({
  ...base,
  agent: z.literal('insight_narrator'),
  input: z.object({
    elements: z
      .array(
        z.object({
          key: insightElementKeySchema,
          scopeKey: z.string().min(1).max(100).default('instance'),
          facts: z.array(insightFactSchema).max(60),
        }),
      )
      .min(1)
      .max(4),
    locales: z
      .array(z.enum(['th', 'en']))
      .min(1)
      .max(2)
      .default(['th', 'en']),
  }),
  expect: z.object({
    /** Per element: what its accepted claims must satisfy (an element not listed only gets the checks above). */
    elements: z
      .record(
        z.string(),
        z.object({
          /** Words (a driver the facts name) that must appear in at least one accepted claim of each language. */
          mustMention: z.array(z.string().min(1)).max(10).optional(),
          mustNotContain: z.array(z.string().min(1)).max(20).optional(),
          /** 0 for a "nothing changed" case: silence is the right answer. */
          maxClaims: z.number().int().min(0).max(3).optional(),
          minClaims: z.number().int().min(0).max(3).optional(),
        }),
      )
      .default({}),
    /** At most this many claims rejected in code: a real model that keeps ranking people shows up here. */
    maxRejected: z.number().int().min(0).optional(),
    /** The mock case only: reasons the agent must have rejected for (proves the post-check, not the model). */
    mustRejectFor: z.array(z.string().min(1)).max(10).optional(),
  }),
});

export const evalCaseSchema = z.discriminatedUnion('agent', [
  classifierCase,
  drafterCase,
  graderCase,
  kbAuthorCase,
  insightCase,
  assistantCaseSchema,
]);
export type EvalCase = z.infer<typeof evalCaseSchema>;
export type ClassifierCase = z.infer<typeof classifierCase>;
export type DrafterCase = z.infer<typeof drafterCase>;
export type GraderCase = z.infer<typeof graderCase>;
export type KbAuthorCase = z.infer<typeof kbAuthorCase>;
export type InsightCase = z.infer<typeof insightCase>;

/** A file holds one case, an array of cases, or `{ "cases": [...] }`. */
export const evalFileSchema = z.union([
  evalCaseSchema.transform((one) => [one]),
  z.array(evalCaseSchema),
  z.object({ cases: z.array(evalCaseSchema) }).transform((wrapped) => wrapped.cases),
]);

export interface LoadedCase {
  readonly case: EvalCase;
  readonly source: EvalSource;
  readonly file: string;
}
