import { z } from 'zod';

/**
 * Environment contract shared by apps/api and apps/worker (docs/04-ARCHITECTURE.md section 5).
 * `.env.example` is the only list of variables. This module is pure: it validates a plain object
 * and never reads `process.env`, so each app passes its environment in at boot.
 */

/** The marker used by `.env.example` for values that must be replaced before production. */
export const PLACEHOLDER_MARKER = 'change-me';

/** An empty value in an env file means "not set", which is how integrations stay in mock mode. */
export const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.url().optional());
const optionalPositiveNumber = z.preprocess(
  emptyToUndefined,
  z.coerce.number().positive().optional(),
);

/** `a.example.com, b.example.com` as a list of lower-case host names; empty means none. */
const hostList = z.preprocess(
  (value: unknown): unknown => {
    if (value === undefined) return [];
    if (typeof value !== 'string') return value;
    return value
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host !== '');
  },
  z.array(z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, 'must be a host name')).max(100),
);

export const portSchema = z.coerce.number().int().min(1).max(65535);

const postgresUrl = z
  .url()
  .refine(
    (value) => /^postgres(?:ql)?:\/\//.test(value),
    'must start with postgres:// or postgresql://',
  );
const redisUrl = z
  .url()
  .refine((value) => /^rediss?:\/\//.test(value), 'must start with redis:// or rediss://');

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const AI_PROVIDERS = ['mock', 'anthropic', 'vertex'] as const;
/**
 * Where knowledge base embeddings come from. `[ASSUMED]` mock (deterministic, offline) or Vertex;
 * any other provider or a downloaded model sends data to a new destination and needs an ADR first.
 */
export const EMBEDDING_PROVIDERS = ['mock', 'vertex'] as const;

/** Variables every service needs. Required ones fail the boot when missing. */
export const baseEnvShape = {
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  APP_URL: z.url(),
  API_URL: z.url(),
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  APP_ENCRYPTION_KEY: z.string().min(1),
  // Version of APP_ENCRYPTION_KEY for the credential store (ADR-012). Raise it when the key is
  // replaced, move the old key to ..._PREVIOUS (with its version) and run `credentials rotate`.
  APP_ENCRYPTION_KEY_VERSION: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(1_000_000).default(1),
  ),
  APP_ENCRYPTION_KEY_PREVIOUS: optionalString,
  APP_ENCRYPTION_KEY_PREVIOUS_VERSION: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(1_000_000).optional(),
  ),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: portSchema,
  /** From address of every email the system sends. */
  SMTP_FROM: z.string().min(1).default('Watchtower <no-reply@example.com>'),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  // Break-glass local admin (role head). Both set: the api creates/updates the account at boot.
  // Neither set: no break-glass account is provisioned from the environment (the CLI can still
  // create one). The password is a secret: environment only, never in the repo.
  BREAK_GLASS_EMAIL: optionalString,
  BREAK_GLASS_PASSWORD: optionalString,
  // Mock sign-in for local work (POST /v1/auth/dev-login). Off unless set to true, and even then
  // only in mock Google mode outside production: see applyGuards.
  DEV_LOGIN_ENABLED: z.preprocess(emptyToUndefined, z.stringbool().default(false)),
  // Integrations: empty means mock mode (resolveIntegrationMode).
  GOOGLE_OIDC_CLIENT_ID: optionalString,
  GOOGLE_OIDC_CLIENT_SECRET: optionalString,
  GOOGLE_ALLOWED_DOMAIN: optionalString,
  GMAIL_SERVICE_ACCOUNT_JSON_PATH: optionalString,
  GMAIL_IMPERSONATE_USER: optionalString,
  GMAIL_OAUTH_CLIENT_ID: optionalString,
  GMAIL_OAUTH_CLIENT_SECRET: optionalString,
  GMAIL_OAUTH_REFRESH_TOKEN: optionalString,
  GMAIL_OAUTH_MAILBOX: optionalString,
  LINE_CHANNEL_ID: optionalString,
  LINE_CHANNEL_SECRET: optionalString,
  LINE_CHANNEL_ACCESS_TOKEN: optionalString,
  DISCORD_BOT_TOKEN: optionalString,
  DISCORD_ALERT_CHANNEL_ID: optionalString,
  GITHUB_APP_ID: optionalString,
  GITHUB_APP_PRIVATE_KEY_PATH: optionalString,
  GCP_PROJECT_ID: optionalString,
  GOOGLE_APPLICATION_CREDENTIALS: optionalString,
  AI_PROVIDER: z.enum(AI_PROVIDERS).default('mock'),
  ANTHROPIC_API_KEY: optionalString,
  VERTEX_PROJECT_ID: optionalString,
  VERTEX_LOCATION: optionalString,
  WEB_PUSH_VAPID_PUBLIC: optionalString,
  WEB_PUSH_VAPID_PRIVATE: optionalString,
} satisfies z.ZodRawShape;

