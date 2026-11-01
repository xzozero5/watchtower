import {
  GMAIL_OAUTH_GRANT_FIELDS,
  GMAIL_OAUTH_RESULTS,
  INTEGRATION_CATALOG,
  type CredentialFieldStatus,
  type GmailOauthResult,
  type IntegrationDefinition,
  type IntegrationKey,
  type IntegrationStatus,
} from '@watchtower/shared';

import type { MessageKey, Translate } from '@/i18n';
import { isApiError } from '@/lib/api/errors';
import { describeError, type ErrorView } from '@/lib/admin/errors';

/** Field names that have a translated label under `admin.integrations.fields`. */
const KNOWN_FIELDS = [
  'serviceAccountJson',
  'impersonateUser',
  'oauthClientId',
  'oauthClientSecret',
  'oauthRefreshToken',
  'oauthMailbox',
  'channelId',
  'channelSecret',
  'channelAccessToken',
  'botToken',
  'webhookUrl',
  'webhookUrlUrgent',
  'alertChannelId',
  'applicationId',
  'publicKey',
  'appId',
  'privateKey',
  'anthropicApiKey',
  'vertexProjectId',
  'vertexLocation',
  'vapidPublic',
  'vapidPrivate',
  'subject',
] as const;
type KnownField = (typeof KNOWN_FIELDS)[number];

const KNOWN_INTEGRATIONS = ['gmail', 'line', 'discord', 'github', 'ai', 'web_push'] as const;
type KnownIntegration = (typeof KNOWN_INTEGRATIONS)[number];

const isKnownField = (field: string): field is KnownField =>
  (KNOWN_FIELDS as readonly string[]).includes(field);

const isKnownIntegration = (key: string): key is KnownIntegration =>
  (KNOWN_INTEGRATIONS as readonly string[]).includes(key);

/** The label of a field in the page language; a field the catalog adds later falls back to the api's own label. */
export function fieldLabel(t: Translate, field: string, fallback: string): string {
  return isKnownField(field) ? t(`admin.integrations.fields.${field}`) : fallback;
}

export function integrationName(t: Translate, key: string, fallback: string): string {
  return isKnownIntegration(key) ? t(`admin.integrations.names.${key}`) : fallback;
}

/** The two Gmail fields only the OAuth flow writes: they are shown by the Gmail panel, never as an input. */
export function isGrantField(integration: string, field: string): boolean {
  return integration === 'gmail' && GMAIL_OAUTH_GRANT_FIELDS.includes(field);
}

export interface FieldGroup {
  /** `oauth` / `service_account` for an integration with alternatives, else null. */
  id: 'oauth' | 'service_account' | null;
  fields: CredentialFieldStatus[];
}

/**
 * Splits the fields of an integration the way the catalog does (Gmail: OAuth or service account),
 * leaving out the two grant fields. An integration without alternatives is one group.
 */
export function groupFields(
  key: IntegrationKey,
  fields: readonly CredentialFieldStatus[],
): FieldGroup[] {
  const definition: IntegrationDefinition = INTEGRATION_CATALOG[key];
  const visible = fields.filter((entry) => !isGrantField(key, entry.field));
  const alternatives = definition.alternatives;
  if (alternatives === undefined) return [{ id: null, fields: visible }];
  const groups: FieldGroup[] = [];
  for (const id of ['oauth', 'service_account'] as const) {
    const names = alternatives[id];
    if (names === undefined) continue;
    const members = visible.filter((entry) => names.includes(entry.field));
    if (members.length > 0) groups.push({ id, fields: members });
  }
  const placed = new Set(groups.flatMap((group) => group.fields.map((entry) => entry.field)));
  const rest = visible.filter((entry) => !placed.has(entry.field));
  if (rest.length > 0) groups.push({ id: null, fields: rest });
  return groups;
}

export type CardState = 'not_configured' | 'partial' | 'configured' | 'env';

/**
 * The chip on a card: "Set by environment" when every value in effect comes from the environment
 * (nothing a head could change from here), otherwise the status the api reports.
 */
export function cardState(integration: IntegrationStatus): CardState {
  if (integration.status === 'not_configured') return 'not_configured';
  const inEffect = integration.fields.filter((entry) => entry.configured);
  if (
    integration.status === 'configured' &&
    inEffect.length > 0 &&
    inEffect.every((entry) => entry.source === 'env')
  ) {
    return 'env';
  }
  return integration.status;
}

/** What goes into a PUT or a test: typed values, trimmed, empty ones dropped. */
export function typedFields(drafts: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, value] of Object.entries(drafts)) {
    const trimmed = value.trim();
    if (trimmed !== '') out[field] = trimmed;
  }
  return out;
}

/** The `?gmail_oauth=` result the callback redirects with; anything else is ignored. */
export function parseGmailOauthResult(value: string | null): GmailOauthResult | null {
  return GMAIL_OAUTH_RESULTS.find((result) => result === value) ?? null;
}

/** Only an https address is opened from the api's answer. */
export function isSafeRedirect(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Adds the two codes of this page to the generic explanation of a failed call. */
export function describeIntegrationError(error: unknown, t: Translate): ErrorView {
  if (isApiError(error)) {
    if (error.code === 'credential_env_locked') {
      return {
        kind: 'conflict',
        message: t('admin.integrations.errors.envLocked'),
        fromApi: false,
      };
    }
    if (error.code === 'rate_limited') {
      return {
        kind: 'other',
        message: t('admin.integrations.errors.rateLimited'),
        fromApi: false,
      };
    }
  }
  return describeError(error, t);
}

export const GMAIL_RESULT_KEY = (result: GmailOauthResult): MessageKey =>
  `admin.integrations.gmail.result.${result}`;
