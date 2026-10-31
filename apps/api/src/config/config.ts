import { createEnvSchema, emptyToUndefined, parseEnv, portSchema } from '@watchtower/shared';
import { z } from 'zod';

/** DI token for the validated configuration. Inject with `@Inject(APP_CONFIG)`. */
export const APP_CONFIG = Symbol('APP_CONFIG');

const apiEnvSchema = createEnvSchema({
  /** Interface to bind. Loopback by default; the Dockerfile and compose set 0.0.0.0. */
  HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: portSchema.default(4000),
  /** Cloud Run injects PORT; it wins over API_PORT when present. */
  PORT: z.preprocess(emptyToUndefined, portSchema.optional()),
  /** Serve OpenAPI at /docs. Defaults to on outside production. */
  DOCS_ENABLED: z.preprocess(emptyToUndefined, z.stringbool().optional()),
  OTEL_SERVICE_NAME: z.string().min(1).default('watchtower-api'),
});

export type ApiConfig = z.output<typeof apiEnvSchema> & {
  /** Resolved listen port: PORT, else API_PORT. */
  readonly listenPort: number;
  /** Resolved docs switch: DOCS_ENABLED, else on unless production. */
  readonly docsEnabled: boolean;
};

/**
 * Validates the environment and fails with a ConfigError (variable names only, never values) when
 * a required variable is missing or invalid. Called first in main.ts, before Nest starts.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ApiConfig {
  const parsed = parseEnv(apiEnvSchema, env);
  return {
    ...parsed,
    listenPort: parsed.PORT ?? parsed.API_PORT,
    docsEnabled: parsed.DOCS_ENABLED ?? parsed.NODE_ENV !== 'production',
  };
}
