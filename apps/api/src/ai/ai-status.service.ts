import { Inject, Injectable } from '@nestjs/common';
import { AI_STATUS_REDIS_KEY, aiStatusSchema, type AiStatus } from '@watchtower/shared';
import type { Redis } from 'ioredis';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { REDIS } from '../redis/redis.module.js';

/** The answer is reused this long, so a console full of tabs makes one Redis read per few seconds. */
const CACHE_MS = 5000;

/**
 * Whether the AI can be reached (T-170). The worker probes the provider and leaves the result in
 * Redis (it probes the claude-bridge on a schedule, ADR-019; the api is on that network too for the assistant, ADR-023); this reads it. `mock` is
 * `disabled`; a missing, stale or unreadable report is `offline`, because nobody is checking the AI.
 * Nothing about the bridge (URL, token) is ever returned.
 */
@Injectable()
export class AiStatusService {
  private cached: { readonly at: number; readonly value: AiStatus } | undefined;

  constructor(
    @Inject(REDIS) private readonly redis: Pick<Redis, 'get'>,
    @Inject(APP_CONFIG) private readonly config: Pick<ApiConfig, 'AI_PROVIDER'>,
  ) {}

  /** The clock; a test replaces it. */
  now: () => number = Date.now;

  async status(): Promise<AiStatus> {
    if (this.config.AI_PROVIDER === 'mock') return { status: 'disabled', checkedAt: null };
    const at = this.now();
    if (this.cached !== undefined && at - this.cached.at < CACHE_MS) return this.cached.value;
    const value = await this.read();
    this.cached = { at, value };
    return value;
  }

  private async read(): Promise<AiStatus> {
    try {
      const raw = await this.redis.get(AI_STATUS_REDIS_KEY);
      if (raw === null) return { status: 'offline', checkedAt: null };
      const parsed = aiStatusSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : { status: 'offline', checkedAt: null };
    } catch {
      return { status: 'offline', checkedAt: null };
    }
  }
}
