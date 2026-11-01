import {
  DEFAULT_DISCORD_CHANNEL_MAP,
  DEFAULT_TICKET_KEY_PREFIX,
  DiscordChannelMapError,
  parseDiscordChannelMap,
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
  /**
   * Gmail heartbeat (R-2.8): a mailbox that has had no push for this many minutes of business time
   * (the default business calendar) is marked unhealthy. `[ASSUMED]` 120: a support mailbox that is
   * silent for two working hours is worth a look; an instance with little mail raises it.
   */
  GMAIL_HEARTBEAT_STALE_MINUTES: z.coerce.number().int().min(5).max(10_080).default(120),
  /** Bounded full sync (R-2.1, when `history.list` answers 404 or there is no cursor yet): how far back, in days. `[ASSUMED]` 7. */
  GMAIL_FULL_SYNC_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  /** ... and the most messages one full sync reads. `[ASSUMED]` 500; the rest is logged as truncated. */
  GMAIL_FULL_SYNC_MAX_MESSAGES: z.coerce.number().int().min(10).max(10_000).default(500),
  /**
   * Cleanup job (T-117): days to keep an expired or revoked session, refresh token, magic link or
   * tracking link before it is deleted. `[ASSUMED]` 7.
   */
  CLEANUP_AUTH_RETENTION_DAYS: z.coerce.number().int().min(0).max(365).default(7),
  /**
   * Which events go to which Discord channel (T-104c, po decision #6: Discord is for notification and
   * coordination). JSON of the form `{"routes":[{"name":"all","slot":"default"}]}`, each route with
   * optional `events`, `minPriority` and `channels`. A slot is a destination name, never a URL (the
   * webhook URLs are credentials, ADR-012). Empty: every new
   * ticket goes to the default slot. An invalid value fails the boot, naming the variable only.
   */
  DISCORD_CHANNEL_MAP: z
    .preprocess(emptyToUndefined, z.string().optional())
    .transform((text, ctx) => {
      if (text === undefined) return DEFAULT_DISCORD_CHANNEL_MAP;
      try {
        return parseDiscordChannelMap(text);
      } catch (error) {
        const reason = error instanceof DiscordChannelMapError ? error.reason : 'invalid_shape';
        ctx.addIssue({
          code: 'custom',
          // Never the text itself: it is operator input and the message may end up in a log.
          message: `is not a valid channel map (${reason})`,
        });
        return z.NEVER;
      }
    }),
  /** Days to keep a break-glass lockout counter after its last failed sign-in (still locked ones stay). `[ASSUMED]` 30. */
  CLEANUP_BREAK_GLASS_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
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
