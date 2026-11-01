import {
  INTEGRATION_CATALOG,
  INTEGRATION_KEYS,
  type ChannelAccount,
  type CredentialFieldStatus,
  type GmailConnectionStatus,
  type IntegrationKey,
  type IntegrationList,
  type IntegrationStatus,
  integrationFields,
  isIntegrationComplete,
} from '@watchtower/shared';

import { PEOPLE } from './console-fixtures';
import { uuid } from './fixtures';

const AT = '2026-11-01T03:00:00.000Z';

/**
 * One integration as `GET /v1/admin/integrations` answers: fields from the real catalog, no value
 * anywhere. `sources` says where each field's value in effect comes from (`env` wins over `db`).
 * Invented data and example.com only (N1).
 */
export function makeIntegration(
  key: IntegrationKey,
  sources: Readonly<Record<string, 'env' | 'db'>> = {},
): IntegrationStatus {
  const fields = Object.entries(integrationFields(key)).map(([field, definition]) => {
    const source: CredentialFieldStatus['source'] = sources[field] ?? 'none';
    return {
      field,
      label: definition.label,
      secret: definition.secret,
      required: definition.required,
      configured: source !== 'none',
      source,
      envVar: definition.env,
      updatedAt: source === 'db' ? AT : null,
      updatedBy: source === 'db' ? { id: PEOPLE.mana.id, name: PEOPLE.mana.name } : null,
    };
  });
  const configured = (field: string) =>
    fields.find((entry) => entry.field === field)?.configured === true;
  const status = isIntegrationComplete(key, configured)
    ? ('configured' as const)
    : fields.some((entry) => entry.configured)
      ? ('partial' as const)
      : ('not_configured' as const);
  return { key, name: INTEGRATION_CATALOG[key].name, status, fields };
}

export function makeIntegrationList(
  overrides: Partial<Record<IntegrationKey, IntegrationStatus>> = {},
  testMode: IntegrationList['testMode'] = 'mock',
): IntegrationList {
  const defaults: Record<IntegrationKey, IntegrationStatus> = {
    gmail: makeIntegration('gmail', { oauthClientId: 'db', oauthClientSecret: 'db' }),
    line: makeIntegration('line', { channelId: 'db', channelSecret: 'env' }),
    discord: makeIntegration('discord'),
    github: makeIntegration('github'),
    ai: makeIntegration('ai', { anthropicApiKey: 'env' }),
    web_push: makeIntegration('web_push'),
    alerting: makeIntegration('alerting'),
  };
  return {
    testMode,
    items: INTEGRATION_KEYS.map((key) => overrides[key] ?? defaults[key]),
  };
}

export const LINE_ACCOUNT: ChannelAccount = {
  id: uuid(1300),
  type: 'line',
  name: 'Support LINE',
  health: 'unknown',
  enabled: true,
  disabledAt: null,
  createdAt: AT,
  emailAddress: null,
  webhookUrl: `https://watchtower.example.com/v1/inbound/line/${uuid(1300)}`,
  credentials: 'partial',
  notes: ['Save the channel access token before LINE can deliver messages.'],
};

export const GMAIL_ACCOUNT: ChannelAccount = {
  id: uuid(1301),
  type: 'gmail',
  name: 'Support mailbox',
  health: 'ok',
  enabled: true,
  disabledAt: null,
  createdAt: AT,
  emailAddress: 'support@example.com',
  webhookUrl: null,
  credentials: 'not_configured',
  notes: [],
};

export function makeGmailStatus(
  overrides: Partial<GmailConnectionStatus> = {},
): GmailConnectionStatus {
  return {
    oauthClientConfigured: true,
    oauthConnected: false,
    oauthMailbox: null,
    serviceAccountConfigured: false,
    effectiveMethod: null,
    needsReconnect: false,
    redirectUri: 'https://watchtower.example.com/v1/admin/integrations/gmail/oauth/callback',
    ...overrides,
  };
}

/** The routes the page reads, for `consoleApi({ overrides })` and the e2e backend. */
export const INTEGRATION_READS = {
  integrations: () => makeIntegrationList(),
  accounts: () => ({ items: [LINE_ACCOUNT, GMAIL_ACCOUNT] }),
  gmail: () => makeGmailStatus(),
};
