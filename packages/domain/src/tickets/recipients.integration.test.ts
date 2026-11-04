import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPolicyGate } from '../autonomy/gate.js';
import { DomainError } from '../errors.js';
import {
  addOrg,
  addPolicy,
  addStaff,
  auditRows,
  startDomainTest,
  type DomainTestEnv,
} from '../testing/support.js';

let env: DomainTestEnv;
let gmailId: string;

beforeAll(async () => {
  env = await startDomainTest();
  await addPolicy(
    env,
    { P3: { first_response_min: 60, resolution_min: 240, calendar: '24x7' } },
    'standard',
  );
  const [account] = await env.db.owner.db
    .insert(schema.channelAccount)
    .values({ type: 'gmail', name: 'Support mailbox' })
    .returning();
  gmailId = account?.id ?? '';
});
afterAll(async () => {
  await env.close();
});

async function emailTicket() {
  const domain = `customer-${randomUUID().slice(0, 8)}.example`;
  const org = await addOrg(env, { domains: [domain] });
  const staff = await addStaff(env);
  const { value } = await env.tx((tx) =>
    env.domain.tickets.create(tx, env.ctx(staff.actor), {
      orgId: org.id,
      subject: 'Printer',
      body: 'help',
      channel: 'gmail',
      channelAccountId: gmailId,
      requester: { email: `ann@${domain}`, name: 'Ann' },
    }),
  );
  return { ticket: value.ticket, staff, domain };
}

function reply(
  staff: { id: string; actor: Parameters<typeof env.ctx>[0] },
  ref: string,
  email: Record<string, unknown>,
) {
  return env.tx((tx) =>
    env.domain.tickets.reply(
      tx,
      env.ctx(staff.actor, { policyGate: createPolicyGate({ db: env.database.db }) }),
      {
        ref,
        sender: { kind: 'staff', userId: staff.id },
        reply: {
          body: 'We are on it.',
          email: { cc: [], bcc: [], inline: [], ...email },
        },
      },
    ),
  );
}

describe('email reply recipients (T-171 C-2)', () => {
  it('sends to the customer organization domain and to colleagues without asking, and audits who got it', async () => {
    const { ticket, staff, domain } = await emailTicket();
    const [self] = await env.db.owner.db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, staff.id));
    const colleague = `lead@${(self?.email ?? '').split('@')[1] ?? 'example.test'}`;
    await reply(staff, ticket.id, {
      to: [{ address: `Ann@${domain.toUpperCase()}` }],
      cc: [{ address: `bob@${domain}` }, { address: colleague }],
    });
    const [row] = (await auditRows(env, 'ticket.reply')).slice(-1);
    expect(row?.metadata).toMatchObject({
      // Counts and domains, never the addresses (T-171a C-4).
      recipients: { to: 1, cc: 2, bcc: 0 },
      externalDomains: [],
      externalConfirmed: false,
    });
    expect(JSON.stringify(row?.metadata)).not.toContain('ann@');
    expect(JSON.stringify(row?.metadata)).not.toContain('bob@');
    expect(row?.metadata).toHaveProperty('messageId');
  });

  it('refuses a domain the customer is not linked to until it is confirmed, and says which', async () => {
    const { ticket, staff, domain } = await emailTicket();
    const attempt = reply(staff, ticket.id, {
      to: [{ address: `ann@${domain}` }],
      bcc: [{ address: 'someone@stranger.test' }],
    });
    await expect(attempt).rejects.toBeInstanceOf(DomainError);
    await expect(attempt).rejects.toMatchObject({
      code: 'external_recipients',
      details: { domains: ['stranger.test'] },
    });
    // Nothing was written: no message, no audit row for this ticket.
    const messages = await env.db.owner.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticket.id));
    expect(messages.filter((m) => m.direction === 'outbound')).toHaveLength(0);
  });

  it('sends after a confirmation and records the external domains in the audit log', async () => {
    const { ticket, staff, domain } = await emailTicket();
    await reply(staff, ticket.id, {
      to: [{ address: `ann@${domain}` }],
      cc: [{ address: 'partner@vendor.test' }],
      confirmedDomains: ['vendor.test'],
    });
    const [row] = (await auditRows(env, 'ticket.reply')).slice(-1);
    expect(row?.metadata).toMatchObject({
      externalDomains: ['vendor.test'],
      externalConfirmed: true,
    });
  });

  it('wants every external domain named, not a blanket yes (T-171a C-6)', async () => {
    const { ticket, staff, domain } = await emailTicket();
    const attempt = reply(staff, ticket.id, {
      to: [{ address: `ann@${domain}` }],
      cc: [{ address: 'a@vendor.test' }, { address: 'b@other.test' }],
      confirmedDomains: ['VENDOR.test'],
    });
    await expect(attempt).rejects.toMatchObject({
      code: 'external_recipients',
      details: { domains: ['other.test'] },
    });
  });

  it('matches a free mail provider by the whole address, and audits only its domain (T-171a C-3, C-4)', async () => {
    const { ticket, staff } = await emailTicket();
    await env.db.owner.db
      .update(schema.contact)
      .set({ emails: [`pat@gmail.com`] })
      .where(eq(schema.contact.orgId, ticket.orgId));
    // The contact's own address is known; any other gmail.com address is a stranger.
    await reply(staff, ticket.id, { to: [{ address: 'Pat@gmail.com' }] });
    const attempt = reply(staff, ticket.id, { to: [{ address: 'mallory@gmail.com' }] });
    await expect(attempt).rejects.toMatchObject({
      code: 'external_recipients',
      details: { domains: ['mallory@gmail.com'] },
    });
    await reply(staff, ticket.id, {
      to: [{ address: 'mallory@gmail.com' }],
      confirmedDomains: ['mallory@gmail.com'],
    });
    const [row] = (await auditRows(env, 'ticket.reply')).slice(-1);
    expect(row?.metadata).toMatchObject({
      externalDomains: ['gmail.com'],
      externalConfirmed: true,
    });
    expect(JSON.stringify(row?.metadata)).not.toContain('mallory');
  });

  it('does not learn a domain from the Cc of a mail that came in (T-171a C-3)', async () => {
    const { ticket, staff, domain } = await emailTicket();
    await env.db.owner.db.insert(schema.message).values({
      ticketId: ticket.id,
      direction: 'inbound',
      bodyText: 'please cc my friend',
      visibility: 'public',
      deliveryStatus: 'delivered',
      emailMeta: {
        from: { address: `ann@${domain}` },
        to: [],
        cc: [{ address: 'friend@stranger.test' }],
        bcc: [],
      },
    });
    await expect(
      reply(staff, ticket.id, { to: [{ address: 'friend@stranger.test' }] }),
    ).rejects.toMatchObject({
      code: 'external_recipients',
      details: { domains: ['stranger.test'] },
    });
  });

  it('does not ask when no recipient was typed (the default is the requester)', async () => {
    const { ticket, staff } = await emailTicket();
    await reply(staff, ticket.id, {});
  });
});
