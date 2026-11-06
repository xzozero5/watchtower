import { claimEvidenceKindSchema } from '@watchtower/shared';
import { z } from 'zod';

const ref = z.object({ kind: claimEvidenceKindSchema, id: z.string().min(1).max(100) });
export const assistantFixtureFact = z.object({
  kind: claimEvidenceKindSchema,
  label: z.string().min(1).max(200),
  text: z.string().max(4000),
  ref: ref.optional(),
  trust: z.enum(['system', 'staff', 'customer']),
  names: z.array(z.string()).optional(),
  mock: z.literal(true).default(true),
});

export const assistantCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,80}$/),
  agent: z.literal('personal_assistant'),
  description: z.string().max(500).optional(),
  names: z.array(z.string()).optional(),
  mockTurns: z.array(z.record(z.string(), z.unknown())).min(1).max(2).optional(),
  mockAnswer: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  intent: z.string().optional(),
  input: z.object({
    role: z.string(),
    locale: z.enum(['th', 'en']),
    question: z.string().max(2000),
    page: z.string().optional(),
    entities: z
      .array(z.object({ kind: z.string(), id: z.string(), label: z.string() }))
      .max(20)
      .default([]),
    fixtures: z
      .array(z.object({ tool: z.string(), facts: z.array(assistantFixtureFact).max(30) }))
      .max(24),
    masked: z.boolean().default(false),
  }),
  expect: z.object({
    mustCiteRefs: z.array(ref).default([]),
    mustNotMention: z.array(z.string()).default([]),
    path: z.enum(['facts_only', 'llm1', 'llm2']).optional(),
    maxUncited: z.number().int().min(0).optional(),
  }),
});
export type AssistantCase = z.infer<typeof assistantCaseSchema>;
