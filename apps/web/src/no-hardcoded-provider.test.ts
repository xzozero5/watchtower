import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { en } from '@/i18n/messages/en';
import { th } from '@/i18n/messages/th';

const root = join(import.meta.dirname);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe('single sign-on provider', () => {
  it('is named only in the provider configuration (lib/auth/providers.ts)', () => {
    const offenders = sourceFiles(root)
      .filter((file) => !file.endsWith(join('lib', 'auth', 'providers.ts')))
      .filter((file) => !file.includes(join('src', 'test') + '/'))
      .filter((file) => /google/i.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });

  it('is not written into the translated copy either: the name is a {provider} placeholder', () => {
    expect(JSON.stringify(en)).not.toMatch(/google/i);
    expect(JSON.stringify(th)).not.toMatch(/google/i);
    expect(en.login.sso.button).toContain('{provider}');
    expect(th.login.sso.button).toContain('{provider}');
  });
});
