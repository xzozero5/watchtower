import { describe, expect, it } from 'vitest';

import { ChannelError } from '../common/errors.js';
import { randomWebhook, randomWebhookParts } from './__fixtures__/random-webhook.js';
import { FakeDiscordTransport } from './fake.js';
import { DiscordWebhook } from './webhook.js';

const message = { content: 'hello' };

describe('FakeDiscordTransport', () => {
  it('records the final payload and the webhook id, never reports a delivery', async () => {
    const fake = new FakeDiscordTransport();
    const parts = randomWebhookParts();
    const webhook = DiscordWebhook.parse(parts.url);
    const result = await fake.execute(webhook, message);
    expect(result.delivered).toBe(false);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.payload).toEqual({ content: 'hello', allowed_mentions: { parse: [] } });
    expect(JSON.stringify(fake.sent)).not.toContain(parts.token);
    expect(fake.sent[0]?.webhookId).toBe(parts.id);
  });

  it('answers 429 with retryAfterMs when a webhook is limited, then recovers', async () => {
    let now = 1_000_000;
    const fake = new FakeDiscordTransport({ now: () => new Date(now) });
    const webhook = randomWebhook();
    fake.limitRate(webhook.id, 2, 2000);
    await fake.execute(webhook, message);
    now += 500;
    await fake.execute(webhook, message);
    now += 500;
    const error = await fake.execute(webhook, message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect((error as ChannelError).kind).toBe('rate_limited');
    expect((error as ChannelError).retryAfterMs).toBe(1000);
    expect((error as ChannelError).retryable).toBe(true);
    now += 1000;
    await expect(fake.execute(webhook, message)).resolves.toMatchObject({ delivered: false });
  });

  it('limits one webhook without affecting another', async () => {
    const fake = new FakeDiscordTransport();
    const [a, b] = [randomWebhook(), randomWebhook()];
    fake.limitRate(a.id, 1, 60_000);
    await fake.execute(a, message);
    await expect(fake.execute(a, message)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(fake.execute(b, message)).resolves.toBeDefined();
  });

  it('plays a queued failure once, and keeps only the newest maxRecorded messages', async () => {
    const fake = new FakeDiscordTransport({ maxRecorded: 2 });
    const webhook = randomWebhook();
    fake.failNext(
      new ChannelError({ provider: 'discord', operation: 'webhook.execute', kind: 'timeout' }),
    );
    await expect(fake.execute(webhook, message)).rejects.toMatchObject({ kind: 'timeout' });
    for (const content of ['a', 'b', 'c']) await fake.execute(webhook, { content });
    expect(fake.sent.map((entry) => entry.payload['content'])).toEqual(['b', 'c']);
  });
});
