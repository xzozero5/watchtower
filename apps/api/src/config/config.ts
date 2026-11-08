import {
  createEnvSchema,
  emptyToUndefined,
  parseEnv,
  portSchema,
  resolveIntegrationMode,
  ticketKeyPrefixSchema,
  DEFAULT_TICKET_KEY_PREFIX,
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
  /** Serve OpenAPI at /docs. Defaults to on outside production; ignored (always off) in production. */
  DOCS_ENABLED: z.preprocess(emptyToUndefined, z.stringbool().optional()),
  OTEL_SERVICE_NAME: z.string().min(1).default('watchtower-api'),
  /**
   * "Test connection" of the admin integrations page runs the adapter's real check instead of the
   * offline fake (ADR-012). Off by default; turning it on needs real credentials and is the owner's call.
   */
  CREDENTIAL_LIVE_TEST_ENABLED: z.preprocess(emptyToUndefined, z.stringbool().default(false)),
  /**
   * Knowledge base search (T-107c): the cosine similarity a passage needs to count as a vector
   * match. `[ASSUMED]` 0.25; the right value depends on the embedding model, so tune it with real
   * queries once a model is chosen. 0 returns the nearest passages whatever they are about.
   */
  KB_MIN_VECTOR_SIMILARITY: z.preprocess(
    emptyToUndefined,
    z.coerce.number().min(0).max(1).default(0.25),
  ),
  /**
   * Most model calls the api (the assistant, AI summaries) has in flight at once against a live
   * provider. The claude-bridge has 4 slots by default; this leaves the rest to the worker (ADR-023
   * "Live provider"). Raise it together with CLAUDE_CLI_BRIDGE_MAX_CONCURRENCY.
   */
  AI_API_MAX_CONCURRENCY: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(16).default(2),
  ),
  /**
   * How many api replicas run (compose: one). The AI slot limiter and `assistant_busy` are per process (ADR-029 C-19,
   * `[ASSUMED]` one replica): more than one logs a warning at boot. Not used for anything else.
   */
  API_REPLICAS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(64).default(1)),
  /**
   * Person narration (DoD C-25 / ADR-029 section 9.9): disabled until golden answer suite passes.
   */
  INSIGHT_PERSON_NARRATION_ENABLED: z.preprocess(
    emptyToUndefined,
    z.stringbool().default(false),
  ),
  /** Lifetime of the access JWT. Short on purpose: refresh renews it. */
  ACCESS_TOKEN_TTL_SECONDS: seconds(900, 60, 3600),
  /** Lifetime of one refresh token (idle limit); every use issues a new one. */
  REFRESH_TOKEN_TTL_SECONDS: seconds(7 * 24 * 3600, 300, 90 * 24 * 3600),
  /** Absolute lifetime of a session; refresh cannot extend it. */
  SESSION_MAX_AGE_SECONDS: seconds(30 * 24 * 3600, 3600, 365 * 24 * 3600),
  /**
   * Who the weekly brief of the CEO view is emailed to when a head publishes it (T-305c): comma-separated
   * addresses, at most 50. The head can change the list in the publish dialog. Empty: nobody by default (the
   * brief is published on the page only). An address is personal data of the instance, so it is configuration,
   * never code.
   */
  WEEKLY_BRIEF_RECIPIENTS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .optional()
      .transform((value, ctx) => {
        const list = (value ?? '')
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter((item) => item !== '');
        if (list.length > 50 || !list.every((item) => z.email().safeParse(item).success)) {
          ctx.addIssue({ code: 'custom', message: 'must be up to 50 comma-separated email addresses' });
          return z.NEVER;
        }
        return [...new Set(list)];
      }),
  ),
  /**
   * Mail domains, besides the active staff, that the publish dialog of the weekly brief may send to (T-306a C-13):
   * comma-separated (for example the company's own domain). Empty: only active staff and the addresses of
   * WEEKLY_BRIEF_RECIPIENTS. A head cannot send the brief to an address outside this set.
   */
  WEEKLY_BRIEF_RECIPIENT_DOMAINS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .optional()
      .transform((value, ctx) => {
        const list = (value ?? '')
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter((item) => item !== '');
        if (list.length > 20 || !list.every((item) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?.[a-z]{2,}$/.test(item))) {
          ctx.addIssue({ code: 'custom', message: 'must be up to 20 comma-separated domains' });
          return z.NEVER;
        }
        return [...new Set(list)];
      }),
  ),
  /** How long a client magic link stays valid. */
  MAGIC_LINK_TTL_SECONDS: seconds(900, 60, 3600),
  /**
   * Reverse proxies in front of the api whose X-Forwarded-For to trust, for the client IP in the
   * audit log and rate limits. 0 trusts none (the socket address is used). Caddy in compose is 1.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /** How often an open WebSocket re-checks its session in the database (seconds). */
  REALTIME_REVALIDATE_SECONDS: seconds(10, 1, 300),
  /**
   * Prefix of the human ticket number: `OPS` gives `OPS-1234`. 2 to 10 letters or digits, upper-cased.
   * Changing it renames future displays only; keys already sent in emails keep the old prefix.
   */
  TICKET_KEY_PREFIX: z.preprocess(
    emptyToUndefined,
    ticketKeyPrefixSchema.default(DEFAULT_TICKET_KEY_PREFIX),
  ),
  /**
   * Key that signs portal tracking links and proof-of-work challenges (HKDF with a separate label
   * for each). Empty: derived from APP_ENCRYPTION_KEY (ADR-004, ADR-007). A secret: environment only.
   */
  PORTAL_TOKEN_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  /**
   * How long a tracking link works; every email that carries a new link starts a new period. A link
   * is a bearer credential that sits in a mailbox, so the default is 30 days `[ASSUMED]`; all links
   * of a ticket also stop working when it is closed.
   */
  PORTAL_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Leading zero bits the portal proof-of-work asks for (ADR-007). 8 is for tests. */
  PORTAL_POW_DIFFICULTY_BITS: z.coerce.number().int().min(4).max(28).default(18),
  /** How long a proof-of-work challenge stays valid. */
  PORTAL_POW_TTL_SECONDS: seconds(1800, 30, 86_400),
  /** The form cannot be submitted sooner than this after its challenge was issued. */
  PORTAL_MIN_FILL_SECONDS: seconds(3, 0, 120),
  /**
   * Prefix of the rate-limit counters in Redis. Instances (or test runs) sharing one Redis keep
   * separate counters by setting different values.
   */
  RATE_LIMIT_NAMESPACE: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .default('wt'),
  /**
   * Gmail push notifications accepted per minute per client IP, before the token is even checked
   * (T-102b). Pub/Sub delivers from Google addresses, so the limit is generous `[ASSUMED]`; it is
   * there to bound the cost of a flood of forged requests, not to pace real mail.
   */
  GMAIL_PUSH_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(600),
  /**
   * Alert deliveries (GCP push and the signed webhook) accepted per minute per client IP, before
   * the token or the signature is even checked (T-201c). `[ASSUMED]`: generous, it only bounds the
   * cost of a flood of forged requests.
   */
  ALERT_INGEST_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(600),
  /**
   * Discord interactions (button presses, `/ack`, `/incident`) accepted per minute per client IP, before the
   * signature is checked (T-207a C-8). Its own number: during an incident the alert ingest and the buttons
   * are busy at the same time, and one shared limit would answer the buttons with 429. `[ASSUMED]`
   */
  DISCORD_INTERACTIONS_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(600),
  /**
   * Interactions one Discord user may make per minute, counted after the signature checked out (T-207a C-8):
   * Discord delivers from shared addresses, so the per-IP limit says little about who is pressing. `[ASSUMED]`
   */
  DISCORD_USER_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
  /**
   * Portal uploads (T-140) are buffered in memory before they are checked, so the number read at the
   * same time is bounded: in this process, and per client address. More than that: 503 + Retry-After.
   * `[ASSUMED]` values; raise them only together with the api container's memory limit.
   */
  PORTAL_UPLOAD_MAX_CONCURRENT: z.coerce.number().int().min(1).max(50).default(3),
  PORTAL_UPLOAD_MAX_PER_ADDRESS: z.coerce.number().int().min(1).max(10).default(1),
  /** A portal upload that sends nothing for this long is cut off (and all of it must arrive in 4 times as long). */
  PORTAL_UPLOAD_IDLE_SECONDS: seconds(30, 1, 300),
  /**
   * The slowest a portal upload may be, in kilobytes per second, measured over each stretch of
   * PORTAL_UPLOAD_IDLE_SECONDS (T-154). A sender below it is cut off and its slot freed, however
   * steadily it trickles: one byte a second used to hold a slot for the whole deadline. 0 = off.
   * `[ASSUMED]` 32: the largest body (25 MB) takes about 13 minutes at this speed; a phone on a poor link manages more.
   */
  PORTAL_UPLOAD_MIN_KB_PER_SECOND: z.coerce.number().int().min(0).max(10_000).default(32),
  /**
   * Whether the portal's submit with files must carry its proof of work in the `x-portal-proof`
   * header (T-154). `required`: checked before an upload slot is taken, so a script that cannot do
   * the proof holds no slot. `optional` (default until the web form sends the header): checked when
   * present, and a request without it is checked only after its body was read.
   */
  PORTAL_UPLOAD_PROOF_HEADER: z.enum(['optional', 'required']).default('optional'),
  /**
   * The remote-image proxy of the mail reader (T-175) fetches `https:` pictures only. Set true to allow
   * plain `http:` too (many newsletters still link them); every other SSRF check stays on.
   */
  REMOTE_IMAGES_ALLOW_HTTP: z.preprocess(emptyToUndefined, z.stringbool().default(false)),
  /**
   * Most bytes of files customers may upload through the portal in any 24 hours, for the whole instance
   * (megabytes; 0 = no cap). Past it the portal answers 429 `upload_quota` until the day rolls over, so a
   * flood of large files cannot fill the bucket (T-155). `[ASSUMED]` 2048.
   */
  PORTAL_UPLOAD_DAILY_MB: z.coerce.number().int().min(0).max(1_000_000).default(2048),
  /**
   * The same cap per client address, per email address and per organization (megabytes in 24 hours;
   * 0 = no cap for that scope) (T-155a C-1). The instance-wide cap above is only the backstop: a
   * single outsider reaches their own cap long before it, so cannot lock every customer out of
   * attaching files. `[ASSUMED]` values: a few screenshots a day per person.
   */
  PORTAL_UPLOAD_IP_DAILY_MB: z.coerce.number().int().min(0).max(1_000_000).default(100),
  PORTAL_UPLOAD_EMAIL_DAILY_MB: z.coerce.number().int().min(0).max(1_000_000).default(50),
  PORTAL_UPLOAD_ORG_DAILY_MB: z.coerce.number().int().min(0).max(1_000_000).default(512),
  /** Portal submissions per hour: per client IP, per email address, per organization. */
  PORTAL_RATE_IP_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(20),
  PORTAL_RATE_EMAIL_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(5),
  PORTAL_RATE_ORG_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(60),
});

