import { describe, expect, it } from 'vitest';

import { INTEGRATION_CATALOG, isIntegrationComplete, integrationFields } from './credentials.js';
import {
  GMAIL_OAUTH_RESULTS,
  chooseGmailMethod,
  gmailOauthStartSchema,
  type GmailFieldPresence,
} from './gmail.js';

const OAUTH_FIELDS = INTEGRATION_CATALOG.gmail.alternatives.oauth;
const DELEGATION_FIELDS = INTEGRATION_CATALOG.gmail.alternatives.service_account;

function presence(entries: Partial<Record<string, 'env' | 'db'>>): readonly GmailFieldPresence[] {
  return Object.keys(INTEGRATION_CATALOG.gmail.fields).map((field) => {
    const source = entries[field] ?? 'none';
    return { field, configured: source !== 'none', source };
  });
}
const all = (names: readonly string[], source: 'env' | 'db'): Record<string, 'env' | 'db'> =>
  Object.fromEntries(names.map((name) => [name, source]));

describe('the gmail catalog entry', () => {
  it('lists real fields in both ways, none of them required on its own', () => {
    const fields = integrationFields('gmail');
    for (const name of [...OAUTH_FIELDS, ...DELEGATION_FIELDS]) {
      expect(fields[name], name).toBeDefined();
      expect(fields[name]?.required, name).toBe(false);
    }
    // Every field belongs to exactly one way.
    expect([...OAUTH_FIELDS, ...DELEGATION_FIELDS].sort()).toEqual(Object.keys(fields).sort());
  });

  it('keeps the grant and the client secret write-only secrets, and names the mailbox as an identity', () => {
    const fields = integrationFields('gmail');
    expect(fields.oauthClientSecret?.secret).toBe(true);
    expect(fields.oauthRefreshToken?.secret).toBe(true);
    expect(fields.oauthMailbox?.secret).toBe(false);
  });
});

describe('isIntegrationComplete for an integration with alternatives', () => {
  const complete = (configured: readonly string[]): boolean =>
    isIntegrationComplete('gmail', (name) => configured.includes(name));

  it('needs every field of one way', () => {
    expect(complete([])).toBe(false);
    expect(complete([...OAUTH_FIELDS])).toBe(true);
    expect(complete([...DELEGATION_FIELDS])).toBe(true);
    expect(complete(OAUTH_FIELDS.slice(1))).toBe(false);
    expect(complete([OAUTH_FIELDS[0], DELEGATION_FIELDS[0]])).toBe(false);
  });

  it('still uses `required` for the others', () => {
    expect(isIntegrationComplete('line', () => false)).toBe(false);
    expect(isIntegrationComplete('line', () => true)).toBe(true);
  });
});

describe('chooseGmailMethod', () => {
  it('is null while neither way is complete', () => {
    expect(chooseGmailMethod(presence({}))).toBeNull();
    expect(
      chooseGmailMethod(presence({ oauthClientId: 'db', oauthClientSecret: 'db' })),
    ).toBeNull();
    expect(chooseGmailMethod(presence({ serviceAccountJson: 'db' }))).toBeNull();
  });

  it('takes the only complete way', () => {
    expect(chooseGmailMethod(presence(all(OAUTH_FIELDS, 'db')))).toBe('oauth');
    expect(chooseGmailMethod(presence(all(DELEGATION_FIELDS, 'db')))).toBe('service_account');
    expect(chooseGmailMethod(presence(all(OAUTH_FIELDS, 'env')))).toBe('oauth');
    expect(chooseGmailMethod(presence(all(DELEGATION_FIELDS, 'env')))).toBe('service_account');
  });

  it('prefers OAuth when both are complete and neither (or both) is set by the environment', () => {
    expect(
      chooseGmailMethod(presence({ ...all(OAUTH_FIELDS, 'db'), ...all(DELEGATION_FIELDS, 'db') })),
    ).toBe('oauth');
    expect(
      chooseGmailMethod(
        presence({ ...all(OAUTH_FIELDS, 'env'), ...all(DELEGATION_FIELDS, 'env') }),
      ),
    ).toBe('oauth');
  });

  it('lets the environment beat the database in both directions', () => {
    expect(
      chooseGmailMethod(presence({ ...all(OAUTH_FIELDS, 'db'), ...all(DELEGATION_FIELDS, 'env') })),
    ).toBe('service_account');
    expect(
      chooseGmailMethod(presence({ ...all(OAUTH_FIELDS, 'env'), ...all(DELEGATION_FIELDS, 'db') })),
    ).toBe('oauth');
  });

  it('does not let one stray environment variable make a half-saved way "the operator\'s"', () => {
    // GMAIL_IMPERSONATE_USER in the environment, the key saved in the database, OAuth connected.
    expect(
      chooseGmailMethod(
        presence({
          ...all(OAUTH_FIELDS, 'db'),
          ...all(DELEGATION_FIELDS, 'db'),
          impersonateUser: 'env',
        }),
      ),
    ).toBe('oauth');
    // The client in the environment and the grant in the database is still a normal OAuth setup:
    // it does not stop a whole delegation set by the environment from winning, and does not beat it.
    expect(
      chooseGmailMethod(
        presence({
          ...all(OAUTH_FIELDS, 'db'),
          oauthClientId: 'env',
          oauthClientSecret: 'env',
          ...all(DELEGATION_FIELDS, 'env'),
        }),
      ),
    ).toBe('service_account');
  });
});

describe('OAuth HTTP schemas', () => {
  it('normalises the mailbox and refuses anything that is not an address', () => {
    expect(gmailOauthStartSchema.parse({ mailbox: '  Support@Example.COM ' }).mailbox).toBe(
      'support@example.com',
    );
    for (const mailbox of ['', 'x', 'a@b', 'a b@example.com', 5]) {
      expect(gmailOauthStartSchema.safeParse({ mailbox }).success, String(mailbox)).toBe(false);
    }
    expect(gmailOauthStartSchema.safeParse({}).success).toBe(false);
  });

  it('has a distinct result code for every refusal the callback can make', () => {
    expect(new Set(GMAIL_OAUTH_RESULTS).size).toBe(GMAIL_OAUTH_RESULTS.length);
    expect(GMAIL_OAUTH_RESULTS).toEqual(
      expect.arrayContaining(['connected', 'state_invalid', 'scope_mismatch', 'mailbox_mismatch']),
    );
  });
});
