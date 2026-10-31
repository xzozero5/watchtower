import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

import { boundaryConfigs, WORKSPACES } from './boundaries.mjs';

const repoRoot = join(import.meta.dirname, '..', '..');

const BOUNDARY_RULES = new Set([
  '@typescript-eslint/no-restricted-imports',
  'no-restricted-syntax',
  'no-restricted-globals',
  'watchtower/no-relative-escape',
]);

// Linted as virtual paths: the rules look only at the specifier and the file's location, so the
// apps need not exist yet (T-002, T-003).
const virtualEslint = new ESLint({
  cwd: repoRoot,
  ignore: false,
  overrideConfigFile: true,
  overrideConfig: [
    { files: ['**/*.{ts,tsx}'], languageOptions: { parser: tseslint.parser } },
    ...boundaryConfigs({ rootDir: repoRoot }),
  ],
});

async function boundaryViolations(eslint, filePath, code) {
  const [result] = await eslint.lintText(code, { filePath });
  const fatal = result.messages.filter((message) => message.fatal);
  expect(fatal, 'the snippet must parse').toEqual([]);
  return result.messages.filter((message) => BOUNDARY_RULES.has(message.ruleId));
}

const lintAt = (code, file) => boundaryViolations(virtualEslint, join(repoRoot, file), code);

