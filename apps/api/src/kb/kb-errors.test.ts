import type { Database } from '@watchtower/db';
import type { Domain } from '@watchtower/domain';
import { describe, expect, it, vi } from 'vitest';

import { ApiHttpError } from '../auth/http-errors.js';
import type { RateLimitResult } from '../auth/rate-limiter.js';
import { KbEmbeddingService } from './kb-embedding.service.js';
import { KbSearchError, safeErrorLabel } from './kb-errors.js';
import { KbService, customerEmbedsPerDay } from './kb.service.js';

const LEAK = 'my card number is 4111 1111 1111 1111';

/** What Drizzle throws: the statement and the parameters are in the message. */
function drizzleError(): Error {
  const cause = Object.assign(new Error('invalid byte sequence'), { code: '22021' });
  return new Error(`Failed query: SELECT c.id FROM kb_chunk c WHERE ...\nparams: ${LEAK}`, {
    cause,
  });
}

function serviceWith(
  execute: () => Promise<unknown>,
  options: { allowed?: (scope: string) => boolean; limiterFails?: boolean } = {},
) {
  // A transaction that runs its callback on a handle with the same `execute`.
  const database = {
    db: { execute, transaction: (work: (tx: unknown) => unknown) => work({ execute }) },
  } as unknown as Database;
  const embedQuery = vi.fn(() => Promise.resolve(undefined));
  const hit = vi.fn((scope: string): Promise<RateLimitResult> => {
    if (options.limiterFails === true) return Promise.reject(new Error('redis is down'));
    return Promise.resolve({
      allowed: options.allowed?.(scope) ?? true,
      retryAfterSeconds: 1,
      count: 1,
    });
  });
  const service = new KbService(
    {} as Domain,
    database,
    { embedQuery } as unknown as KbEmbeddingService,
    { KB_MIN_VECTOR_SIMILARITY: 0.25, AI_DAILY_TOKEN_CAP: undefined },
    { hit },
  );
  return { service, fakes: { embedQuery, hit } };
}

describe('a database error during search (P3-1)', () => {
  it('reaches the log as a SQLSTATE only: no statement, no parameters, no cause', async () => {
    const { service: failing } = serviceWith(() => Promise.reject(drizzleError()));
    const error = await failing
      .search({ q: LEAK, limit: 5, audience: 'staff' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KbSearchError);
    const printed = `${String((error as Error).stack)} ${(error as Error).message} ${JSON.stringify(error)}`;
    expect(printed).not.toContain('4111');
    expect(printed).not.toContain('params');
    expect(printed).not.toContain('kb_chunk');
    expect((error as Error).message).toBe('Knowledge base search failed (SQLSTATE 22021)');
    expect((error as Error).cause).toBeUndefined();
  });

  it('does the same for a customer search', async () => {
    const { service: failing } = serviceWith(() => Promise.reject(drizzleError()));
    await expect(
      failing.searchForCustomer('5b0b8f0e-6c6e-4f5e-9d6e-1b2c3d4e5f60', { q: LEAK, limit: 5 }),
    ).rejects.toThrow(/^Knowledge base search failed \(SQLSTATE 22021\)$/);
  });
});

describe('a search that runs too long (P2)', () => {
  const stopped = () =>
    Promise.reject(
      new Error('Failed query: ...', {
        cause: Object.assign(new Error('canceling statement due to statement timeout'), {
          code: '57014',
        }),
      }),
    );

  it('answers 503 kb_search_timeout, for staff and for customers, without the query text', async () => {
    const { service } = serviceWith(stopped);
    for (const run of [
      () => service.search({ q: LEAK, limit: 5, audience: 'staff' }),
      () =>
        service.searchForCustomer('5b0b8f0e-6c6e-4f5e-9d6e-1b2c3d4e5f60', { q: LEAK, limit: 5 }),
    ]) {
      const error = await run().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiHttpError);
      expect((error as ApiHttpError).getStatus()).toBe(503);
      expect((error as ApiHttpError).code).toBe('kb_search_timeout');
      expect(JSON.stringify((error as ApiHttpError).getResponse())).not.toContain('4111');
    }
  });
});

describe('customer search embeddings have their own daily budget (po decision)', () => {
  const org = '5b0b8f0e-6c6e-4f5e-9d6e-1b2c3d4e5f60';
  const ok = () => Promise.resolve({ rows: [] });

  it('embeds while the organization and the customers are within their slice', async () => {
    const { service, fakes } = serviceWith(ok);
    await service.searchForCustomer(org, { q: 'reset password', limit: 5 });
    expect(fakes.embedQuery).toHaveBeenCalledTimes(1);
    expect(fakes.hit.mock.calls.map((call) => call[0])).toEqual([
      'kb-customer-embed-org',
      'kb-customer-embed-day',
    ]);
  });

  it('falls back to keyword only, with no error, when the organization used its share', async () => {
    const { service, fakes } = serviceWith(ok, {
      allowed: (scope) => scope !== 'kb-customer-embed-org',
    });
    await expect(
      service.searchForCustomer(org, { q: 'reset password', limit: 5 }),
    ).resolves.toEqual({ hits: [] });
    expect(fakes.embedQuery).not.toHaveBeenCalled();
  });

  it('does the same when the customers together used the slice, and when the counter is unreadable', async () => {
    const full = serviceWith(ok, { allowed: (scope) => scope !== 'kb-customer-embed-day' });
    await full.service.searchForCustomer(org, { q: 'reset password', limit: 5 });
    expect(full.fakes.embedQuery).not.toHaveBeenCalled();
    const down = serviceWith(ok, { limiterFails: true });
    await down.service.searchForCustomer(org, { q: 'reset password', limit: 5 });
    expect(down.fakes.embedQuery).not.toHaveBeenCalled();
  });

  it('never counts a staff search against the customers', async () => {
    const { service, fakes } = serviceWith(ok, { allowed: () => false });
    await service.search({ q: 'reset password', limit: 5, audience: 'staff' });
    expect(fakes.embedQuery).toHaveBeenCalledTimes(1);
    expect(fakes.hit).not.toHaveBeenCalled();
  });

  it('is 20% of the daily token cap at 100 tokens a query', () => {
    expect(customerEmbedsPerDay(undefined)).toBe(1000);
    expect(customerEmbedsPerDay(50_000)).toBe(100);
    expect(customerEmbedsPerDay(1)).toBe(1);
  });
});

describe('safeErrorLabel', () => {
  it('prints the class and the SQLSTATE, never the message', () => {
    expect(safeErrorLabel(drizzleError())).toBe('Error (SQLSTATE 22021)');
    expect(safeErrorLabel(new TypeError(LEAK))).toBe('TypeError');
    expect(safeErrorLabel('text')).toBe('UnknownError');
  });
});

describe('the embedding provider (P3-5)', () => {
  const build = (provider: string) =>
    new KbEmbeddingService(
      { db: {} } as unknown as Database,
      { EMBEDDING_PROVIDER: provider } as never,
      { warn: vi.fn() } as never,
    );

  it('builds with the mock', () => {
    expect(() => build('mock')).not.toThrow();
  });

  it('stops the boot for a provider that is not wired, naming the variable', () => {
    expect(() => build('vertex')).toThrow(/EMBEDDING_PROVIDER=vertex is not wired yet/);
  });
});
