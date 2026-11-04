import { schema } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { replyBlockReason } from './reply-block.js';

// T-175a: whether a reply can go out is decided by the ticket's own channel account, not by "some account
// of that type is connected". Throw-away Postgres from docker compose.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
const db = () => testDb.owner.db;
let liveMail = '';
let deadMail = '';
let liveLine = '';

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  const rows = await db()
    .insert(schema.channelAccount)
    .values([
      { type: 'gmail', name: 'Live mailbox' },
      { type: 'gmail', name: 'Switched-off mailbox', disabledAt: new Date() },
      { type: 'line', name: 'Live LINE OA' },
    ])
    .returning();
  liveMail = rows.find((row) => row.name === 'Live mailbox')?.id ?? '';
  deadMail = rows.find((row) => row.name === 'Switched-off mailbox')?.id ?? '';
  liveLine = rows.find((row) => row.name === 'Live LINE OA')?.id ?? '';
});

afterAll(async () => {
  await testDb.cleanup();
});

describe('replyBlockReason', () => {
  it('lets a reply through on a connected account of the ticket', async () => {
    expect(await replyBlockReason(db(), 'gmail', liveMail)).toBeNull();
    expect(await replyBlockReason(db(), 'line', liveLine)).toBeNull();
  });

  it('blocks a ticket whose own account is switched off, even when another mailbox is connected', async () => {
    expect(await replyBlockReason(db(), 'gmail', deadMail)).toBe('channel_not_connected');
    // The earlier rule ("any gmail account is enabled") would have said null here.
    expect(await replyBlockReason(db(), 'gmail')).toBeNull();
  });

  it('blocks an account id that is not a mail account of that channel, or does not exist', async () => {
    expect(await replyBlockReason(db(), 'gmail', liveLine)).toBe('channel_not_connected');
    expect(await replyBlockReason(db(), 'gmail', '00000000-0000-4000-8000-000000000000')).toBe(
      'channel_not_connected',
    );
  });

  it('falls back to any connected account of the type when the ticket has none recorded', async () => {
    expect(await replyBlockReason(db(), 'line', null)).toBeNull();
    await db()
      .update(schema.channelAccount)
      .set({ disabledAt: new Date() })
      .where(eq(schema.channelAccount.id, liveLine));
    expect(await replyBlockReason(db(), 'line', null)).toBe('channel_not_connected');
    expect(await replyBlockReason(db(), 'line', liveLine)).toBe('channel_not_connected');
  });

  it('keeps the channel rules: nothing is delivered on a phone ticket, a portal ticket needs no account', async () => {
    expect(await replyBlockReason(db(), 'phone', liveMail)).toBe('no_outbound_channel');
    expect(await replyBlockReason(db(), 'portal', null)).toBeNull();
  });
});