const VIOLATIONS = [
  // apps/* must not import each other
  ['apps/web/src/a.ts', "import x from '@watchtower/api';"],
  ['apps/web/src/a.ts', "import x from '@watchtower/worker/jobs';"],
  ['apps/api/src/a.ts', "import x from '@watchtower/web';"],
  ['apps/api/src/a.ts', "import x from '@watchtower/worker';"],
  ['apps/worker/src/a.ts', "import x from '@watchtower/api';"],
  ['apps/web/src/a.ts', "import x from '../../api/src/index.js';"],
  ['apps/web/src/lib/a.ts', "import x from '../../../worker/src/index.js';"],
  ['apps/api/src/a.ts', "export * from '../../web/src/index.js';"],
  ['apps/worker/src/a.ts', "import type { X } from '../../api/src/index.js';"],
  ['apps/worker/src/a.ts', "const x = await import('../../api/src/index.js');"],
  // apps/web talks to the API, not to server-side packages
  ['apps/web/src/a.ts', "import x from '@watchtower/db';"],
  ['apps/web/src/a.ts', "import x from '@watchtower/ai';"],
  ['apps/web/src/a.ts', "import x from 'drizzle-orm';"],
  // packages/ai must not know HTTP
  ['packages/ai/src/a.ts', "import x from '@nestjs/common';"],
  ['packages/ai/src/a.ts', "import x from 'express';"],
  ['packages/ai/src/a.ts', "import x from 'node:http';"],
  ['packages/ai/src/a.ts', "import x from 'https';"],
  ['packages/ai/src/a.ts', "import x from 'axios';"],
  ['packages/ai/src/a.ts', "import { Agent } from 'undici';"],
  ['packages/ai/src/a.ts', "const r = await fetch('https://example.com');"],
  ['packages/ai/src/a.ts', "const x = await import('node:http');"],
  // packages/ai must not know the DB
  ['packages/ai/src/a.ts', "import x from '@watchtower/db';"],
  ['packages/ai/src/a.ts', "import { eq } from 'drizzle-orm';"],
  ['packages/ai/src/a.ts', "import { pgTable } from 'drizzle-orm/pg-core';"],
  ['packages/ai/src/a.ts', "import pg from 'pg';"],
  ['packages/ai/src/a.ts', "import x = require('pg');"],
  ['packages/ai/src/a.ts', "const pg = require('pg');"],
  ['packages/ai/src/a.ts', "type C = import('pg').Client;"],
  ['packages/ai/src/a.ts', "import x from '../../db/src/index.js';"],
  // packages/ai and packages/channels stay independent of each other
  ['packages/ai/src/a.ts', "import x from '@watchtower/channels';"],
  ['packages/channels/src/a.ts', "import x from '@watchtower/ai';"],
  // packages/channels must not know the DB
  ['packages/channels/src/a.ts', "import x from '@watchtower/db';"],
  ['packages/channels/src/a.ts', "import { eq } from 'drizzle-orm';"],
  ['packages/channels/src/a.ts', "import x from 'postgres';"],
  ['packages/channels/src/a.ts', "import x from 'pg-boss';"],
  ['packages/channels/src/a.ts', "import x from '../../db/src/index.js';"],
  ['packages/channels/src/gmail/a.ts', "import x from '../../../db/src/schema.js';"],
  // packages must not import from apps
  ['packages/shared/src/a.ts', "import x from '@watchtower/api';"],
  ['packages/db/src/a.ts', "import x from '@watchtower/worker';"],
  ['packages/ai/src/a.ts', "import x from '@watchtower/api';"],
  ['packages/channels/src/a.ts', "import x from '@watchtower/web';"],
  ['packages/ui/src/a.ts', "import x from '@watchtower/web';"],
  ['packages/ui/src/a.ts', "import x from '../../../apps/web/src/index.js';"],
  ['packages/db/src/a.ts', "import x from '../../../apps/api/src/index.js';"],
  ['packages/ai/src/a.ts', "export { x } from '../../../apps/worker/src/index.js';"],
  // reaching into an allowed package by path skips its public entry point
  ['packages/db/src/a.ts', "import x from '../../shared/src/index.js';"],
  // absolute paths and paths to files that do not exist are still caught
  ['packages/ai/src/a.ts', "import x from '../../does-not-exist/src/index.js';"],
  ['packages/ai/src/a.ts', "import x from '/repo/packages/db/src/index.js';"],
  // RedactedText is created by the redactor only (N4, R-6)
  ['packages/ai/src/a.ts', 'const x = raw as RedactedText;'],
  ['packages/ai/src/a.ts', 'const x = raw as unknown as RedactedText;'],
  ['packages/ai/src/a.ts', 'const x = <RedactedText>raw;'],
  ['packages/ai/src/a.ts', 'const x = list as RedactedText[];'],
  ['apps/api/src/a.ts', 'const x = text as RedactedText;'],
  ['apps/worker/src/a.ts', 'const x = text as unknown as RedactedText[];'],
  // packages/shared is a leaf
  ['packages/shared/src/a.ts', "import x from '@watchtower/db';"],
  ['packages/shared/src/a.ts', "import x from 'node:https';"],
  // packages/domain (ADR-009) is writes only: no AI, channels, HTTP, Redis or BullMQ
  ['packages/domain/src/a.ts', "import x from '@watchtower/ai';"],
  ['packages/domain/src/a.ts', "import x from '@watchtower/channels';"],
  ['packages/domain/src/a.ts', "import x from '@watchtower/api';"],
  ['packages/domain/src/a.ts', "import x from '@watchtower/worker';"],
  ['packages/domain/src/a.ts', "import x from '@watchtower/web';"],
  ['packages/domain/src/a.ts', "import { Queue } from 'bullmq';"],
  ['packages/domain/src/a.ts', "import x from 'ioredis';"],
  ['packages/domain/src/a.ts', "import x from 'redis';"],
  ['packages/domain/src/a.ts', "import { Injectable } from '@nestjs/common';"],
  ['packages/domain/src/a.ts', "import x from 'express';"],
  ['packages/domain/src/a.ts', "import x from 'node:http';"],
  ['packages/domain/src/a.ts', "import WebSocket from 'ws';"],
  ['packages/domain/src/a.ts', "const r = await fetch('https://example.com');"],
  ['packages/domain/src/a.ts', "const x = await import('bullmq');"],
  ['packages/domain/src/a.ts', "const r = new Request('https://example.com');"],
  ['packages/domain/src/a.ts', "import x from '../../db/src/index.js';"],
  // nothing but api and worker may depend on packages/domain
  ['packages/db/src/a.ts', "import x from '@watchtower/domain';"],
  ['packages/shared/src/a.ts', "import x from '@watchtower/domain';"],
  ['packages/ai/src/a.ts', "import x from '@watchtower/domain';"],
  ['packages/channels/src/a.ts', "import x from '@watchtower/domain';"],
  ['packages/ui/src/a.ts', "import x from '@watchtower/domain';"],
  ['apps/web/src/a.ts', "import x from '@watchtower/domain';"],
  ['apps/web/src/a.ts', "import x from '../../../packages/domain/src/index.js';"],
  // the Redis group is its own: bullmq stays out of packages that forbid persistence or Redis
  ['packages/shared/src/a.ts', "import { Queue } from 'bullmq';"],
  ['apps/web/src/a.ts', "import x from 'ioredis';"],
];

