import { describe, expect, it, vi } from 'vitest';

import { createDataToolPort } from './system-tool-ports.js';
import { readOnlyLoginProblems, type ReadDb } from './tool-ports.js';

// T-114a C-4 (N2): the AI data tool refuses a source that is not hardened, and the worker checks
// that AI_READONLY_DATABASE_URL really is a read-only login.

const input = {
  intentKey: 'login_issue',
  ticketId: '00000000-0000-4000-8000-000000000001',
  limit: 10,
  signal: new AbortController().signal,
};

describe('createDataToolPort hardening gate', () => {
  it('refuses to run when the hardening check reports a problem, and never reads a template', async () => {
    const select = vi.fn();
    const data = vi.fn();
    const port = createDataToolPort({ select } as never, {
      data,
      dataMock: false,
      dataHardening: () => Promise.resolve(['the reader can use COPY']),
    });
    const result = await port?.run(input);
    expect(result?.items).toEqual([]);
    expect(result?.note).toMatch(/not read-only/);
    expect(select).not.toHaveBeenCalled();
    expect(data).not.toHaveBeenCalled();
  });

  it('refuses when the hardening check itself fails (fail closed)', async () => {
    const select = vi.fn();
    const port = createDataToolPort({ select } as never, {
      data: vi.fn(),
      dataMock: false,
      dataHardening: () => Promise.reject(new Error('down')),
    });
    const result = await port?.run(input);
    expect(result?.note).toMatch(/not read-only/);
    expect(select).not.toHaveBeenCalled();
  });
});

const dbReturning = (row: Record<string, unknown> | undefined): ReadDb =>
  ({
    execute: () => Promise.resolve({ rows: row === undefined ? [] : [row] }),
    transaction: vi.fn(),
  }) as unknown as ReadDb;

describe('readOnlyLoginProblems', () => {
  const good = { superuser: false, bypass_rls: false, member: true, writable: '0' };

  it('accepts a read-only member of watchtower_ai_ro', async () => {
    expect(await readOnlyLoginProblems(dbReturning(good))).toEqual([]);
  });

  it('flags a login that can write, is not a member, or is a superuser', async () => {
    expect(await readOnlyLoginProblems(dbReturning({ ...good, writable: '12' }))).toEqual([
      'the login can write to 12 table(s)',
    ]);
    expect(await readOnlyLoginProblems(dbReturning({ ...good, member: false }))).toEqual([
      'the login is not a member of watchtower_ai_ro',
    ]);
    expect(await readOnlyLoginProblems(dbReturning({ ...good, superuser: true }))).toContain(
      'the login is a superuser',
    );
  });

  it('fails closed when the query fails or returns no role', async () => {
    const broken = {
      execute: () => Promise.reject(new Error('boom')),
      transaction: vi.fn(),
    } as unknown as ReadDb;
    expect(await readOnlyLoginProblems(broken)).toHaveLength(1);
    expect(await readOnlyLoginProblems(dbReturning(undefined))).toHaveLength(1);
  });
});
