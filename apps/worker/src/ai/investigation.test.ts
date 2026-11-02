import type { ToolLedger } from '@watchtower/ai';
import { createDbToolLedger, type DbToolLedger } from '@watchtower/domain';
import { describe, expect, it } from 'vitest';

import { testConfig } from '../testing/support.js';
import { disclosureFor } from './investigation.js';
import { systemToolsAllowed } from './tool-ports.js';

describe('disclosureFor (PRD section 6.6, po decision 26)', () => {
  const now = new Date();
  it('treats a LINE ticket as verified only when the LINE identity is, whatever the contact says', () => {
    expect(disclosureFor('line', { verifiedAt: now, lineVerifiedAt: null })).toBe('restricted');
    expect(disclosureFor('line', { verifiedAt: null, lineVerifiedAt: now })).toBe('verified');
    expect(disclosureFor('line', { verifiedAt: now, lineVerifiedAt: now })).toBe('verified');
  });

  it('treats any other channel as verified when the contact is, and a LINE link does not count', () => {
    for (const channel of ['gmail', 'portal', 'email']) {
      expect(disclosureFor(channel, { verifiedAt: now, lineVerifiedAt: null })).toBe('verified');
      expect(disclosureFor(channel, { verifiedAt: null, lineVerifiedAt: now })).toBe('restricted');
    }
  });

  it('restricts a ticket with no requester', () => {
    expect(disclosureFor('gmail', undefined)).toBe('restricted');
    expect(disclosureFor('line', undefined)).toBe('restricted');
  });
});

describe('the ledger of the domain fits the port of the AI package', () => {
  it('is assignable both ways at compile time', () => {
    // `packages/domain` may not import `@watchtower/ai`, so this is where the two shapes meet.
    const asPort = (ledger: DbToolLedger): ToolLedger => ledger;
    const asDomain = (ledger: ToolLedger): DbToolLedger => ledger;
    expect(typeof asPort).toBe('function');
    expect(typeof asDomain).toBe('function');
    expect(typeof createDbToolLedger).toBe('function');
  });
});

describe('systemToolsAllowed (N2, SR108 P2)', () => {
  it('needs the read-only database login, or an explicit opt-in, whatever NODE_ENV is', () => {
    expect(systemToolsAllowed({ AI_TOOLS_WITHOUT_READONLY_LOGIN: false })).toBe(false);
    expect(
      systemToolsAllowed({
        AI_READONLY_DATABASE_URL: 'postgres://ai@db/x',
        AI_TOOLS_WITHOUT_READONLY_LOGIN: false,
      }),
    ).toBe(true);
    expect(systemToolsAllowed({ AI_TOOLS_WITHOUT_READONLY_LOGIN: true })).toBe(true);
  });

  it('is off by default in the worker config, also when NODE_ENV is development', () => {
    const config = testConfig({ NODE_ENV: 'development' });
    expect(config.AI_TOOLS_WITHOUT_READONLY_LOGIN).toBe(false);
    expect(systemToolsAllowed(config)).toBe(false);
    expect(systemToolsAllowed(testConfig({ AI_TOOLS_WITHOUT_READONLY_LOGIN: 'true' }))).toBe(true);
  });
});
