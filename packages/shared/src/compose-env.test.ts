import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { baseEnvShape, phase1EnvShape } from './config.js';
import { INTEGRATION_CATALOG } from './features/credentials.js';

// docker-compose.yml lists the environment of the api and worker containers one by one. A variable
// the code reads but compose does not list never reaches the process, so a deployment that did
// everything .env.example says silently keeps the default (security review F-1; T-130 found
// several). This test walks what the code reads and fails on the first one that is missing.

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const compose = read('../../../docker-compose.yml');
const proxyCompose = read('../../../docker-compose.proxy.yml');
const envExample = read('../../../.env.example');

/** Keys `createEnvSchema({ ... })` adds to the shared shapes in an app's config file. */
function appSchemaKeys(source: string): string[] {
  const start = source.indexOf('createEnvSchema({');
  expect(start, 'createEnvSchema({ not found').toBeGreaterThan(-1);
  const end = source.indexOf('\n});', start);
  return [...source.slice(start, end).matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map(
    (match) => match[1] ?? '',
  );
}

const catalogEnv = Object.values(INTEGRATION_CATALOG).flatMap((integration) =>
  Object.values(integration.fields).map((field) => field.env),
);

/** Every variable the api or worker reads from its environment, or the credential store falls back to. */
const readByCode = [
  ...new Set([
    ...Object.keys(baseEnvShape),
    ...Object.keys(phase1EnvShape),
    ...appSchemaKeys(read('../../../apps/api/src/config/config.ts')),
    ...appSchemaKeys(read('../../../apps/worker/src/config.ts')),
    ...catalogEnv,
  ]),
].sort();

/** The `x-app-env` block: the variables both containers get. */
function appEnvKeys(): Set<string> {
  const start = compose.indexOf('x-app-env: &app-env');
  const end = compose.indexOf('\nx-', start + 1);
  expect(start).toBeGreaterThan(-1);
  return new Set(
    [...compose.slice(start, end).matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map(
      (match) => match[1] ?? '',
    ),
  );
}

/**
 * Read by the code but deliberately not in `x-app-env`: each is set per service (`HOST`, the two
 * ports) or given by the platform (`PORT` on Cloud Run) or named per service by the code
 * (`OTEL_SERVICE_NAME` defaults to watchtower-api / watchtower-worker; one value for both would be wrong).
 */
const SET_PER_SERVICE_OR_BY_PLATFORM = new Set([
  'HOST',
  'API_PORT',
  'WORKER_PORT',
  'PORT',
  'OTEL_SERVICE_NAME',
]);

/** Read by the code but not documented in .env.example because the platform or the service sets it. */
const NOT_DOCUMENTED = new Set(['HOST', 'PORT', 'OTEL_SERVICE_NAME']);

/**
 * In .env.example for something other than the api and worker config: `pnpm db:migrate`
 * (MIGRATION_DATABASE_URL). Variables compose substitutes (ports, POSTGRES_*, APP_DB_*, images,
 * the relay) are found by looking for `${NAME` in the compose files and need no entry here.
 */
const READ_BY_TOOLING = new Set(['MIGRATION_DATABASE_URL']);

describe('variables the code reads reach the containers', () => {
  const passed = appEnvKeys();

  it('finds a plausible number of variables (the walk itself works)', () => {
    expect(readByCode.length).toBeGreaterThan(60);
    expect(passed.size).toBeGreaterThan(60);
    expect(readByCode).toEqual(expect.arrayContaining(['SMTP_PASSWORD', 'AI_DAILY_COST_CAP_USD']));
  });

  it.each(readByCode.filter((name) => !SET_PER_SERVICE_OR_BY_PLATFORM.has(name)))(
    '%s is listed in x-app-env of docker-compose.yml',
    (name) => {
      expect(passed.has(name), `${name} is read by the code but missing from x-app-env`).toBe(true);
    },
  );

  it.each(readByCode.filter((name) => !NOT_DOCUMENTED.has(name)))(
    '%s is documented in .env.example',
    (name) => {
      expect(envExample).toMatch(new RegExp(`^#? ?${name}=`, 'm'));
    },
  );

  it('keeps the allow-lists honest: every entry is something the code really reads', () => {
    for (const name of [...SET_PER_SERVICE_OR_BY_PLATFORM, ...NOT_DOCUMENTED]) {
      expect(readByCode, `${name} is allow-listed but not read by the code`).toContain(name);
    }
  });
});

describe('.env.example holds nothing that nothing reads', () => {
  const documented = [...envExample.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map(
    (match) => match[1] ?? '',
  );

  it('documents a plausible number of variables', () => {
    expect(documented.length).toBeGreaterThan(80);
  });

  it.each([...new Set(documented)])('%s is read by the code, compose or a tool', (name) => {
    const usedByCompose = [compose, proxyCompose].some((file) => file.includes('${' + name));
    expect(
      readByCode.includes(name) || usedByCompose || READ_BY_TOOLING.has(name),
      `${name} is in .env.example but no config schema, compose file or tool reads it`,
    ).toBe(true);
  });
});

describe('Gmail service account file', () => {
  it('is mounted read-only into the api and worker and points at nothing when unset', () => {
    expect(compose).toMatch(
      /GMAIL_SERVICE_ACCOUNT_JSON_PATH: \$\{GMAIL_SERVICE_ACCOUNT_JSON_PATH:\+\/run\/secrets\//,
    );
    expect(compose).toMatch(/x-gmail-key: &gmail-key\n(?: {2}.+\n)*? {2}read_only: true/);
    expect(compose.match(/- \*gmail-key/g)).toHaveLength(2);
    expect(compose).toContain('${GMAIL_SERVICE_ACCOUNT_JSON_PATH:-./config/no-credential}');
  });
});
