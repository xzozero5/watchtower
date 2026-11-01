/**
 * Integration credential store (T-116, ADR-004, ADR-012): this feature's own audit actions, ticket
 * event types and queue names (T-123a), the catalog of integrations and the HTTP schemas of
 * `/v1/admin/integrations`.
 *
 * Browser-safe (no `node:crypto`): the admin UI imports the schemas from here. The crypto is in
 * `../credential-box.ts` and the store in `@watchtower/db`.
 *
 * Secrets are write-only over HTTP: no schema below has a field that can carry a stored value back.
 */
import { z } from 'zod';

/** Audit `action` strings written by this feature. Metadata holds field names, never values. */
export const CREDENTIALS_AUDIT_ACTIONS = {
  /** One or more fields of an integration were written. */
  integrationCredentialSet: 'integration.credential.set',
  /** A stored field was deleted. */
  integrationCredentialDelete: 'integration.credential.delete',
  /** "Test connection" was pressed (mock unless the live flag is on). */
  integrationCredentialTest: 'integration.credential.test',
  /** The data keys were re-wrapped under the current key version (CLI). */
  integrationCredentialRotate: 'integration.credential.rotate',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const CREDENTIALS_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api, consumer: worker). */
export const CREDENTIALS_QUEUES = {} as const satisfies Record<string, string>;

// --- catalog ---------------------------------------------------------------------------------

export interface CredentialFieldDefinition {
  readonly label: string;
  /** A secret in the sense of N1. All fields are write-only; this tells the UI to use a password input. */
  readonly secret: boolean;
  /** The integration is not complete without it. */
  readonly required: boolean;
  /** The environment variable that wins over the database value (ADR-004). */
  readonly env: string;
  /** `file`: the variable holds the path of a file and the value is that file's content. */
  readonly envKind: 'value' | 'file';
}

export interface IntegrationDefinition {
  readonly name: string;
  readonly fields: Readonly<Record<string, CredentialFieldDefinition>>;
  /**
   * An integration with more than one way to connect (Gmail: OAuth or service account): it is
   * complete when ALL fields of ANY ONE of these sets are configured. Those fields are all
   * `required: false`. Absent: every `required` field must be configured.
   */
  readonly alternatives?: Readonly<Record<string, readonly string[]>>;
}

const field = (
  label: string,
  env: string,
  options: { secret?: boolean; required?: boolean; envKind?: 'value' | 'file' } = {},
): CredentialFieldDefinition => ({
  label,
  env,
  secret: options.secret ?? true,
  required: options.required ?? true,
  envKind: options.envKind ?? 'value',
});

/**
 * Every integration whose credentials the store keeps, with its fields. `[ASSUMED]` the exact
 * field names and which are required; adapters (T-102, T-103, T-104, T-105, T-106f, T-107) read
 * them through the store by these names. Add an integration or a field here; no migration needed.
 */
