import {
  createEnvSchema,
  emptyToUndefined,
  parseEnv,
  portSchema,
  resolveIntegrationMode,
  type IntegrationMode,
} from '@watchtower/shared';
import { z } from 'zod';

/** DI token for the validated configuration. Inject with `@Inject(APP_CONFIG)`. */
export const APP_CONFIG = Symbol('APP_CONFIG');

const seconds = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const apiEnvSchema = createEnvSchema({
  /** Interface to bind. Loopback by default; the Dockerfile and compose set 0.0.0.0. */
  HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: portSchema.default(4000),
  /** Cloud Run injects PORT; it wins over API_PORT when present. */
  PORT: z.preprocess(emptyToUndefined, portSchema.optional()),
  /** Serve OpenAPI at /docs. Defaults to on outside production. */
  DOCS_ENABLED: z.preprocess(emptyToUndefined, z.stringbool().optional()),
  OTEL_SERVICE_NAME: z.string().min(1).default('watchtower-api'),
  /** Lifetime of the access JWT. Short on purpose: refresh renews it. */
  ACCESS_TOKEN_TTL_SECONDS: seconds(900, 60, 3600),
  /** Lifetime of one refresh token (idle limit); every use issues a new one. */
  REFRESH_TOKEN_TTL_SECONDS: seconds(7 * 24 * 3600, 300, 90 * 24 * 3600),
  /** Absolute lifetime of a session; refresh cannot extend it. */
  SESSION_MAX_AGE_SECONDS: seconds(30 * 24 * 3600, 3600, 365 * 24 * 3600),
  /** How long a client magic link stays valid. */
  MAGIC_LINK_TTL_SECONDS: seconds(900, 60, 3600),
  /**
   * Reverse proxies in front of the api whose X-Forwarded-For to trust, for the client IP in the
   * audit log and rate limits. 0 trusts none (the socket address is used). Caddy in compose is 1.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /** How often an open WebSocket re-checks its session in the database (seconds). */
  REALTIME_REVALIDATE_SECONDS: seconds(10, 1, 300),
});

export type ApiConfig = z.output<typeof apiEnvSchema> & {
  /** Resolved listen port: PORT, else API_PORT. */
  readonly listenPort: number;
  /** Resolved docs switch: DOCS_ENABLED, else on unless production. */
  readonly docsEnabled: boolean;
  /** `live` only when both Google credentials are set; otherwise `mock` (nothing leaves the machine). */
  readonly googleMode: IntegrationMode;
  /** The Google Workspace domain staff sign in with. Falls back to example.com in mock mode. */
  readonly staffDomain: string;
  /** Dev login exists only in mock mode and never in production. */
  readonly devLoginEnabled: boolean;
  /** Cookies get the Secure flag in production and whenever the api is served over https. */
  readonly cookieSecure: boolean;
};

/**
 * Validates the environment and fails with a ConfigError (variable names only, never values) when
 * a required variable is missing or invalid. Called first in main.ts, before Nest starts.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ApiConfig {
  const parsed = parseEnv(apiEnvSchema, env);
  const googleMode = resolveIntegrationMode([
    parsed.GOOGLE_OIDC_CLIENT_ID,
    parsed.GOOGLE_OIDC_CLIENT_SECRET,
  ]);
  const production = parsed.NODE_ENV === 'production';
  return {
    ...parsed,
    listenPort: parsed.PORT ?? parsed.API_PORT,
    docsEnabled: parsed.DOCS_ENABLED ?? !production,
    googleMode,
    staffDomain: (parsed.GOOGLE_ALLOWED_DOMAIN ?? 'example.com').toLowerCase(),
    devLoginEnabled: googleMode === 'mock' && !production,
    cookieSecure: production || new URL(parsed.API_URL).protocol === 'https:',
  };
}
