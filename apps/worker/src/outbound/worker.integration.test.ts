import { randomBytes, randomUUID } from 'node:crypto';

import { gmail } from '@watchtower/channels';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, createPolicyGate, type Domain } from '@watchtower/domain';
import { OUTBOUND_JOBS, QUEUE_NAMES, parseRedisUrl } from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { disableNetConnect } from '@watchtower/shared/testing';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { startWorker, type RunningWorker } from '../worker.js';
import type { OutboundChannels } from './channels.js';

// The whole path: a reply is scheduled with a one-second hold, the outbox relay holds the trigger
// back until then, BullMQ hands it to the dispatcher, and the in-memory Gmail receives one mail.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const prefix = `wt-outbound-${randomBytes(4).toString('hex')}`;
const net = disableNetConnect();

let testDb: TestDatabase;
let worker: RunningWorker;
let database: Database;
let domain: Domain;
let config: ReturnType<typeof testConfig>;
let fake: gmail.FakeGmailTransport;
let gmailId: string;

const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  config = {
    ...testConfig({ DATABASE_URL: testDb.appUrl, OUTBOX_POLL_INTERVAL_MS: '100' }),
    listenPort: 0,
  };
  database = createDatabase({ url: testDb.appUrl, max: 4, applicationName: 'wt-outbound-api' });
  // What the api builds: same prefix, same seal key, the real gate.
  domain = createDomain({
    ticketKeyPrefix: config.TICKET_KEY_PREFIX,
    sealKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret),
    policyGate: createPolicyGate({ db: database.db }),
  });
  fake = new gmail.FakeGmailTransport();
  const adapter = new gmail.GmailAdapter({ transport: fake });
  const channels: OutboundChannels = {
    gmail: () => ({
      from: { address: 'support@desk.example.test', name: 'Support' },
      send: (input) => adapter.send(input),
    }),
    line: () => undefined,
  };
  const [account] = await owner()
    .insert(schema.channelAccount)
    .values({ type: 'gmail', name: 'Support mailbox' })
    .returning({ id: schema.channelAccount.id });
  gmailId = account?.id ?? '';
  await owner().execute(
    `UPDATE instance_setting SET value = '1'::jsonb WHERE key = 'outbound.undo_send_seconds'`,
  );
  worker = await startWorker(config, createLogger(config), {
    queuePrefix: prefix,
    overrides: { outbound: { channels } },
  });
});

afterAll(async () => {
  await worker.close();
  const queue = new Queue(QUEUE_NAMES.outbound, {
    connection: parseRedisUrl(config.REDIS_URL),
    prefix,
  });
  await queue.obliterate({ force: true });
  await queue.close();
  await database.close();
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('the worker delivers a scheduled reply', () => {
  it('holds it for the undo window, sends it once, and leaves an undone one alone', async () => {
    const [org] = await owner()
      .insert(schema.organization)
      .values({ name: `Org ${randomUUID()}` })
      .returning();
    const [staff] = await owner()
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, name: 'Staff', role: 'agent' })
      .returning();
    if (org === undefined || staff === undefined) throw new Error('setup failed');

    const open = async (subject: string) => {
      const created = await database.db.transaction((tx) =>
        domain.tickets.create(tx, domain.context({ actor: { type: 'user', id: staff.id } }), {
          orgId: org.id,
          subject,
          body: 'Please help',
          requester: { email: `${randomUUID()}@customer.example.test`, name: 'Customer' },
        }),
      );
      const ticketId = created.value.ticket.id;
      await owner()
        .update(schema.ticket)
        .set({ channel: 'gmail', channelAccountId: gmailId })
        .where(eq(schema.ticket.id, ticketId));
      return ticketId;
    };
    const send = async (ticketId: string, body: string) => {
      const result = await database.db.transaction((tx) =>
        domain.tickets.reply(tx, domain.context({ actor: { type: 'user', id: staff.id } }), {
          ref: ticketId,
          reply: { body },
          sender: { kind: 'staff', userId: staff.id },
        }),
      );
      const delivery = result.value.delivery;
      if (delivery === null || delivery === undefined) throw new Error('no delivery');
      return delivery;
    };

    const keep = await send(await open('Keep'), 'Please keep me');
    const undo = await send(await open('Undo'), 'Please undo me');
    await database.db.transaction((tx) =>
      domain.outbound.cancel(tx, domain.context({ actor: { type: 'user', id: staff.id } }), {
        ref: undo.ticketId,
        deliveryId: undo.id,
        canCancelAny: false,
      }),
    );

    // Inside the window nothing has gone out.
    expect(fake.sent).toHaveLength(0);
    const sent = await waitFor('the delivery to be sent', async () => {
      const [row] = await owner()
        .select()
        .from(schema.outboundDelivery)
        .where(eq(schema.outboundDelivery.id, keep.id));
      return row?.state === 'sent' ? row : undefined;
    });
    expect(sent.sentAt?.getTime() ?? 0).toBeGreaterThanOrEqual(keep.nextAttemptAt.getTime() - 50);
    expect(fake.sent).toHaveLength(1);

    // The undone one never goes out, even after its trigger fired.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const [cancelled] = await owner()
      .select()
      .from(schema.outboundDelivery)
      .where(eq(schema.outboundDelivery.id, undo.id));
    expect(cancelled?.state).toBe('cancelled');
    expect(fake.sent).toHaveLength(1);
  });

  it('registers the repeating sweeper', async () => {
    const queue = new Queue(QUEUE_NAMES.outbound, {
      connection: parseRedisUrl(config.REDIS_URL),
      prefix,
    });
    try {
      const schedulers = await queue.getJobSchedulers();
      expect(schedulers.map((scheduler) => scheduler.key)).toContain(OUTBOUND_JOBS.sweep);
    } finally {
      await queue.close();
    }
  });
});