export const INTEGRATION_CATALOG = {
  gmail: {
    name: 'Gmail',
    fields: {
      // An option (ADR-012, PRD R-2.4): service account with domain-wide delegation.
      serviceAccountJson: field('Service account key (JSON)', 'GMAIL_SERVICE_ACCOUNT_JSON_PATH', {
        envKind: 'file',
        required: false,
      }),
      impersonateUser: field('Mailbox to read (delegation)', 'GMAIL_IMPERSONATE_USER', {
        secret: false,
        required: false,
      }),
      // The default (T-102e): OAuth of the one support mailbox. The client id and secret are typed
      // on the admin page or set in the environment; the refresh token and the mailbox are written
      // by the OAuth callback (`/v1/admin/integrations/gmail/oauth/*`) and are never shown.
      oauthClientId: field('OAuth client ID', 'GMAIL_OAUTH_CLIENT_ID', {
        secret: false,
        required: false,
      }),
      oauthClientSecret: field('OAuth client secret', 'GMAIL_OAUTH_CLIENT_SECRET', {
        required: false,
      }),
      oauthRefreshToken: field('OAuth refresh token', 'GMAIL_OAUTH_REFRESH_TOKEN', {
        required: false,
      }),
      oauthMailbox: field('Mailbox the OAuth grant belongs to', 'GMAIL_OAUTH_MAILBOX', {
        secret: false,
        required: false,
      }),
    },
    alternatives: {
      oauth: ['oauthClientId', 'oauthClientSecret', 'oauthRefreshToken', 'oauthMailbox'],
      service_account: ['serviceAccountJson', 'impersonateUser'],
    },
  },
  line: {
    name: 'LINE Official Account',
    fields: {
      channelId: field('Channel ID', 'LINE_CHANNEL_ID', { secret: false }),
      channelSecret: field('Channel secret', 'LINE_CHANNEL_SECRET'),
      channelAccessToken: field('Channel access token', 'LINE_CHANNEL_ACCESS_TOKEN'),
    },
  },
  discord: {
    name: 'Discord',
    fields: {
      botToken: field('Bot token', 'DISCORD_BOT_TOKEN', { required: false }),
      webhookUrl: field('Webhook URL (default channel)', 'DISCORD_WEBHOOK_URL', {
        required: false,
      }),
      webhookUrlUrgent: field('Webhook URL (urgent channel)', 'DISCORD_WEBHOOK_URL_URGENT', {
        required: false,
      }),
      alertChannelId: field('Alert channel ID', 'DISCORD_ALERT_CHANNEL_ID', {
        secret: false,
        required: false,
      }),
      applicationId: field('Application ID', 'DISCORD_APPLICATION_ID', {
        secret: false,
        required: false,
      }),
      publicKey: field('Interactions public key', 'DISCORD_PUBLIC_KEY', {
        secret: false,
        required: false,
      }),
    },
  },
  github: {
    name: 'GitHub App',
    fields: {
      appId: field('App ID', 'GITHUB_APP_ID', { secret: false }),
      privateKey: field('Private key (PEM)', 'GITHUB_APP_PRIVATE_KEY_PATH', { envKind: 'file' }),
    },
  },
  ai: {
    name: 'AI provider',
    fields: {
      anthropicApiKey: field('Anthropic API key', 'ANTHROPIC_API_KEY', { required: false }),
      vertexProjectId: field('Vertex project ID', 'VERTEX_PROJECT_ID', {
        secret: false,
        required: false,
      }),
      vertexLocation: field('Vertex location', 'VERTEX_LOCATION', {
        secret: false,
        required: false,
      }),
    },
  },
  alerting: {
    name: 'Alert ingest',
    fields: {
      webhookSecret: field('Alert webhook signing secret', 'ALERT_WEBHOOK_SECRET', {
        required: false,
      }),
      heartbeatSecret: field('Heartbeat signing secret', 'ALERT_HEARTBEAT_SECRET', {
        required: false,
      }),
      deploySecret: field('Deploy feed signing secret', 'DEPLOY_WEBHOOK_SECRET', {
        required: false,
      }),
    },
  },
  web_push: {
    name: 'Web Push',
    fields: {
      vapidPublic: field('VAPID public key', 'WEB_PUSH_VAPID_PUBLIC', { secret: false }),
      vapidPrivate: field('VAPID private key', 'WEB_PUSH_VAPID_PRIVATE'),
      subject: field('Contact (mailto: or https:)', 'WEB_PUSH_SUBJECT', { secret: false }),
    },
  },
} as const satisfies Record<string, IntegrationDefinition>;

export type IntegrationKey = keyof typeof INTEGRATION_CATALOG;
export const INTEGRATION_KEYS = Object.keys(INTEGRATION_CATALOG) as IntegrationKey[];

export function isIntegrationKey(value: string): value is IntegrationKey {
  return Object.hasOwn(INTEGRATION_CATALOG, value);
}

/**
 * Is the integration complete, given which of its fields are configured? Every `required` field,
 * or, for an integration with `alternatives`, all fields of at least one alternative.
 */
export function isIntegrationComplete(
  integration: IntegrationKey,
  isConfigured: (field: string) => boolean,
): boolean {
  const definition: IntegrationDefinition = INTEGRATION_CATALOG[integration];
  if (definition.alternatives !== undefined) {
    return Object.values(definition.alternatives).some((set) => set.every(isConfigured));
  }
  const names = Object.keys(definition.fields);
  const required = names.filter((name) => definition.fields[name]?.required === true);
  return required.length === 0 ? names.some(isConfigured) : required.every(isConfigured);
}

/** Field definitions of one integration, typed loosely (the catalog's literal types are narrower). */
export function integrationFields(
  integration: IntegrationKey,
): Readonly<Record<string, CredentialFieldDefinition>> {
  return INTEGRATION_CATALOG[integration].fields;
}

/** Every environment variable the catalog refers to. */
export const CREDENTIAL_ENV_VARS: readonly string[] = INTEGRATION_KEYS.flatMap((integration) =>
  Object.values(integrationFields(integration)).map((definition) => definition.env),
);

/** Longest value accepted: a service account JSON or a PEM key fits with room to spare. */
export const CREDENTIAL_VALUE_MAX_LENGTH = 16_384;

// --- HTTP schemas ----------------------------------------------------------------------------

