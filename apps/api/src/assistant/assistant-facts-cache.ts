import { createHmac } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { REDIS } from '../redis/redis.module.js';

const entry = z.strictObject({
  text: z.string().max(600),
  ref: z.strictObject({ kind: z.string().max(40), id: z.string().max(200) }).nullable(),
});
const payload = z.array(entry).max(5);
export type CachedAssistantFacts = z.infer<typeof payload>;

export interface AssistantCacheScope {
  userId: string;
  permissions: readonly string[];
  role: string;
  starter: string;
  locale: string;
  promptVersion: string;
}

/** Cache only deterministic redacted facts. Reads and permission checks still run on every hit. */
@Injectable()
export class AssistantFactsCache {
  constructor(
    @Inject(REDIS) private readonly redis: Pick<Redis, 'get' | 'set'>,
    @Inject(APP_CONFIG)
    private readonly config: Pick<ApiConfig, 'APP_ENCRYPTION_KEY' | 'RATE_LIMIT_NAMESPACE'>,
  ) {}

  key(scope: AssistantCacheScope, facts: CachedAssistantFacts): string {
    const digest = (value: unknown): string =>
      createHmac('sha256', this.config.APP_ENCRYPTION_KEY)
        .update(JSON.stringify(value))
        .digest('hex');
    const permissionSetHash = digest([scope.role, [...scope.permissions].sort()]);
    return `${this.config.RATE_LIMIT_NAMESPACE}:assistant:facts:${digest([
      scope.userId,
      permissionSetHash,
      scope.starter,
      scope.locale,
      scope.promptVersion,
      digest(facts),
    ])}`;
  }

  async resolve(
    scope: AssistantCacheScope,
    facts: CachedAssistantFacts,
  ): Promise<CachedAssistantFacts> {
    const current = payload.parse(facts);
    const key = this.key(scope, current);
    try {
      const raw = await this.redis.get(key);
      if (raw !== null) {
        const parsed = payload.safeParse(JSON.parse(raw));
        // Fresh refs and fingerprint are authoritative; never accept a poisoned/stale cache payload.
        if (parsed.success && JSON.stringify(parsed.data) === JSON.stringify(current))
          return parsed.data;
      }
      await this.redis.set(key, JSON.stringify(current), 'EX', 600);
    } catch {
      // Cache is optional; the freshly authorized, redacted facts remain usable.
    }
    return current;
  }
}
