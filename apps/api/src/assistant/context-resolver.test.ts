import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { forbidden, notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import {
  KINDS_WITHOUT_READER,
  resolveContext,
  type KindReader,
  type KindReaders,
} from './context-resolver.js';

const principal = { userId: 'u', permissions: new Set(), role: 'agent' } as unknown as Principal;
const ID = '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11';

const found: KindReader = (ref) =>
  Promise.resolve({ kind: 'incident', id: ref, label: `Incident ${ref}` });
const readers: KindReaders = {
  ticket: (ref) =>
    ref === 'OPS-1'
      ? Promise.resolve({ kind: 'ticket', id: 't1', label: 'OPS-1', href: '/?ticket=OPS-1' })
      : ref === 'OPS-403'
        ? Promise.reject(forbidden())
        : ref === 'OPS-404'
          ? Promise.reject(notFound('No such ticket'))
          : Promise.resolve(null),
  incident: found,
};

describe('resolveContext', () => {
  it('drops a missing ref, a forbidden ref and a null alike', async () => {
    const result = await resolveContext(
      { selection: { kind: 'ticket', refs: ['OPS-1', 'OPS-403', 'OPS-404', 'OPS-9'] } },
      principal,
      readers,
    );
    expect(result.selection.map((ref) => ref.label)).toEqual(['OPS-1']);
    // Same shape for each: kind and the ref the person sent, no reason.
    expect(result.dropped).toEqual([
      { kind: 'ticket', ref: 'OPS-403' },
      { kind: 'ticket', ref: 'OPS-404' },
      { kind: 'ticket', ref: 'OPS-9' },
    ]);
    expect(result.chips.filter((chip) => chip.status === 'dropped')).toEqual([
      { kind: 'ticket', status: 'dropped' },
      { kind: 'ticket', status: 'dropped' },
      { kind: 'ticket', status: 'dropped' },
    ]);
  });

  it('does not hide a real failure behind a drop', async () => {
    const broken: KindReaders = { ticket: () => Promise.reject(new Error('database is down')) };
    await expect(
      resolveContext({ entity: { kind: 'ticket', ref: 'OPS-1' } }, principal, broken),
    ).rejects.toThrow('database is down');
  });

  it('drops every kind that has no reader yet (the seam) the same way', async () => {
    for (const kind of KINDS_WITHOUT_READER) {
      const result = await resolveContext({ entity: { kind, ref: 'abc' } }, principal, readers);
      expect(result.entity, kind).toBeNull();
      expect(result.dropped, kind).toEqual([{ kind, ref: 'abc' }]);
    }
  });

  it('reads a ref named twice once and keeps one chip per thing in the selection', async () => {
    let reads = 0;
    const counting: KindReaders = {
      incident: (ref, who) => {
        reads += 1;
        return found(ref, who);
      },
    };
    const result = await resolveContext(
      { entity: { kind: 'incident', ref: ID }, selection: { kind: 'incident', refs: [ID, ID] } },
      principal,
      counting,
    );
    expect(reads).toBe(1);
    expect(result.entity?.id).toBe(ID);
    expect(result.selection).toHaveLength(1);
    expect(result.refs).toHaveLength(1);
  });

  it('is empty for no context', async () => {
    expect(await resolveContext(undefined, principal, readers)).toEqual({
      entity: null,
      selection: [],
      refs: [],
      dropped: [],
      chips: [],
    });
  });
});

describe('the tools do not hold a database handle of their own (T-400 C-2)', () => {
  it('has no file under assistant/tools that imports the DATABASE token or createDatabase', () => {
    const dir = join(import.meta.dirname, 'tools');
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    } catch {
      // The directory comes with the first module tools (T-402).
    }
    for (const name of files) {
      const text = readFileSync(join(dir, name), 'utf8');
      expect(text, name).not.toMatch(/database\.module|createDatabase|\bDATABASE\b/);
    }
  });
});
