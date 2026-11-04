import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Helpers of the Stage 3 e2e (T-306b). Everything here talks to the throwaway stack of the run only: the
 * database of `up.mjs` (a superuser connection to that one database, to set up what no api route can: a
 * stage 3 intent while the flag is off, a published procedure, a head who also holds `ai.autonomy.owner_approve`)
 * and the JSON file the worker's fake AI provider reads (models and grader answer).
 */

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: the stack was not started by global-setup.ts`);
  return value;
}

type Role = 'app' | 'admin';

/** The connection string of the throwaway database: the app role's, or a superuser's on the same database. */
function connection(role: Role): string {
  const app = new URL(need('E2E_DATABASE_URL'));
  if (role === 'app') return app.toString();
  const admin = new URL(
    process.env.E2E_ADMIN_DATABASE_URL ??
      process.env.TEST_DATABASE_URL ??
      'postgres://watchtower:watchtower@localhost:5432/watchtower',
  );
  admin.pathname = app.pathname;
  return admin.toString();
}

const RUNNER = `
const { createRequire } = require('node:module');
const req = createRequire(process.env.PG_FROM);
const { Client } = req('pg');
(async () => {
  const client = new Client({ connectionString: process.env.DB_URL });
  await client.connect();
  try {
    const statements = JSON.parse(process.env.STATEMENTS);
    const out = [];
    for (const [text, values] of statements) {
      const r = await client.query(text, values);
      out.push(r.rows);
    }
    process.stdout.write(JSON.stringify(out));
  } finally {
    await client.end();
  }
})().catch((e) => { process.stderr.write(String(e && e.message ? e.message : e)); process.exit(1); });`;

/** Runs statements in order on one connection; returns the rows of each. A failure throws with the database's message. */
export function sqlMany(
  role: Role,
  statements: [string, unknown[]?][],
): Record<string, unknown>[][] {
  const result = spawnSync(process.execPath, ['-e', RUNNER], {
    env: {
      NODE_ENV: 'test',
      PATH: process.env.PATH ?? '',
      DB_URL: connection(role),
      PG_FROM: join(need('E2E_API_DIST'), '..', 'package.json'),
      STATEMENTS: JSON.stringify(statements.map(([text, values]) => [text, values ?? []])),
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`sql failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>[][];
}

export function sql<T = Record<string, unknown>>(
  role: Role,
  text: string,
  values: unknown[] = [],
): T[] {
  return (sqlMany(role, [[text, values]])[0] ?? []) as T[];
}

// ---------------------------------------------------------------- the fake AI provider's knobs

export interface AiKnobs {
  drafterModel: string;
  graderModel: string;
  score: number;
  violations: unknown[];
}

export const DEFAULT_KNOBS: AiKnobs = {
  drafterModel: 'drafter-fixture',
  graderModel: 'grader-fixture',
  score: 0.95,
  violations: [],
};

/** Changes what the worker's fake provider answers from now on (the file is read on every call). */
export function setAiKnobs(over: Partial<AiKnobs> = {}): void {
  writeFileSync(need('E2E_AI_FAKE_LIVE_FILE'), JSON.stringify({ ...DEFAULT_KNOBS, ...over }));
}

export function aiKnobs(): AiKnobs {
  return JSON.parse(readFileSync(need('E2E_AI_FAKE_LIVE_FILE'), 'utf8')) as AiKnobs;
}

/** `on` when the stack was started with `E2E_AUTOSEND_FLAG=on` (the flag is `AI_AUTOSEND_ENABLED` of that stack only). */
export const flagOn = (): boolean => process.env.E2E_AUTOSEND_FLAG === 'on';

export async function until<T>(
  what: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 60_000,
  stepMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

// ---------------------------------------------------------------- inbound mail with an authenticated sender

/**
 * Like `fakeGmail` of support.ts, but the mail carries an `Authentication-Results` header (what Gmail adds after
 * checking SPF/DKIM/DMARC), so the ticket's `senderAuth` is `pass` or `fail`. `fakeGmail` has no header option and a
 * mail without one is `none`, which the gate treats as unauthenticated (ADR-025 condition 8).
 */
export function fakeGmailAuthenticated(input: {
  from: string;
  subject: string;
  body: string;
  threadId: string;
  messageId: string;
  inReplyTo?: string;
  auth?: 'pass' | 'none';
}): void {
  const domain = input.from.split('@')[1] ?? '';
  const headers =
    input.auth === 'none'
      ? {}
      : {
          'Authentication-Results': `mx.example.test; dkim=pass header.d=${domain} header.i=@${domain}`,
        };
  const script = `
    import { pathToFileURL } from 'node:url';
    const { createDatabase } = await import('@watchtower/db');
    const { enqueueFakeInbound } = await import(pathToFileURL(process.env.API_DIST + '/inbound/fake-channel.js').href);
    const database = createDatabase({ url: process.env.DATABASE_URL, max: 1, applicationName: 'e2e-stage3-inbound' });
    try {
      await enqueueFakeInbound(database, JSON.parse(process.env.FAKE));
    } finally {
      await database.close();
    }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    // Resolved from apps/api so `@watchtower/db` is found the way the api finds it.
    cwd: join(need('E2E_API_DIST'), '..'),
    env: {
      NODE_ENV: 'test',
      PATH: process.env.PATH ?? '',
      DATABASE_URL: need('E2E_DATABASE_URL'),
      API_DIST: need('E2E_API_DIST'),
      FAKE: JSON.stringify({
        channel: 'gmail',
        from: input.from,
        subject: input.subject,
        body: input.body,
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
        headers,
      }),
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`authenticated fake inbound failed: ${result.stderr}`);
}
