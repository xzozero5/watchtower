import { readFileSync } from 'node:fs';

import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@watchtower/db';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { parseResponse } from '../common/zod-openapi.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { REDIS } from '../redis/redis.module.js';
import { livenessSchema, readinessSchema, type Liveness, type Readiness } from './health.schema.js';

const CHECK_TIMEOUT_MS = 2000;

const packageJsonSchema = z.object({ version: z.string() });

/** Reads the version from this app's package.json (same relative path in src/ and dist/). */
function readVersion(): string {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  return packageJsonSchema.parse(raw).version;
}

@Injectable()
export class HealthService {
  private readonly version = readVersion();

  constructor(
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  /** Liveness: the process is up. Deliberately touches no dependency. */
  liveness(): Liveness {
    return parseResponse(livenessSchema, {
      status: 'ok',
      service: this.config.OTEL_SERVICE_NAME,
      version: this.version,
      uptimeSeconds: process.uptime(),
    });
  }

  /** Readiness: Postgres and Redis answer. Failure details go to the log, not the response. */
  async readiness(): Promise<Readiness> {
    const [database, redis] = await Promise.all([
      this.check('database', () => this.database.ping(CHECK_TIMEOUT_MS)),
      this.check('redis', () => this.pingRedis()),
    ]);
    return parseResponse(readinessSchema, {
      status: database.status === 'up' && redis.status === 'up' ? 'ok' : 'unavailable',
      checks: { database, redis },
    });
  }

  private async pingRedis(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`redis did not answer within ${String(CHECK_TIMEOUT_MS)} ms`));
      }, CHECK_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.redis.ping(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async check(
    name: string,
    run: () => Promise<void>,
  ): Promise<{ status: 'up' | 'down'; latencyMs: number }> {
    const started = performance.now();
    try {
      await run();
      return { status: 'up', latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      this.logger.warn({ err: error, dependency: name }, 'readiness check failed');
      return { status: 'down', latencyMs: Math.round(performance.now() - started) };
    }
  }
}
