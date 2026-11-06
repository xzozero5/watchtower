import type { RateLimiter } from '../auth/rate-limiter.js';
import type { AssistantToolName } from './assistant-access.js';

export const ASSISTANT_TOOL_BUDGET = { calls: 60, windowSeconds: 3600 } as const;

/** One Redis counter per authenticated person and tool, including deterministic prefetch. */
export function assistantToolBudget(limiter: Pick<RateLimiter, 'enforce'>, userId: string) {
  return (tool: AssistantToolName): Promise<void> =>
    limiter.enforce(
      `assistant-tool:${tool}`,
      userId,
      ASSISTANT_TOOL_BUDGET.calls,
      ASSISTANT_TOOL_BUDGET.windowSeconds,
    );
}
