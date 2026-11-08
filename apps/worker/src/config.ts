import {
  ConfigError,
  DEFAULT_DISCORD_CHANNEL_MAP,
  DEFAULT_TICKET_KEY_PREFIX,
  DiscordChannelMapError,
  parseDiscordChannelMap,
  KB_CHUNK_DEFAULTS,
  createEnvSchema,
  emptyToUndefined,
  parseEnv,
  parseWeeklyBriefTime,
  WEEKLY_BRIEF_DAYS,
  portSchema,
  ticketKeyPrefixSchema,
} from '@watchtower/shared';
import { z } from 'zod';

import { smtpSettingsIssues } from './mailer.js';

const workerEnvSchema = createEnvSchema({
  /** Interface for the health server. Loopback by default; Dockerfile and compose set 0.0.0.0. */
  HOST: z.string().min(1).default('127.0.0.1'),
  WORKER_PORT: portSchema.default(4100),
  /** Cloud Run injects PORT; it wins over WORKER_PORT when present. */
  PORT: z.preprocess(emptyToUndefined, portSchema.optional()),
  OTEL_SERVICE_NAME: z.string().min(1).default('watchtower-worker'),
  /**
   * SMTP account (optional). Both or neither. Port 465 is implicit TLS, 587 is STARTTLS; in
   * production the worker refuses a plain unauthenticated send unless SMTP_ALLOW_INSECURE=true.
   */
  SMTP_USER: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_ALLOW_INSECURE: z.preprocess(emptyToUndefined, z.stringbool().default(false)),
  /** Jobs processed in parallel per queue. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  /**
   * Most model calls the worker's AI jobs have in flight at once against a live provider (ADR-029 section 4). The
   * claude-bridge has 4 slots: api `AI_API_MAX_CONCURRENCY` (2) + this (2) = 4, so neither can starve the other.
   * Per process (T-400 C-19): one worker process is the stage-1 assumption.
   */
  WORKER_AI_MAX_CONCURRENCY: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(16).default(2),
  ),
  /** How many worker processes run (compose: one). More than one logs a warning at boot (the AI slots are per process, C-19). */
  WORKER_REPLICAS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(64).default(1),
  ),
  /**
   * Person narration (DoD C-25 / ADR-029 section 9.9): disabled until golden answer suite passes.
   */
  INSIGHT_PERSON_NARRATION_ENABLED: z.preprocess(emptyToUndefined, z.stringbool().default(false)),
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
   * step 4, milliseconds). `[ASSUMED]` 3 s: PRD AC-1 wants a ticket within 10 s. Unset: 3000, or
   * 15000 when AI_PROVIDER=claude-cli (`claude -p` takes 5-10 s, T-170); an explicit value always wins.
   */
  INGEST_CLASSIFIER_TIMEOUT_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(100).max(30_000).optional(),
  ),
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
   * Connection string of the AI tools' read-only login (a member of `watchtower_ai_ro`, T-108a): it
   * can read the `ai_v_*` views and nothing else, so "the tools only read" (N2) is enforced by the
   * database. Empty: the tools read the same views through the worker's own connection, and only the
   * code keeps them read-only (fine for a local mock run; not for production `[ASSUMED]`).
   */
  AI_READONLY_DATABASE_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL')
      .optional(),
  ),
  /**
   * Directory with `fixtures.json` that the GCP Logs, BigQuery and repo stubs answer from while those
   * systems are not connected (mock mode, `examples/tools`). Empty: the stubs are not registered.
   */
  /**
   * Explicit opt-in, like `GMAIL_MOCK_ENABLED`: let the logs, data and repo tools run with no read-only
   * database login, so only the code keeps them read-only. For a local mock run. Default false: without a
   * login (`AI_READONLY_DATABASE_URL`) those tools are off, whatever `NODE_ENV` says (compose defaults it to
   * development).
   */
  AI_TOOLS_WITHOUT_READONLY_LOGIN: z.preprocess(emptyToUndefined, z.stringbool().default(false)),
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
  /**
   * Days to keep the files of a ticket that has been closed that long before the files themselves are
   * deleted from the object store (T-155). The messages and the audit log stay; a download of a deleted
   * file answers 404. 0 (default) keeps files for ever: deleting a customer's files is a decision for the
   * instance owner (retention policy), not a default.
   */
  UPLOAD_RETENTION_DAYS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(36_500).default(0),
  ),
  /**
   * The weekly brief of the CEO view (T-305c): which weekday and time of day (in the zone) the AI drafts it.
   * The drafting job ticks every few minutes and makes one brief per weekly slot; a worker that was down at
   * the time makes it when it is back. `WEEKLY_BRIEF_ENABLED=false` switches the job off. `[ASSUMED]` Monday
   * 08:00, so the head can edit it at the start of the week.
   */
  WEEKLY_BRIEF_ENABLED: z.preprocess(emptyToUndefined, z.stringbool().default(true)),
  WEEKLY_BRIEF_DAY: z.preprocess(emptyToUndefined, z.enum(WEEKLY_BRIEF_DAYS).default('mon')),
  WEEKLY_BRIEF_TIME: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .refine((value) => parseWeeklyBriefTime(value) !== null, 'must be HH:MM on a 24-hour clock')
      .default('08:00'),
  ),
  /** An IANA zone name (the day and time above are read in it). `[ASSUMED]` the default shift zone of the product. */
  WEEKLY_BRIEF_TIMEZONE: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'must be an IANA time zone name')
      .default('Asia/Bangkok'),
  ),
  /** The language of the brief. */
  WEEKLY_BRIEF_LOCALE: z.preprocess(emptyToUndefined, z.enum(['th', 'en']).default('en')),
  /** Days to keep a break-glass lockout counter after its last failed sign-in (still locked ones stay). `[ASSUMED]` 30. */
  CLEANUP_BREAK_GLASS_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /**
   * Knowledge base chunking (T-107b), in characters `[ASSUMED]`: aim for chunks of about TARGET, never
   * longer than MAX, join a tail shorter than MIN to its neighbour, and repeat OVERLAP characters when
   * a long paragraph is split. Defaults come from `KB_CHUNK_DEFAULTS` in `@watchtower/shared`.
   */
  KB_CHUNK_TARGET_CHARS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(50).max(8000).default(KB_CHUNK_DEFAULTS.targetChars),
  ),
  KB_CHUNK_MAX_CHARS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(50).max(16000).default(KB_CHUNK_DEFAULTS.maxChars),
  ),
  KB_CHUNK_MIN_CHARS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(4000).default(KB_CHUNK_DEFAULTS.minChars),
  ),
  KB_CHUNK_OVERLAP_CHARS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(2000).default(KB_CHUNK_DEFAULTS.overlapChars),
  ),
});