export type ApiConfig = z.output<typeof apiEnvSchema> & {
  /** Resolved listen port: PORT, else API_PORT. */
  readonly listenPort: number;
  /** Resolved docs switch: DOCS_ENABLED (default on), but always off when NODE_ENV is production. */
  readonly docsEnabled: boolean;
  /** `live` only when both Google credentials are set; otherwise `mock` (nothing leaves the machine). */
  readonly googleMode: IntegrationMode;
  /** The Google Workspace domain staff sign in with. Falls back to example.com in mock mode. */
  readonly staffDomain: string;
  /**
   * Dev login needs DEV_LOGIN_ENABLED=true (never the default), Google in mock mode and a
   * non-production NODE_ENV. The shared env guard already refuses a boot that asks for it
   * elsewhere; this repeats the three conditions so no single mistake can turn it on.
   */
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
    // Never in production (T-125 QA-33): the OpenAPI document lists every route and field to anyone.
    docsEnabled: !production && (parsed.DOCS_ENABLED ?? true),
    googleMode,
    staffDomain: (parsed.GOOGLE_ALLOWED_DOMAIN ?? 'example.com').toLowerCase(),
    devLoginEnabled: parsed.DEV_LOGIN_ENABLED && googleMode === 'mock' && !production,
    cookieSecure: production || new URL(parsed.API_URL).protocol === 'https:',
  };
}
