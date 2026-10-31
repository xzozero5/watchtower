import { randomBytes } from 'node:crypto';

import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { relayOutbox, type RelayResult } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import {
  CSRF_HEADER,
  QUEUE_NAMES,
  emailJobSchema,
  parseRedisUrl,
  sealedEnvelopeSchema,
  type EmailJob,
  type SessionInfo,
} from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey, openFields, outboxAad } from '@watchtower/shared/secret-box';
import { Queue, type Job } from 'bullmq';
import type { Pool } from 'pg';

import { AppModule, type AppOptions } from '../app.module.js';
import { configureApp } from '../bootstrap.js';
import type { ApiConfig } from '../config/config.js';
import { createLogger } from '../logging/logger.js';
import { listenOnFreePort, testConfig, type captureLogs } from './support.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

export interface Harness {
  readonly app: NestExpressApplication;
  readonly base: string;
  readonly config: ApiConfig;
  readonly db: TestDatabase;
  readonly queuePrefix: string;
  /** The email queue, read through its own connection, to see what the api enqueued. */
  readonly emailQueue: Queue;
  /**
   * Runs one pass of the outbox relay, which in production lives in apps/worker: pending rows the
   * api wrote become jobs in `emailQueue`. The api never talks to BullMQ itself (ADR-006).
   */
  relayOutbox(): Promise<RelayResult>;
  /**
   * What the worker does to an email job before SMTP: opens the sealed link and validates the
   * whole message. Jobs in `emailQueue` hold ciphertext only (ADR-006), so tests read links here.
   */
  openEmail(job: Job): EmailJob;
  /** A fresh browser-like client with its own cookie jar and its own source IP. */
  client(): TestClient;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Environment overrides on top of the test defaults. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Extra controllers (test-only routes) added to the real application module. */
  readonly controllers?: readonly Type[];
  readonly oidc?: AppOptions['oidc'];
  /** Collect the application log (pino) here to assert on what was, and was not, logged. */
  readonly logs?: ReturnType<typeof captureLogs>;
  /** Replaces providers of the real module (for example the client organization resolver). */
  readonly overrides?: readonly { readonly token: symbol; readonly value: unknown }[];
}

/**
 * The real AppModule on Postgres (a throwaway database, migrated, reached through the restricted
 * application role), Redis and BullMQ from docker compose. Nothing is mocked.
 */
export async function startHarness(options: StartOptions = {}): Promise<Harness> {
  const db = await createTestDatabase(ADMIN_URL);
  const queuePrefix = `wt-test-${randomBytes(4).toString('hex')}`;
  const config = testConfig({
    DATABASE_URL: db.appUrl,
    // One proxy hop: tests choose the client IP with x-forwarded-for.
    TRUST_PROXY_HOPS: '1',
    LOG_LEVEL: 'silent',
    ...options.env,
  });
  const logger = createLogger(config, options.logs?.destination);
  let builder = Test.createTestingModule({
    imports: [
      AppModule.forRoot(config, logger, {
        queuePrefix,
        ...(options.oidc === undefined ? {} : { oidc: options.oidc }),
      }),
    ],
    controllers: [...(options.controllers ?? [])],
  });
  for (const override of options.overrides ?? []) {
    builder = builder.overrideProvider(override.token).useValue(override.value);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app, config, logger);
  const base = await listenOnFreePort(app);
  const emailQueue = new Queue(QUEUE_NAMES.email, {
    connection: parseRedisUrl(config.REDIS_URL),
    prefix: queuePrefix,
  });

  return {
    app,
    base,
    config,
    db,
    queuePrefix,
    emailQueue,
    relayOutbox: () =>
      relayOutbox(db.owner, async (row) => {
        if (row.queue !== QUEUE_NAMES.email)
          throw new Error(`harness relays only the email queue, not ${row.queue}`);
        // Like the real relay: the row's expiry travels with the job as `notAfter`.
        const data =
          row.expiresAt === null
            ? row.payload
            : { ...row.payload, notAfter: row.expiresAt.getTime() };
        await emailQueue.add(row.jobName, data, { ...row.options, jobId: row.jobId });
      }),
    openEmail: (job) => {
      const { secret, ...clearAndExpiry } = sealedEnvelopeSchema.parse(job.data);
      const clear = Object.fromEntries(
        Object.entries(clearAndExpiry).filter(([name]) => name !== 'notAfter'),
      );
      const key = deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret);
      const links = openFields(key, secret, outboxAad(job.queueName, job.id ?? ''));
      return emailJobSchema.parse({ ...clear, ...links });
    },
    client: () => new TestClient(base, config),
    async close() {
      await app.close();
      await emailQueue.obliterate({ force: true });
      await emailQueue.close();
      await db.cleanup();
    },
  };
}