/**
 * Phase 1 variables (T-123a). Every one is optional and empty means mock mode, so an unchanged
 * `.env.example` never reaches a real service. Credentials are secrets: environment (or the
 * encrypted credential store, ADR-004) only. The groups below follow `.env.example`.
 */
export const phase1EnvShape = {
  // Gmail push (T-102): Pub/Sub project, topic and subscription, and how the push receiver
  // recognises Pub/Sub (OIDC token audience and service account). Emulator host: PUBSUB_EMULATOR_HOST.
  PUBSUB_EMULATOR_HOST: optionalString,
  PUBSUB_PROJECT_ID: optionalString,
  PUBSUB_TOPIC: optionalString,
  PUBSUB_SUBSCRIPTION: optionalString,
  GMAIL_PUSH_AUDIENCE: optionalString,
  GMAIL_PUSH_SERVICE_ACCOUNT: optionalString,
  // The in-memory Gmail (a fake mailbox that "sends" nothing) stands in for Gmail only on an explicit
  // opt-in, like DEV_LOGIN_ENABLED: see the guard below. Never the default, never in production.
  GMAIL_MOCK_ENABLED: z.preprocess(emptyToUndefined, z.stringbool().default(false)),
  // LINE Login for customers (T-103d): a separate channel from the Messaging API one above.
  LINE_LOGIN_CHANNEL_ID: optionalString,
  LINE_LOGIN_CHANNEL_SECRET: optionalString,
  // The fake LINE Login (approves at once as a synthetic LINE user) is for local work only. An explicit
  // opt-in, like DEV_LOGIN_ENABLED: off unless true, and refused in production, with LINE Login
  // credentials set, or off a loopback APP_URL (see applyGuards).
  LINE_LOGIN_FAKE_ENABLED: z.preprocess(emptyToUndefined, z.stringbool().default(false)),
  // Discord (T-104): webhook notifications now; the bot interactions endpoint needs the public key.
  DISCORD_WEBHOOK_URL: optionalUrl,
  DISCORD_WEBHOOK_URL_URGENT: optionalUrl,
  DISCORD_APPLICATION_ID: optionalString,
  DISCORD_PUBLIC_KEY: optionalString,
  // Web Push (T-105): the contact URL or mailto: sent to push services with the VAPID keys above.
  WEB_PUSH_SUBJECT: optionalString,
  // Outbound (T-122d): how long a customer reply waits so the agent can cancel it (UI spec: 5 s).
  OUTBOUND_UNDO_SECONDS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(30).default(5),
  ),
  // Knowledge base (T-107): embeddings, and the only hosts the URL crawler may fetch (empty: none).
  EMBEDDING_PROVIDER: z.preprocess(emptyToUndefined, z.enum(EMBEDDING_PROVIDERS).default('mock')),
  KB_CRAWL_ALLOWED_HOSTS: hostList,
  // AI models (T-132): the model id each tier uses on the selected provider. Model ids are
  // settings, never code (ADR-008). Empty with a real provider selected: AI calls fail visibly.
  AI_MODEL_DEEP: optionalString,
  AI_MODEL_STANDARD: optionalString,
  AI_MODEL_LIGHT: optionalString,
  // JSON object keyed by model id: {"<model id>":{"inputUsdPerMTok":0,"outputUsdPerMTok":0}}. A real
  // provider needs a price for every tier's model, otherwise the daily cost cap could not count.
  AI_MODEL_PRICES: optionalString,
  // AI budget (T-106d). Empty falls back to the default in config/budgets.yaml; a value overrides it.
  AI_DAILY_COST_CAP_USD: optionalPositiveNumber,
  AI_DAILY_TOKEN_CAP: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  AI_BUDGET_ALERT_PERCENT: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(100).default(80),
  ),
} satisfies z.ZodRawShape;

/**
 * Phase 2 (T-200). Every integration variable here is empty by default, and empty means mock: no
 * connector reaches an outside service until the owner supplies the value (`[ASK-HUMAN]`).
 */