export const integrationKeySchema = z.enum(
  INTEGRATION_KEYS as [IntegrationKey, ...IntegrationKey[]],
);

export const integrationParamSchema = z.object({ integration: integrationKeySchema });
export type IntegrationParam = z.infer<typeof integrationParamSchema>;

/**
 * Every field name of the catalog. Request keys are checked against this list, so a name such as
 * `toString` or `__proto__` is refused before any code looks it up; which fields belong to which
 * integration is checked by the service.
 */
export const CREDENTIAL_FIELD_NAMES = [
  ...new Set(
    INTEGRATION_KEYS.flatMap((integration) => Object.keys(integrationFields(integration))),
  ),
] as [string, ...string[]];
export const credentialFieldNameSchema = z.enum(CREDENTIAL_FIELD_NAMES);

export const integrationFieldParamSchema = z.object({
  integration: integrationKeySchema,
  field: credentialFieldNameSchema,
});
export type IntegrationFieldParam = z.infer<typeof integrationFieldParamSchema>;

/** A value to store: trimmed, never empty, bounded. */
const credentialValueSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(CREDENTIAL_VALUE_MAX_LENGTH));

/**
 * Field name to value. Only names from the catalog are accepted as keys. The key check runs first
 * and its message is fixed: the schema library's own "unrecognized key" issue would repeat what
 * the caller sent.
 */
const fieldValuesSchema = z
  .unknown()
  .superRefine((input, ctx) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return;
    const known = new Set<string>(CREDENTIAL_FIELD_NAMES);
    if (Object.keys(input).some((key) => !known.has(key))) {
      ctx.addIssue({ code: 'custom', message: 'unknown field', fatal: true });
    }
  })
  .pipe(z.record(z.string(), credentialValueSchema));

export const putCredentialsSchema = z.object({
  fields: fieldValuesSchema.refine((fields) => Object.keys(fields).length > 0, {
    message: 'send at least one field',
  }),
});
export type PutCredentials = z.infer<typeof putCredentialsSchema>;

export const testConnectionSchema = z.object({
  /** Values typed in the form but not saved yet. Optional: without them the saved values are tested. */
  fields: fieldValuesSchema.optional(),
});
export type TestConnection = z.infer<typeof testConnectionSchema>;

export const CREDENTIAL_SOURCES = ['env', 'db', 'none'] as const;
export const credentialSourceSchema = z.enum(CREDENTIAL_SOURCES);
export type CredentialSource = z.infer<typeof credentialSourceSchema>;

export const credentialFieldStatusSchema = z.object({
  field: z.string(),
  label: z.string(),
  secret: z.boolean(),
  required: z.boolean(),
  configured: z.boolean(),
  /** Where the value in effect comes from. `env` wins over `db`; the field is then read-only. */
  source: credentialSourceSchema,
  /** The variable that sets it, shown as "Set by environment variable NAME". Never its value. */
  envVar: z.string(),
  /** Only for `source: "db"`. */
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});
export type CredentialFieldStatus = z.infer<typeof credentialFieldStatusSchema>;

export const INTEGRATION_STATUSES = ['not_configured', 'partial', 'configured'] as const;

export const integrationStatusSchema = z.object({
  key: integrationKeySchema,
  name: z.string(),
  status: z.enum(INTEGRATION_STATUSES),
  fields: z.array(credentialFieldStatusSchema),
});
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

export const TEST_MODES = ['mock', 'live'] as const;
export const testModeSchema = z.enum(TEST_MODES);
export type TestMode = z.infer<typeof testModeSchema>;

export const integrationListSchema = z.object({
  /** `mock` until a person turns live tests on (CREDENTIAL_LIVE_TEST_ENABLED, an `[ASK-HUMAN]` step). */
  testMode: testModeSchema,
  items: z.array(integrationStatusSchema),
});
export type IntegrationList = z.infer<typeof integrationListSchema>;

export const testConnectionResultSchema = z.object({
  ok: z.boolean(),
  mode: testModeSchema,
  /** A non-secret identity such as a bot name or mailbox address; `mock:<integration>` in mock mode. */
  identity: z.string().nullable(),
  /** Plain language. Never contains a submitted or stored value. */
  message: z.string(),
  checkedAt: z.iso.datetime(),
});
export type TestConnectionResult = z.infer<typeof testConnectionResultSchema>;

/** Picks the catalog's environment variables out of a larger configuration object. */
export function pickCredentialEnv(
  source: Readonly<Record<string, unknown>>,
): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const name of CREDENTIAL_ENV_VARS) {
    const value = source[name];
    picked[name] = typeof value === 'string' && value.trim() !== '' ? value : undefined;
  }
  return picked;
}