export interface RequestOptions {
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Send the session's CSRF token on unsafe methods (default true when this client has one). */
  readonly csrf?: boolean | string;
  /** Send an Origin header like a browser would. Default: the web app. `null` sends none. */
  readonly origin?: string | null;
  readonly redirect?: 'follow' | 'manual';
}

export interface TestResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
  readonly setCookies: readonly string[];
}

/** A tiny browser: cookie jar, CSRF token, Origin header, and a stable source IP. */
export class TestClient {
  readonly cookies = new Map<string, string>();
  csrfToken: string | undefined;
  readonly ip = `10.${String(randomInt(250))}.${String(randomInt(250))}.${String(randomInt(250) + 1)}`;

  constructor(
    private readonly base: string,
    private readonly config: ApiConfig,
  ) {}

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<TestResponse<T>> {
    const headers: Record<string, string> = {
      'x-forwarded-for': this.ip,
      'user-agent': 'watchtower-test-client',
      ...options.headers,
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const origin =
      options.origin === undefined ? new URL(this.config.APP_URL).origin : options.origin;
    if (origin !== null) headers.origin = origin;
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    const csrf = options.csrf ?? true;
    if (!SAFE.has(method)) {
      if (typeof csrf === 'string') headers[CSRF_HEADER] = csrf;
      else if (csrf && this.csrfToken) headers[CSRF_HEADER] = this.csrfToken;
    }

    const response = await fetch(`${this.base}${path}`, {
      method,
      headers,
      redirect: options.redirect ?? 'manual',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const setCookies = response.headers.getSetCookie();
    this.absorb(setCookies);
    const text = await response.text();
    let body: unknown = text;
    if (text !== '' && (response.headers.get('content-type') ?? '').includes('json')) {
      body = JSON.parse(text) as unknown;
    }
    return { status: response.status, body: body as T, headers: response.headers, setCookies };
  }

  get<T = unknown>(path: string, options?: RequestOptions) {
    return this.request<T>('GET', path, options);
  }
  post<T = unknown>(path: string, body?: unknown, options: RequestOptions = {}) {
    return this.request<T>('POST', path, { ...options, ...(body === undefined ? {} : { body }) });
  }
  patch<T = unknown>(path: string, body?: unknown, options: RequestOptions = {}) {
    return this.request<T>('PATCH', path, { ...options, ...(body === undefined ? {} : { body }) });
  }
  put<T = unknown>(path: string, body?: unknown, options: RequestOptions = {}) {
    return this.request<T>('PUT', path, { ...options, ...(body === undefined ? {} : { body }) });
  }
  delete<T = unknown>(path: string, options?: RequestOptions) {
    return this.request<T>('DELETE', path, options);
  }

  /** Signs in through the mock-mode dev login and remembers the CSRF token. */
  async devLogin(
    email: string,
    role: 'agent' | 'lead' | 'head' | 'client' = 'agent',
    extra: { orgId?: string; name?: string } = {},
  ): Promise<SessionInfo> {
    const response = await this.post<SessionInfo>('/v1/auth/dev-login', {
      email,
      role,
      ...extra,
    });
    if (response.status !== 200) {
      throw new Error(
        `dev login failed: ${String(response.status)} ${JSON.stringify(response.body)}`,
      );
    }
    this.csrfToken = response.body.csrfToken;
    return response.body;
  }

  /** Applies Set-Cookie headers to the jar: a cleared or expired cookie leaves it. */
  private absorb(setCookies: readonly string[]): void {
    for (const raw of setCookies) {
      const [pair = '', ...attributes] = raw.split(';').map((part) => part.trim());
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      const maxAge = attributes.find((attribute) => attribute.toLowerCase().startsWith('max-age='));
      const expires = attributes.find((attribute) =>
        attribute.toLowerCase().startsWith('expires='),
      );
      const expired =
        value === '' ||
        (maxAge !== undefined && Number(maxAge.split('=')[1]) <= 0) ||
        (expires !== undefined && Date.parse(expires.slice('expires='.length)) < Date.now());
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

function randomInt(max: number): number {
  return randomBytes(2).readUInt16BE() % max;
}

/** `email-<random>@example.com`, unique per call, so tests never collide on the unique email. */
export function uniqueEmail(prefix: string, domain = 'example.com'): string {
  return `${prefix}-${randomBytes(4).toString('hex')}@${domain}`;
}

/** Inserts an organization (as the schema owner) and returns its id. A client user needs one. */
export async function createOrg(
  pool: Pool,
  name = `Org ${randomBytes(3).toString('hex')}`,
  domains: readonly string[] = [],
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    'INSERT INTO organization (name, domains) VALUES ($1, $2) RETURNING id',
    [name, [...domains]],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('organization insert returned no row');
  return id;
}