export const phase2EnvShape = {
  // Alert ingest (T-201c): how the Pub/Sub push receiver for GCP alert notifications recognises
  // Pub/Sub (OIDC token audience and the service account that signs it). Both empty: it answers 503.
  // The HMAC secret of the generic alert webhook is a credential: ALERT_WEBHOOK_SECRET or the
  // credential store (integration "alerting"), see INTEGRATION_CATALOG.
  ALERT_PUSH_AUDIENCE: optionalString,
  ALERT_PUSH_SERVICE_ACCOUNT: optionalString,
  ALERT_WEBHOOK_SECRET: optionalString,
  // One signing secret per purpose (T-202 review): the secret of the deploy feed or of a heartbeat
  // cannot sign an alert, and the other way round. Credentials, like ALERT_WEBHOOK_SECRET.
  ALERT_HEARTBEAT_SECRET: optionalString,
  DEPLOY_WEBHOOK_SECRET: optionalString,
  // The public status page (T-204) is closed unless the owner opens it: `false` answers 404 on every
  // /status route. An explicit opt-in, like DEV_LOGIN_ENABLED. [ASK-HUMAN] to open.
  STATUS_PAGE_PUBLIC: z.preprocess(emptyToUndefined, z.stringbool().default(false)),
  // The product database the data tool reads (T-203c): a read-only login, columns only, no personal
  // ones. Empty = the data tool has no database. In compose the local `product_mock` database is
  // `postgres://product_mock_ro:product_mock_ro@postgres:5432/product_mock`. A secret: environment only.
  PRODUCT_DB_URL: optionalString,
  // Mock mode for the GCP Logs, metrics and repository clients (T-203): a directory with
  // `fixtures.json`, for example examples/tools. The worker (AI tools) and the api (the buttons a
  // person presses) both read it. Empty = those clients are not connected.
  AI_TOOL_FIXTURES_DIR: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  // The AI assistant (T-134, ADR-017). Empty = the default in config/budgets.yaml (`assistant`).
  ASSISTANT_MESSAGES_PER_HOUR: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(1000).default(30),
  ),
  ASSISTANT_USER_DAILY_TOKENS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1000).default(200_000),
  ),
  ASSISTANT_RETENTION_DAYS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(365).default(30),
  ),
} satisfies z.ZodRawShape;

const MIN_PRODUCTION_SECRET_LENGTH = 32;
const ENCRYPTION_KEY_BYTES = 32;
/** Also enforced by the CLI that creates a break-glass account. */
export const MIN_BREAK_GLASS_PASSWORD_LENGTH = 12;

