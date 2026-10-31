import { createServer, type Server } from 'node:http';

import type { WorkerLogger } from './logger.js';

export type DependencyCheck = () => Promise<void>;

export interface HealthServerOptions {
  readonly service: string;
  readonly version: string;
  /** Named dependency checks run by /health/ready. */
  readonly checks: Readonly<Record<string, DependencyCheck>>;
  readonly logger: WorkerLogger;
  readonly timeoutMs?: number;
}

interface CheckResult {
  readonly status: 'up' | 'down';
  readonly latencyMs: number;
}

const DEFAULT_TIMEOUT_MS = 2000;

async function runCheck(check: DependencyCheck, timeoutMs: number): Promise<CheckResult> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer within ${String(timeoutMs)} ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([check(), timeout]);
    return { status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { status: 'down', latencyMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The worker has no public API, but Cloud Run and compose need something to probe (ADR-001:
 * health endpoint on every service).
 *
 *   GET /health        liveness, touches nothing
 *   GET /health/ready  Postgres and Redis answer; 503 otherwise (same body shape as the api)
 */
export function createHealthServer(options: HealthServerOptions): Server {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return createServer((request, response) => {
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (request.method !== 'GET') {
      send(405, { error: 'method not allowed' });
      return;
    }
    if (path === '/health') {
      send(200, {
        status: 'ok',
        service: options.service,
        version: options.version,
        uptimeSeconds: process.uptime(),
      });
      return;
    }
    if (path === '/health/ready') {
      void (async () => {
        const entries = await Promise.all(
          Object.entries(options.checks).map(
            async ([name, check]) => [name, await runCheck(check, timeoutMs)] as const,
          ),
        );
        const checks = Object.fromEntries(entries);
        const ok = entries.every(([, result]) => result.status === 'up');
        if (!ok) {
          options.logger.warn(
            { down: entries.filter(([, r]) => r.status === 'down').map(([name]) => name) },
            'readiness check failed',
          );
        }
        send(ok ? 200 : 503, { status: ok ? 'ok' : 'unavailable', checks });
      })();
      return;
    }
    send(404, { error: 'not found' });
  });
}
