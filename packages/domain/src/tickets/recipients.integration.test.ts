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
        } as never,
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
      recipients: {
        to: [`ann@${domain}`],
        cc: [`bob@${domain}`, colleague.toLowerCase()],
        bcc: [],
      },
      externalDomains: [],
      externalConfirmed: false,
    });
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
      confirmExternalRecipients: true,
    });
    const [row] = (await auditRows(env, 'ticket.reply')).slice(-1);
    expect(row?.metadata).toMatchObject({
      externalDomains: ['vendor.test'],
      externalConfirmed: true,
    });
    // The confirmed domain is now part of this ticket's conversation: no second question.
    await reply(staff, ticket.id, { to: [{ address: 'partner@vendor.test' }] });
  });

  it('does not ask when no recipient was typed (the default is the requester)', async () => {
    const { ticket, staff, domain } = await emailTicket();
    await reply(staff, ticket.id, {});
  });
});