/** Default classifier wait per provider (T-170): `claude -p` needs 5-10 s, an API call far less. */
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 3000;
export const CLAUDE_CLI_CLASSIFIER_TIMEOUT_MS = 15_000;

export type WorkerConfig = Omit<
  z.output<typeof workerEnvSchema>,
  'INGEST_CLASSIFIER_TIMEOUT_MS'
> & {
  /** Resolved classifier wait (see the schema comment). */
  readonly INGEST_CLASSIFIER_TIMEOUT_MS: number;
  /** Resolved health port: PORT, else WORKER_PORT. */
  readonly listenPort: number;
};

/** Validates the environment; throws a ConfigError (variable names only) when it is invalid. */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkerConfig {
  const parsed = parseEnv(workerEnvSchema, env);
  const smtpIssues = smtpSettingsIssues({
    host: parsed.SMTP_HOST,
    port: parsed.SMTP_PORT,
    from: parsed.SMTP_FROM,
    user: parsed.SMTP_USER,
    password: parsed.SMTP_PASSWORD,
    allowInsecure: parsed.SMTP_ALLOW_INSECURE,
    production: parsed.NODE_ENV === 'production',
  });
  if (smtpIssues.length > 0) throw new ConfigError(smtpIssues);
  return {
    ...parsed,
    INGEST_CLASSIFIER_TIMEOUT_MS:
      parsed.INGEST_CLASSIFIER_TIMEOUT_MS ??
      (parsed.AI_PROVIDER === 'claude-cli' || parsed.AI_PROVIDER === 'ai-cli'
        ? CLAUDE_CLI_CLASSIFIER_TIMEOUT_MS
        : DEFAULT_CLASSIFIER_TIMEOUT_MS),
    listenPort: parsed.PORT ?? parsed.WORKER_PORT,
  };
}
