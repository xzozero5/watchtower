import type { CredentialStore, ResolvedField } from '@watchtower/db';
import { INTEGRATION_CATALOG, type IntegrationStatus } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { gmailCredentialSource } from './index.js';
import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';

// Which way the worker reaches the mailbox, from where each credential field comes from (ADR-004:
// the environment beats the database). The store here is a script; no value is real.
const FIELDS = Object.keys(INTEGRATION_CATALOG.gmail.fields);
const VALUES: Record<string, string> = {
  serviceAccountJson: '{"client_email":"x"}',
  impersonateUser: 'support@example.com',
  oauthClientId: 'client-id',
  oauthClientSecret: 'client-secret',
  oauthRefreshToken: 'refresh-token',
  oauthMailbox: 'support@example.com',
};

function store(sources: Partial<Record<string, 'env' | 'db'>>): CredentialStore {
  const status: IntegrationStatus = {
    key: 'gmail',
    name: 'Gmail',
    status: 'partial',
    fields: FIELDS.map((field) => ({
      field,
      label: field,
      secret: true,
      required: false,
      configured: sources[field] !== undefined,
      source: sources[field] ?? 'none',
      envVar: field,
      updatedAt: null,
      updatedBy: null,
    })),
  };
  return {
    status: () => Promise.resolve([status]),
    resolve: () =>
      Promise.resolve(
        Object.fromEntries(
          FIELDS.flatMap((field): [string, ResolvedField][] => {
            const source = sources[field];
            const value = VALUES[field];
            return source === undefined || value === undefined ? [] : [[field, { value, source }]];
          }),
        ),
      ),
  } as unknown as CredentialStore;
}

const OAUTH = ['oauthClientId', 'oauthClientSecret', 'oauthRefreshToken', 'oauthMailbox'];
const DELEGATION = ['serviceAccountJson', 'impersonateUser'];
const from = (names: readonly string[], source: 'env' | 'db') =>
  Object.fromEntries(names.map((name) => [name, source])) as Record<string, 'env' | 'db'>;

describe('gmailCredentialSource', () => {
  it('is not configured until one way is complete', async () => {
    expect(await gmailCredentialSource(store({})).configured()).toBe(false);
    expect(await gmailCredentialSource(store(from(OAUTH.slice(0, 3), 'db'))).configured()).toBe(
      false,
    );
    expect(await gmailCredentialSource(store(from(OAUTH, 'db'))).configured()).toBe(true);
    expect(await gmailCredentialSource(store(from(DELEGATION, 'db'))).configured()).toBe(true);
  });

  it('reads the OAuth credential, with the mailbox the grant belongs to', async () => {
    expect(await gmailCredentialSource(store(from(OAUTH, 'db'))).read()).toEqual({
      method: 'oauth',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      mailbox: 'support@example.com',
    });
  });

  it('reads the service-account credential when that is the only way', async () => {
    expect(await gmailCredentialSource(store(from(DELEGATION, 'db'))).read()).toEqual({
      method: 'service_account',
      serviceAccountJson: VALUES.serviceAccountJson,
      impersonateUser: VALUES.impersonateUser,
    });
  });

  it('uses OAuth when both are complete in the database, and logs that both exist without a value', async () => {
    const lines: string[] = [];
    const logger = createLogger(testConfig({ LOG_LEVEL: 'trace' }), {
      write: (chunk: string) => {
        lines.push(chunk);
      },
    });
    const source = gmailCredentialSource(
      store({ ...from(OAUTH, 'db'), ...from(DELEGATION, 'db') }),
      logger,
    );
    expect((await source.read()).method).toBe('oauth');
    await source.read();
    expect(lines).toHaveLength(1); // once, not at every refresh
    for (const value of Object.values(VALUES)) expect(lines.join('')).not.toContain(value);
  });

  it('lets an environment-set way beat a database-saved one, either way round', async () => {
    expect(
      (
        await gmailCredentialSource(
          store({ ...from(OAUTH, 'db'), ...from(DELEGATION, 'env') }),
        ).read()
      ).method,
    ).toBe('service_account');
    expect(
      (
        await gmailCredentialSource(
          store({ ...from(OAUTH, 'env'), ...from(DELEGATION, 'db') }),
        ).read()
      ).method,
    ).toBe('oauth');
  });

  it('refuses to read an incomplete integration', async () => {
    await expect(gmailCredentialSource(store({})).read()).rejects.toThrow(/incomplete/);
  });
});
