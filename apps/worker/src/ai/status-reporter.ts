import {
  AI_STATUS_PROBE_INTERVAL_MS,
  AI_STATUS_REDIS_KEY,
  AI_STATUS_TTL_MS,
  type AiStatus,
  type AiStatusValue,
} from '@watchtower/shared';
import { z } from 'zod';

import type { WorkerLogger } from '../logger.js';
import { DEFAULT_CLAUDE_CLI_BRIDGE_URL } from './runtime.js';

const healthSchema = z.object({ online: z.boolean() });
const PROBE_TIMEOUT_MS = 5000;

export interface AiStatusProbeInput {
  readonly provider: string;
  readonly bridgeUrl: string | undefined;
  readonly fetch: (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;
}

/**
 * Reads the status of the selected provider (T-170). `mock` is `disabled`. `claude-cli` asks the
 * bridge's open `/healthz` (it answers only status and online, ADR-019). A real API provider has no
 * cheap probe that costs nothing, so it counts as `online`; its failures still show on `ai_run`.
 * Never throws and never returns the bridge URL.
 */
export async function probeAiStatus(input: AiStatusProbeInput): Promise<AiStatusValue> {
  if (input.provider === 'mock') return 'disabled';
  if (input.provider !== 'claude-cli') return 'online';
  try {
    const url = new URL('/healthz', input.bridgeUrl ?? DEFAULT_CLAUDE_CLI_BRIDGE_URL);
    const response = await input.fetch(url.toString(), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return 'offline';
    const body = healthSchema.safeParse(await response.json());
    return body.success && body.data.online ? 'online' : 'offline';
  } catch {
    return 'offline';
  }
}

export interface AiStatusStore {
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
}

export interface AiStatusReporter {
  stop(): void;
}

/** Probes now and every 15 s, and leaves the answer in Redis for the api. Errors are logged, not thrown. */
export function startAiStatusReporter(deps: {
  readonly probe: () => Promise<AiStatusValue>;
  readonly store: AiStatusStore;
  readonly logger: WorkerLogger;
  readonly now?: () => Date;
  readonly intervalMs?: number;
}): AiStatusReporter {
  const now = deps.now ?? ((): Date => new Date());
  const report = async (): Promise<void> => {
    try {
      const value: AiStatus = { status: await deps.probe(), checkedAt: now().toISOString() };
      await deps.store.set(AI_STATUS_REDIS_KEY, JSON.stringify(value), 'PX', AI_STATUS_TTL_MS);
    } catch (error) {
      deps.logger.warn({ err: error }, 'AI status could not be reported');
    }
  };
  void report();
  const timer = setInterval(() => {
    void report();
  }, deps.intervalMs ?? AI_STATUS_PROBE_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