/** True for localhost, 127.0.0.0/8, ::1 and *.localhost: a URL only this machine can reach. */
export function isLoopbackUrl(value: string): boolean {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/** A value that looks like the example placeholder or is too short to be a real secret. */
function isWeakSecret(value: string): boolean {
  return (
    /change-?me/i.test(value) || Buffer.byteLength(value, 'utf8') < MIN_PRODUCTION_SECRET_LENGTH
  );
}

const text = (env: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = env[key];
  return typeof value === 'string' ? value : undefined;
};

/**
 * Cross-field rules. Messages name the variable and the rule but never echo the value, so a
 * failed boot cannot leak a secret into logs.
 */
function applyGuards(env: Readonly<Record<string, unknown>>, ctx: z.RefinementCtx): void {
  const fail = (key: string, message: string): void => {
    ctx.addIssue({ code: 'custom', path: [key], message });
  };

  // The example secrets are fine on a laptop. On any deployment reachable from outside this machine
  // a placeholder or short secret would let anyone forge sessions and read what is encrypted at
  // rest, so the boot is refused.
  // (A production build has its own, stricter checks below.)
  const localOnly = isLoopbackUrl(text(env, 'APP_URL') ?? '');

  // The product database login (T-203c) reads customer data. On a laptop the local mock's password is
  // fine; anywhere else (production, or an APP_URL that is not this machine) it needs a real one: a
  // password of at least 16 characters that is not the mock's name or a placeholder.
  const productDb = text(env, 'PRODUCT_DB_URL');
  if (productDb !== undefined && (env.NODE_ENV === 'production' || !localOnly)) {
    let password = '';
    try {
      password = decodeURIComponent(new URL(productDb).password);
    } catch {
      fail('PRODUCT_DB_URL', 'is not a URL');
    }
    if (password.length < 16 || /change-?me|product_mock|password|example/i.test(password)) {
      fail(
        'PRODUCT_DB_URL',
        'needs a real password (at least 16 characters, not a placeholder) outside a local run; the mock login is for APP_URL on localhost only',
      );
    }
  }

  if (env.NODE_ENV !== 'production' && !localOnly) {
    for (const key of ['JWT_SECRET', 'APP_ENCRYPTION_KEY'] as const) {
      const value = text(env, key);
      if (value !== undefined && isWeakSecret(value)) {
        fail(
          key,
          `is a placeholder or shorter than ${String(MIN_PRODUCTION_SECRET_LENGTH)} bytes; set a real random value (the example values are allowed only when NODE_ENV is not production and APP_URL is localhost)`,
        );
      }
    }
  }

  if (env.NODE_ENV === 'production') {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string' && value.includes(PLACEHOLDER_MARKER)) {
        fail(
          key,
          `still has the example placeholder "${PLACEHOLDER_MARKER}"; set a real value for production`,
        );
      }
    }
    if ((text(env, 'JWT_SECRET') ?? '').length < MIN_PRODUCTION_SECRET_LENGTH) {
      fail(
        'JWT_SECRET',
        `must be at least ${String(MIN_PRODUCTION_SECRET_LENGTH)} characters in production`,
      );
    }
    const key = text(env, 'APP_ENCRYPTION_KEY') ?? '';
    const keyBytes = /^[A-Za-z0-9+/]+={0,2}$/.test(key) ? Buffer.from(key, 'base64').length : 0;
    if (keyBytes !== ENCRYPTION_KEY_BYTES) {
      fail(
        'APP_ENCRYPTION_KEY',
        `must be ${String(ENCRYPTION_KEY_BYTES)} bytes encoded as base64 in production`,
      );
    }
  }

  // The previous key exists only while credentials are being re-wrapped (ADR-012): both of its
  // variables together, a version below the current one, and as strong as the current key.
  const previousKey = text(env, 'APP_ENCRYPTION_KEY_PREVIOUS');
  const previousVersion = env.APP_ENCRYPTION_KEY_PREVIOUS_VERSION;
  if (previousKey !== undefined || previousVersion !== undefined) {
    if (previousKey === undefined || typeof previousVersion !== 'number') {
      fail(
        previousKey === undefined
          ? 'APP_ENCRYPTION_KEY_PREVIOUS'
          : 'APP_ENCRYPTION_KEY_PREVIOUS_VERSION',
        'must be set together with the other APP_ENCRYPTION_KEY_PREVIOUS* variable, or both left empty',
      );
    } else {
      const currentVersion =
        typeof env.APP_ENCRYPTION_KEY_VERSION === 'number' ? env.APP_ENCRYPTION_KEY_VERSION : 1;
      if (previousVersion >= currentVersion) {
        fail(
          'APP_ENCRYPTION_KEY_PREVIOUS_VERSION',
          'must be lower than APP_ENCRYPTION_KEY_VERSION (raise the version when you replace the key)',
        );
      }
      if (env.NODE_ENV === 'production') {
        const previousBytes = /^[A-Za-z0-9+/]+={0,2}$/.test(previousKey)
          ? Buffer.from(previousKey, 'base64').length
          : 0;
        if (previousBytes !== ENCRYPTION_KEY_BYTES) {
          fail(
            'APP_ENCRYPTION_KEY_PREVIOUS',
            `must be ${String(ENCRYPTION_KEY_BYTES)} bytes encoded as base64 in production`,
          );
        }
      }
    }
  }

  const oidcId = text(env, 'GOOGLE_OIDC_CLIENT_ID');
  const oidcSecret = text(env, 'GOOGLE_OIDC_CLIENT_SECRET');
  const oidcConfigured = Boolean(oidcId) || Boolean(oidcSecret);
  if (oidcConfigured && !text(env, 'GOOGLE_ALLOWED_DOMAIN')) {
    fail(
      'GOOGLE_ALLOWED_DOMAIN',
      'is required when Google OIDC credentials are set (domain restriction)',
    );
  }
  // Mock sign-in (dev login) exists only for local work. A production boot without real
  // credentials would leave it reachable, so refuse to start (docs/04-ARCHITECTURE.md section 6).
  if (env.NODE_ENV === 'production') {
    for (const [key, value] of [
      ['GOOGLE_OIDC_CLIENT_ID', oidcId],
      ['GOOGLE_OIDC_CLIENT_SECRET', oidcSecret],
    ] as const) {
      if (!value) fail(key, 'is required in production: mock sign-in is not allowed');
    }
  }

  // Dev login signs anyone in as a role of their choosing. It needs an explicit opt-in and exists
  // only while Google is in mock mode and outside production; asking for it elsewhere is a
  // misconfiguration, so refuse to boot rather than silently ignore it.
  if (env.DEV_LOGIN_ENABLED === true) {
    if (env.NODE_ENV === 'production') {
      fail('DEV_LOGIN_ENABLED', 'must not be true in production');
    }
    if (oidcId || oidcSecret) {
      fail(
        'DEV_LOGIN_ENABLED',
        'must not be true while Google sign-in credentials are set (dev login exists only in mock mode)',
      );
    }
    // A copied .env.example on a reachable host must not hand out head accounts (T-010 C-16).
    if (!isLoopbackUrl(text(env, 'APP_URL') ?? '')) {
      fail('DEV_LOGIN_ENABLED', 'must not be true unless APP_URL is a loopback address');
    }
  }
  // The fake LINE Login links any signed-in client to a made-up LINE account. Same rule as dev login:
  // never where it could be reached from outside (C-2).
  if (env.LINE_LOGIN_FAKE_ENABLED === true) {
    if (env.NODE_ENV === 'production') {
      fail('LINE_LOGIN_FAKE_ENABLED', 'must not be true in production');
    }
    if (text(env, 'LINE_LOGIN_CHANNEL_ID') || text(env, 'LINE_LOGIN_CHANNEL_SECRET')) {
      fail(
        'LINE_LOGIN_FAKE_ENABLED',
        'must not be true while LINE Login credentials are set (the fake exists only in mock mode)',
      );
    }
    if (!isLoopbackUrl(text(env, 'APP_URL') ?? '')) {
      fail('LINE_LOGIN_FAKE_ENABLED', 'must not be true unless APP_URL is a loopback address');
    }
  }
  // The fake mailbox accepts a customer's reply and sends nothing. NODE_ENV alone cannot tell a
  // laptop from a self-hosted deployment (compose defaults it to development), so the opt-in is
  // refused in production and on any APP_URL that is not this machine (N-1, T-102 review).
  if (env.GMAIL_MOCK_ENABLED === true) {
    if (env.NODE_ENV === 'production') {
      fail('GMAIL_MOCK_ENABLED', 'must not be true in production');
    }
    if (!isLoopbackUrl(text(env, 'APP_URL') ?? '')) {
      fail('GMAIL_MOCK_ENABLED', 'must not be true unless APP_URL is a loopback address');
    }
    if (
      text(env, 'GMAIL_SERVICE_ACCOUNT_JSON_PATH') ||
      text(env, 'GMAIL_IMPERSONATE_USER') ||
      text(env, 'GMAIL_OAUTH_CLIENT_ID') ||
      text(env, 'GMAIL_OAUTH_CLIENT_SECRET') ||
      text(env, 'GMAIL_OAUTH_REFRESH_TOKEN') ||
      text(env, 'GMAIL_OAUTH_MAILBOX')
    ) {
      fail(
        'GMAIL_MOCK_ENABLED',
        'must not be true while Gmail credentials are set (the fake exists only in mock mode)',
      );
    }
  }
  const breakGlassEmail = text(env, 'BREAK_GLASS_EMAIL');
  const breakGlassPassword = text(env, 'BREAK_GLASS_PASSWORD');
  if (Boolean(breakGlassEmail) !== Boolean(breakGlassPassword)) {
    fail(
      breakGlassEmail ? 'BREAK_GLASS_PASSWORD' : 'BREAK_GLASS_EMAIL',
      'must be set together with the other BREAK_GLASS_* variable, or both left empty',
    );
  }
  if (breakGlassPassword && breakGlassPassword.length < MIN_BREAK_GLASS_PASSWORD_LENGTH) {
    fail(
      'BREAK_GLASS_PASSWORD',
      `must be at least ${String(MIN_BREAK_GLASS_PASSWORD_LENGTH)} characters`,
    );
  }
}

/** Builds a service env schema: the shared variables, the service's own, then the guards. */
export function createEnvSchema<Shape extends z.ZodRawShape>(extra: Shape) {
  return z
    .object({ ...baseEnvShape, ...phase1EnvShape, ...phase2EnvShape, ...extra })
    .superRefine((env, ctx) => {
      applyGuards(env, ctx);
    });
}

export interface ConfigIssue {
  readonly variable: string;
  readonly message: string;
}

/** Thrown at boot when the environment is invalid. `message` lists variable names, never values. */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      `Invalid environment configuration:\n${issues
        .map((issue) => `  - ${issue.variable}: ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Validates `env` against `schema`; throws a ConfigError that is safe to print. */
export function parseEnv<Schema extends z.ZodType>(
  schema: Schema,
  env: Readonly<Record<string, string | undefined>>,
): z.output<Schema> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  throw new ConfigError(
    result.error.issues.map((issue) => ({
      variable: issue.path.map(String).join('.') || '(root)',
      message: issue.message,
    })),
  );
}
