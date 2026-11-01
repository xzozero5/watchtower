import { INTEGRATION_KEYS } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { ConnectionTesterRegistry, createFakeTester } from './connection-tester.js';

describe('createFakeTester', () => {
  it('needs the required fields and nothing else, and names the missing ones by label', async () => {
    const tester = createFakeTester('line');
    expect(await tester.fake({})).toMatchObject({ ok: false, identity: null });
    expect((await tester.fake({ channelSecret: 'x' })).message).toBe(
      'Missing: Channel ID, Channel access token.',
    );
    expect(
      await tester.fake({ channelId: '1', channelSecret: 'x', channelAccessToken: 'y' }),
    ).toMatchObject({ ok: true, identity: 'mock:line' });
  });

  it('never repeats a value in its message', async () => {
    const tester = createFakeTester('line');
    const outcome = await tester.fake({ channelSecret: 'SECRET-VALUE-123' });
    expect(outcome.message).not.toContain('SECRET-VALUE-123');
  });

  it('can ask for any one of a set of fields', async () => {
    const tester = createFakeTester('ai', { anyOf: ['anthropicApiKey', 'vertexProjectId'] });
    expect((await tester.fake({})).message).toBe(
      'Set at least one of: Anthropic API key, Vertex project ID.',
    );
    expect((await tester.fake({ vertexProjectId: 'p' })).ok).toBe(true);
  });

  it('has no live check, so nothing can leave the machine by default', () => {
    expect('live' in createFakeTester('discord')).toBe(false);
  });
});

describe('ConnectionTesterRegistry', () => {
  it('starts with a fake for every integration, and lets an adapter replace one', async () => {
    const registry = new ConnectionTesterRegistry();
    for (const key of INTEGRATION_KEYS) expect(registry.get(key).integration).toBe(key);
    registry.register({
      integration: 'gmail',
      fake: () => ({ ok: true, identity: 'adapter fake', message: 'ok' }),
    });
    expect(await registry.get('gmail').fake({})).toMatchObject({ identity: 'adapter fake' });
  });
});
