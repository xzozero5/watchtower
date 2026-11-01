import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ToolLedger } from '@watchtower/ai';
import { createDbToolLedger, type DbToolLedger } from '@watchtower/domain';
import { describe, expect, it } from 'vitest';

import { disclosureFor } from './investigation.js';
import { loadStubFixtures, systemToolsAllowed } from './tool-ports.js';

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

describe('loadStubFixtures', () => {
  it('reads examples/tools, which is valid', () => {
    const dir = fileURLToPath(new URL('../../../../examples/tools', import.meta.url));
    const fixtures = loadStubFixtures(dir);
    expect(fixtures?.gcpLogs.length).toBeGreaterThan(0);
    expect(fixtures?.bigquery.length).toBeGreaterThan(0);
    expect(fixtures?.repoChanges.length).toBeGreaterThan(0);
  });

  it('registers no stub when no directory or no file is given', () => {
    expect(loadStubFixtures(undefined)).toBeUndefined();
    expect(loadStubFixtures('')).toBeUndefined();
    expect(loadStubFixtures(mkdtempSync(join(tmpdir(), 'wt-fixtures-')))).toBeUndefined();
  });

  it('refuses a file of the wrong shape instead of inventing facts (N5)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-fixtures-'));
    writeFileSync(join(dir, 'fixtures.json'), JSON.stringify({ gcpLogs: [{ keywords: [] }] }));
    expect(() => loadStubFixtures(dir)).toThrow();
  });
});

describe('systemToolsAllowed (N2, SR108 P2)', () => {
  it('in production the logs, data and repo tools need the read-only database login', () => {
    expect(systemToolsAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(
      systemToolsAllowed({ NODE_ENV: 'production', AI_READONLY_DATABASE_URL: 'postgres://ai@db/x' }),
    ).toBe(true);
  });

  it('outside production the code alone keeps them read-only, for a local mock run', () => {
    expect(systemToolsAllowed({ NODE_ENV: 'development' })).toBe(true);
    expect(systemToolsAllowed({ NODE_ENV: 'test' })).toBe(true);
  });
});
