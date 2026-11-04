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

/** Redis key the worker writes and the api reads. */
export const AI_STATUS_REDIS_KEY = 'watchtower:ai:status';
/** How often the worker probes (ms), and how long a report stays valid (ms): a missed report or two means offline. */
export const AI_STATUS_PROBE_INTERVAL_MS = 15_000;
export const AI_STATUS_TTL_MS = 50_000;
