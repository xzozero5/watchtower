import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addOrg, addStaff, startDomainTest, type DomainTestEnv } from '../testing/support.js';
import { GOLDEN_EXAMPLES_MAX, goldenExamplesFor } from './golden.js';

// T-302a: which golden answers the drafter gets for a new draft.
let env: DomainTestEnv;
let userId: string;
let orgId: string;
let intentA: string;
let intentB: string;

beforeAll(async () => {
  env = await startDomainTest();
  const lead = await addStaff(env, 'lead');
  userId = lead.id;
  orgId = (await addOrg(env)).id;
  const intents = await env.db.owner.db
    .insert(schema.intent)
    .values([
      { key: `golden_a_${randomUUID().slice(0, 6)}`, name: 'A' },
      { key: `golden_b_${randomUUID().slice(0, 6)}`, name: 'B' },
    ])
    .returning({ id: schema.intent.id });
  intentA = intents[0]?.id ?? '';
  intentB = intents[1]?.id ?? '';
});
afterAll(async () => {
  await env.close();
});

async function golden(
  intentId: string,
  text: string,
  language: 'th' | 'en',
  createdAt: Date,
): Promise<string> {
  const db = env.db.owner.db;
  const [ticket] = await db
    .insert(schema.ticket)
    .values({ orgId, subject: 'Probe' })
    .returning({ id: schema.ticket.id });
  const [message] = await db
    .insert(schema.message)
    .values({
      ticketId: ticket?.id ?? '',
      direction: 'outbound',
      visibility: 'public',
      bodyText: 'x',
    })
    .returning({ id: schema.message.id });
  const [row] = await db
    .insert(schema.goldenAnswer)
    .values({
      ticketId: ticket?.id ?? '',
      messageId: message?.id ?? '',
      intentId,
      bodyRedacted: text,
      language,
      createdBy: userId,
      createdAt,
    })
    .returning({ id: schema.goldenAnswer.id });
  return row?.id ?? '';
}

describe('goldenExamplesFor', () => {
  it('returns the same intent only, the customer language first, then the newest, at most three', async () => {
    const day = (n: number) => new Date(Date.UTC(2026, 0, n));
    await golden(intentA, 'en old', 'en', day(1));
    await golden(intentA, 'th mid', 'th', day(2));
    await golden(intentA, 'en new', 'en', day(3));
    await golden(intentA, 'en newer', 'en', day(4));
    await golden(intentA, 'en newest', 'en', day(5));
    await golden(intentB, 'other intent', 'en', day(6));

    const english = await goldenExamplesFor(env.database.db, intentA, 'en');
    expect(english.map((item) => item.text)).toEqual(['en newest', 'en newer', 'en new']);
    expect(english.length).toBeLessThanOrEqual(GOLDEN_EXAMPLES_MAX);

    const thai = await goldenExamplesFor(env.database.db, intentA, 'th');
    expect(thai.map((item) => item.text)).toEqual(['th mid', 'en newest', 'en newer']);

    expect((await goldenExamplesFor(env.database.db, intentB, 'en')).map((i) => i.text)).toEqual([
      'other intent',
    ]);
  });

  it('never returns a deleted answer', async () => {
    const id = await golden(intentB, 'to be removed', 'en', new Date(Date.UTC(2026, 0, 20)));
    await env.db.owner.db
      .update(schema.goldenAnswer)
      .set({ deletedAt: new Date(), deletedBy: userId })
      .where(eq(schema.goldenAnswer.id, id));
    const texts = (await goldenExamplesFor(env.database.db, intentB, 'en')).map((i) => i.text);
    expect(texts).not.toContain('to be removed');
  });
});