const ALLOWED = [
  ['apps/api/src/a.ts', "import { db } from '@watchtower/db';"],
  ['apps/api/src/a.ts', "import { x } from '@watchtower/ai';"],
  ['apps/api/src/a.ts', "import { x } from '@watchtower/channels';"],
  ['apps/api/src/a.ts', "import { Module } from '@nestjs/common';"],
  ['apps/worker/src/a.ts', "import { db } from '@watchtower/db';"],
  ['apps/api/src/a.ts', "import { createDomain } from '@watchtower/domain';"],
  ['apps/worker/src/a.ts', "import { createDomain } from '@watchtower/domain';"],
  ['apps/worker/src/a.ts', "import { Queue } from 'bullmq';"],
  ['packages/domain/src/a.ts', "import { eq } from 'drizzle-orm';"],
  ['packages/domain/src/a.ts', "import { schema } from '@watchtower/db';"],
  ['packages/domain/src/a.ts', "import { x } from '@watchtower/shared';"],
  ['packages/domain/src/a.ts', "import { x } from '@watchtower/shared/secret-box';"],
  ['packages/domain/src/a.ts', "import { randomUUID } from 'node:crypto';"],
  ['packages/domain/src/a.ts', "import { x } from './tickets/create.js';"],
  ['apps/web/src/a.ts', "import { x } from '@watchtower/ui';"],
  ['apps/web/src/a.ts', "import { x } from '@watchtower/shared';"],
  ['apps/web/src/a.ts', "import Link from 'next/link';"],
  ['packages/ai/src/a.ts', "import { x } from '@watchtower/shared';"],
  ['packages/ai/src/a.ts', "import { generateText } from 'ai';"],
  ['packages/channels/src/a.ts', "import { x } from '@watchtower/shared';"],
  ['packages/channels/src/a.ts', "import { Agent } from 'undici';"],
  ['packages/channels/src/a.ts', "const r = await fetch('https://example.com');"],
  ['packages/db/src/a.ts', "import { eq } from 'drizzle-orm';"],
  ['packages/db/src/a.ts', "import { x } from '@watchtower/shared';"],
  // Local modules that merely share a name with a forbidden package.
  ['packages/ai/src/a.ts', "import { x } from './http.js';"],
  ['packages/ai/src/a.ts', "import { x } from './db/pg.js';"],
  ['packages/ai/src/a.ts', "import { x } from '../src/index.js';"],
  ['apps/web/src/a.ts', "import { x } from './api/client.js';"],
  ['apps/web/src/a.ts', "import { x } from '../src/index.js';"],
  // Casts that do not target RedactedText stay legal.
  ['packages/ai/src/a.ts', 'const x = raw as string;'],
  ['apps/api/src/a.ts', 'const x = value as unknown as Record<string, string>;'],
  // Packages whose names only start like a forbidden one.
  ['packages/ai/src/a.ts', "import x from 'expressive';"],
  ['packages/ai/src/a.ts', "import x from 'nextra';"],
  ['packages/ai/src/a.ts', "import x from 'pgp';"],
];

