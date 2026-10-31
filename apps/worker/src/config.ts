import {
  DEFAULT_TICKET_KEY_PREFIX,
  createEnvSchema,
  emptyToUndefined,
  parseEnv,
  portSchema,
  ticketKeyPrefixSchema,
} from '@watchtower/shared';
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
  /** How often the outbox relay looks for pending jobs to hand to BullMQ (milliseconds, ADR-006). */
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  /**
   * Prefix of the human ticket number (`OPS-1234`), the same value as in the api: the domain
   * writes tickets from both processes and recognises `[OPS-1234]` in a subject (ADR-009).
   */
  TICKET_KEY_PREFIX: z.preprocess(
    emptyToUndefined,
    ticketKeyPrefixSchema.default(DEFAULT_TICKET_KEY_PREFIX),
  ),
  /**
   * How long ingestion waits for the AI classifier before it uses the header rules (ADR-009
   * step 4, milliseconds). `[ASSUMED]` 3 s: PRD AC-1 wants a ticket within 10 s.
   */
  INGEST_CLASSIFIER_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3000),
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
