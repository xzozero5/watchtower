import { describe, expect, it } from 'vitest';

import { deployEventSchema, safeDeployUrl } from './incidents.js';

const event = (url: string | null) => ({
  id: 'run-1',
  service: 'api',
  version: '1.2.3',
  env: 'prod',
  url,
});

describe('deploy feed URL (T-207a C-6)', () => {
  it('refuses a link with a user name or a password', () => {
    for (const url of [
      'https://user:token@ci.example.test/runs/1',
      'https://token@ci.example.test/runs/1',
      'http://:secret@ci.example.test/runs/1',
    ]) {
      expect(deployEventSchema.safeParse(event(url)).success, url).toBe(false);
    }
  });

  it('cuts the query and the fragment, where a CI link keeps its token', () => {
    const parsed = deployEventSchema.parse(
      event('https://ci.example.test/runs/1?token=abc&x=1#secret'),
    );
    expect(parsed.url).toBe('https://ci.example.test/runs/1');
  });

  it('keeps a plain link and a missing one as they are', () => {
    expect(deployEventSchema.parse(event('https://ci.example.test/runs/1')).url).toBe(
      'https://ci.example.test/runs/1',
    );
    expect(deployEventSchema.parse(event(null)).url).toBeNull();
  });

  it('cleans a row saved before the check, and hides one with userinfo', () => {
    expect(safeDeployUrl('https://ci.example.test/a?k=v#f')).toBe('https://ci.example.test/a');
    expect(safeDeployUrl('https://u:p@ci.example.test/a')).toBeNull();
    expect(safeDeployUrl('ftp://ci.example.test/a')).toBeNull();
    expect(safeDeployUrl('not a url')).toBeNull();
    expect(safeDeployUrl(null)).toBeNull();
  });
});
