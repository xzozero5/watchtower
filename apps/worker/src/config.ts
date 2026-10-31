import { createEnvSchema, emptyToUndefined, parseEnv, portSchema } from '@watchtower/shared';
import { z } from 'zod';

const workerEnvSchema = createEnvSchema({
  /** Interface for the health server. Loopback by default; Dockerfile and compose set 0.0.0.0. */
  HOST: z.string().min(1).default('127.0.0.1'),
  WORKER_PORT: portSchema.default(4100),
  /** Cloud Run injects PORT; it wins over WORKER_PORT when present. */
  PORT: z.preprocess(emptyToUndefined, portSchema.optional()),
  OTEL_SERVICE_NAME: z.string().min(1).default('watchtower-worker'),
  /** Jobs processed in parallel per queue. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
});

export type WorkerConfig = z.output<typeof workerEnvSchema> & {
  /** Resolved health port: PORT, else WORKER_PORT. */
  readonly listenPort: number;
};

/** Validates the environment; throws a ConfigError (variable names only) when it is invalid. */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkerConfig {
  const parsed = parseEnv(workerEnvSchema, env);
  return { ...parsed, listenPort: parsed.PORT ?? parsed.WORKER_PORT };
}
