import { z } from 'zod';

/**
 * Whether the AI can be reached right now (T-170). The worker is the only process on the network of
 * the claude-bridge (ADR-019), so it probes the bridge and leaves the answer in Redis; the api reads
 * that key and serves it to the console. The shape carries no URL and no token.
 *
 * - `online`:   the provider answers (a real API provider is assumed up; claude-cli is probed).
 * - `offline`:  the provider is selected but cannot be reached (claude-cli host has no internet, the
 *               bridge is down, or the worker has not reported lately). AI jobs wait and retry.
 * - `disabled`: no real provider is selected (`AI_PROVIDER=mock`); nothing to wait for.
 */
export const AI_STATUS_VALUES = ['online', 'offline', 'disabled'] as const;
export type AiStatusValue = (typeof AI_STATUS_VALUES)[number];

export const aiStatusSchema = z.object({
  status: z.enum(AI_STATUS_VALUES),
  /** When the worker last checked, ISO 8601. Null when the api never heard from the worker. */
  checkedAt: z.iso.datetime().nullable(),
});
export type AiStatus = z.infer<typeof aiStatusSchema>;

/**
 * Today's AI spend against the daily caps (T-142, PRD section 6.6). The day is UTC. `level` is `ok`,
 * `alert` (at or above `alertPercent` of a cap) or `stop` (a cap is reached: the app's AI runs
 * stop and every answer falls back to rules until `resetsAt`). The assistant has its own cap per
 * person; `users` lists today's heaviest users, by tokens.
 */
export const aiBudgetSchema = z.object({
  day: z.string(),
  resetsAt: z.iso.datetime(),
  level: z.enum(['ok', 'alert', 'stop']),
  alertPercent: z.number(),
  cost: z.object({ spentUsd: z.number(), capUsd: z.number() }),
  tokens: z.object({ spent: z.number(), cap: z.number() }),
  assistant: z.object({
    userDailyTokens: z.number(),
    users: z.array(
      // No user id: the card shows a name and numbers, so nothing else about a person leaves the api (T-175a).
      z.object({
        name: z.string(),
        tokens: z.number(),
        messages: z.number(),
        costUsd: z.number().nullable(),
      }),
    ),
  }),
});
export type AiBudget = z.infer<typeof aiBudgetSchema>;

/**
 * Which model each AI agent uses (T-301c), read-only. `source` says where the choice came from:
 * `default` (the agent's default tier), `tier` (`AI_AGENT_MODEL_<AGENT>` named a tier) or `alias`
 * (it named a model directly). `model` is null when the tier has no model configured (calls are
 * refused). `grader` is flagged when it runs on the same model as the drafter, because an
 * independent grader needs a different model (ADR-025 condition 7).
 */
export const aiModelMappingSchema = z.object({
  provider: z.string(),
  agents: z.array(
    z.object({
      agent: z.string(),
      tier: z.enum(['deep', 'standard', 'light']),
      model: z.string().nullable(),
      source: z.enum(['default', 'tier', 'alias']),
      priced: z.boolean(),
    }),
  ),
  graderIndependent: z.boolean(),
});
export type AiModelMapping = z.infer<typeof aiModelMappingSchema>;

/** Redis key the worker writes and the api reads. */
export const AI_STATUS_REDIS_KEY = 'watchtower:ai:status';
/** How often the worker probes (ms), and how long a report stays valid (ms): a missed report or two means offline. */
export const AI_STATUS_PROBE_INTERVAL_MS = 15_000;
export const AI_STATUS_TTL_MS = 50_000;
