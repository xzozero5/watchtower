import type { Database } from '@watchtower/db';
import type { Domain } from '@watchtower/domain';
import { describe, expect, it, vi } from 'vitest';

import { KbEmbeddingService } from './kb-embedding.service.js';
import { KbSearchError, safeErrorLabel } from './kb-errors.js';
import { KbService } from './kb.service.js';

const LEAK = 'my card number is 4111 1111 1111 1111';

/** What Drizzle throws: the statement and the parameters are in the message. */
function drizzleError(): Error {
  const cause = Object.assign(new Error('invalid byte sequence'), { code: '22021' });
  return new Error(`Failed query: SELECT c.id FROM kb_chunk c WHERE ...\nparams: ${LEAK}`, {
    cause,
  });
}

function serviceWith(execute: () => Promise<never>): KbService {
  const database = { db: { execute } } as unknown as Database;
  const embeddings = {
    embedQuery: () => Promise.resolve(undefined),
  } as unknown as KbEmbeddingService;
  return new KbService({} as Domain, database, embeddings, { KB_MIN_VECTOR_SIMILARITY: 0.25 });
}

describe('a database error during search (P3-1)', () => {
  it('reaches the log as a SQLSTATE only: no statement, no parameters, no cause', async () => {
    const failing = serviceWith(() => Promise.reject(drizzleError()));
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
    const failing = serviceWith(() => Promise.reject(drizzleError()));
    await expect(
      failing.searchForCustomer('5b0b8f0e-6c6e-4f5e-9d6e-1b2c3d4e5f60', { q: LEAK, limit: 5 }),
    ).rejects.toThrow(/^Knowledge base search failed \(SQLSTATE 22021\)$/);
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
