import { schema } from '@watchtower/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import { addOrg, auditRows, startDomainTest, type DomainTestEnv } from './testing/support.js';

let env: DomainTestEnv;

beforeAll(async () => {
  env = await startDomainTest();
});
afterAll(async () => {
  await env.close();
});

const find = (orgId: string, email: string) =>
  env.tx((tx) =>
    env.domain.contacts.findOrCreateByEmail(tx, env.ctx(), { orgId, email, name: 'N' }),
  );

describe('contacts.findOrCreateByEmail', () => {
  it('creates a contact with a normalized address and one audit row without the address', async () => {
    const org = await addOrg(env);
    const result = await find(org.id, '  New.Person@Example.test ');
    expect(result.value).toMatchObject({ orgId: org.id, emails: ['new.person@example.test'] });
    expect(result.audited).toBe(true);
    expect(result.events).toEqual([]);
    const rows = (await auditRows(env, 'contact.create')).filter(
      (row) => row.targetId === result.value.id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({ via: 'find_or_create_by_email' });
    expect(JSON.stringify(rows[0])).not.toContain('new.person');
  });

  it('returns the contact that already owns the address, without auditing again', async () => {
    const org = await addOrg(env);
    const first = await find(org.id, 'same@example.test');
    const again = await find(org.id, 'SAME@example.test');
    expect(again.value.id).toBe(first.value.id);
    expect(again.audited).toBe(false);
  });

  it('refuses an address that belongs to a contact of another organization', async () => {
    const one = await addOrg(env);
    const other = await addOrg(env);
    await find(one.id, 'shared@example.test');
    await expect(find(other.id, 'shared@example.test')).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(find(other.id, 'shared@example.test')).rejects.toBeInstanceOf(DomainError);
  });

  it('two new submissions from one address at once yield one contact', async () => {
    const org = await addOrg(env);
    const results = await Promise.all([
      find(org.id, 'race@example.test'),
      find(org.id, 'race@example.test'),
    ]);
    expect(results[0].value.id).toBe(results[1].value.id);
    const rows = (await env.db.owner.db.select().from(schema.contact)).filter((row) =>
      row.emails.includes('race@example.test'),
    );
    expect(rows).toHaveLength(1);
    // Only the transaction that created it wrote the audit row.
    expect(results.filter((result) => result.audited)).toHaveLength(1);
  });
});