describe('boundary rules', () => {
  it.each(VIOLATIONS)('%s rejects: %s', async (file, code) => {
    expect(await lintAt(code, file)).not.toEqual([]);
  });

  it.each(ALLOWED)('%s accepts: %s', async (file, code) => {
    expect(await lintAt(code, file)).toEqual([]);
  });
});

describe('the real root config', () => {
  // Run from a package directory, which is how turbo runs `eslint .`.
  const real = new ESLint({ cwd: join(repoRoot, 'packages', 'ai') });
  const aiFile = join(repoRoot, 'packages', 'ai', 'src', 'index.ts');
  const channelsFile = join(repoRoot, 'packages', 'channels', 'src', 'index.ts');

  it('applies the HTTP and DB rules to packages/ai', async () => {
    expect(await boundaryViolations(real, aiFile, "import x from 'express';")).not.toEqual([]);
    expect(await boundaryViolations(real, aiFile, "import x from 'pg';")).not.toEqual([]);
  });

  it('forbids casting to RedactedText outside the redactor (N4)', async () => {
    const code =
      "import type { RedactedText } from './x.js';\nexport const x = 'a' as RedactedText;";
    const messages = await boundaryViolations(real, aiFile, code);
    expect(messages.map((message) => message.ruleId)).toContain('no-restricted-syntax');
  });

  it('allows a declared workspace dependency', async () => {
    const code = "import { CHANNEL_TYPES } from '@watchtower/shared';";
    expect(await boundaryViolations(real, channelsFile, code)).toEqual([]);
  });

  it('applies the HTTP, Redis and workspace rules to packages/domain', async () => {
    const domainFile = join(repoRoot, 'packages', 'domain', 'src', 'index.ts');
    const real = new ESLint({ cwd: join(repoRoot, 'packages', 'domain') });
    for (const code of [
      "import { Injectable } from '@nestjs/common';",
      "import { Queue } from 'bullmq';",
      "import x from '@watchtower/ai';",
      "const r = await fetch('https://example.com');",
    ]) {
      expect(await boundaryViolations(real, domainFile, code), code).not.toEqual([]);
    }
    for (const code of [
      "import { eq } from 'drizzle-orm';",
      "import { schema } from '@watchtower/db';",
      "import { TICKET_STATUSES } from '@watchtower/shared';",
    ]) {
      expect(await boundaryViolations(real, domainFile, code), code).toEqual([]);
    }
  });

  it('applies the DB rule to packages/channels', async () => {
    expect(
      await boundaryViolations(real, channelsFile, "import x from '@watchtower/db';"),
    ).not.toEqual([]);
  });

  it('catches a relative import that crosses workspaces, using the repo root as base', async () => {
    const code = "import { x } from '../../db/src/index.js';";
    const messages = await boundaryViolations(real, aiFile, code);
    expect(messages.map((message) => message.ruleId)).toContain('watchtower/no-relative-escape');
  });
});

describe('the workspace table', () => {
  const dirsIn = (parent) => {
    const path = join(repoRoot, parent);
    if (!existsSync(path)) return [];
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(join(path, entry.name, 'package.json')))
      .map((entry) => `${parent}/${entry.name}`);
  };
  const actual = [...dirsIn('apps'), ...dirsIn('packages')];
  const readManifest = (dir) =>
    JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'));

  it('lists every workspace on disk, so a new one cannot skip the rules', () => {
    expect(Object.keys(WORKSPACES)).toEqual(expect.arrayContaining(actual));
  });

  it.each(actual)('%s has the name the table expects', (dir) => {
    expect(readManifest(dir).name).toBe(WORKSPACES[dir].name);
  });

  it.each(actual)('%s declares only workspace dependencies the table allows', (dir) => {
    const manifest = readManifest(dir);
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(
      (name) => name.startsWith('@watchtower/'),
    );
    expect(WORKSPACES[dir].allow).toEqual(expect.arrayContaining(declared));
  });
});
