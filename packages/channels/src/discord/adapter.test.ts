import { describe, expect, it } from 'vitest';

import { channelCapabilitiesSchema } from '../common/adapter.js';
import { randomWebhook } from './__fixtures__/random-webhook.js';
import { DISCORD_CAPABILITIES, DiscordAdapter } from './adapter.js';
import { FakeDiscordTransport } from './fake.js';

describe('DiscordAdapter', () => {
  const fake = new FakeDiscordTransport();
  const adapter = new DiscordAdapter({ transport: fake });

  it('declares a send-only channel that satisfies the shared capabilities schema', () => {
    expect(channelCapabilitiesSchema.parse(adapter.capabilities())).toEqual(DISCORD_CAPABILITIES);
    expect(DISCORD_CAPABILITIES).toMatchObject({ receive: false, send: true, markRead: false });
  });

  it('sends through the transport and exposes whether it is a fake', async () => {
    expect(adapter.transportKind).toBe('fake');
    const result = await adapter.send({ webhook: randomWebhook(), message: { content: 'hi' } });
    expect(result.delivered).toBe(false);
    expect(fake.sent).toHaveLength(1);
  });

  it('rejects ingest and markRead as unsupported', async () => {
    await expect(adapter.ingest()).rejects.toMatchObject({
      kind: 'unsupported',
      provider: 'discord',
    });
    await expect(adapter.markRead()).rejects.toMatchObject({ kind: 'unsupported' });
  });
});
