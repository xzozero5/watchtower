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
  PUBSUB_EMULATOR_HOST: optionalString,
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
  return z.object({ ...baseEnvShape, ...extra }).superRefine((env, ctx) => {
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
