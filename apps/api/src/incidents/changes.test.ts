import { describe, expect, it } from 'vitest';

import { FakeRepoChanges, NO_REPO_CHANGES } from './changes.js';

// N2: what the incident view needs of a repository is reading. The port has one method, it lists, and
// neither the stand-in for "no repository" nor the fake changes anything when asked.
const WRITE_VERBS = /^(create|update|delete|write|post|put|patch|send|insert|merge|push|close)/i;

describe('the repository port is read-only (N2)', () => {
  it('has no method that writes, and the default says no repository is connected', async () => {
    const methods = Object.entries(NO_REPO_CHANGES)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);
    expect(methods).toEqual(['listChanges']);
    expect(methods.some((name) => WRITE_VERBS.test(name))).toBe(false);
    expect(NO_REPO_CHANGES.source).toBe('none');
    expect(
      await NO_REPO_CHANGES.listChanges({
        repo: 'a/b',
        since: new Date(0),
        until: new Date(),
        limit: 5,
      }),
    ).toEqual([]);
  });

  it('the fake answers only what was put in it, inside the window, newest first, up to the limit, and never claims to be live', async () => {
    const fake = new FakeRepoChanges();
    const change = (ref: string, at: string) => ({
      repo: 'a/b',
      kind: 'commit' as const,
      ref,
      title: null,
      author: null,
      at,
      url: null,
    });
    fake.add(change('old', '2026-11-02T01:00:00.000Z'));
    fake.add(change('first', '2026-11-02T02:00:00.000Z'));
    fake.add(change('second', '2026-11-02T02:30:00.000Z'));
    fake.add(change('late', '2026-11-02T05:00:00.000Z'));
    const window = {
      repo: 'a/b',
      since: new Date('2026-11-02T01:30:00Z'),
      until: new Date('2026-11-02T03:00:00Z'),
    };
    expect((await fake.listChanges({ ...window, limit: 10 })).map((entry) => entry.ref)).toEqual([
      'second',
      'first',
    ]);
    expect((await fake.listChanges({ ...window, limit: 1 })).map((entry) => entry.ref)).toEqual([
      'second',
    ]);
    expect(await fake.listChanges({ ...window, repo: 'a/other', limit: 10 })).toEqual([]);
    expect(fake.source).toBe('fake');
    fake.failNext(new Error('down'));
    await expect(fake.listChanges({ ...window, limit: 1 })).rejects.toThrow('down');
    // One failure, then normal again.
    expect(await fake.listChanges({ ...window, limit: 10 })).toHaveLength(2);
  });
});
