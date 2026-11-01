import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { randomWebhookParts } from './__fixtures__/random-webhook.js';
import { DiscordWebhook, DiscordWebhookUrlError } from './webhook.js';

const parts = randomWebhookParts();

function reasonOf(value: string): string | undefined {
  try {
    DiscordWebhook.parse(value);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(DiscordWebhookUrlError);
    const failure = error as DiscordWebhookUrlError;
    // The error names the rule, never the input.
    expect(failure.message).not.toContain(parts.token);
    return failure.reason;
  }
}

describe('DiscordWebhook.parse (the only destination is discord.com)', () => {
  it('accepts the canonical URL, a versioned path and surrounding whitespace', () => {
    expect(DiscordWebhook.parse(parts.url).id).toBe(parts.id);
    expect(
      DiscordWebhook.parse(`https://discord.com/api/v10/webhooks/${parts.id}/${parts.token}`).id,
    ).toBe(parts.id);
    expect(DiscordWebhook.parse(`  ${parts.url}\n`).id).toBe(parts.id);
    expect(
      DiscordWebhook.parse(`https://DISCORD.com:443/api/webhooks/${parts.id}/${parts.token}`).id,
    ).toBe(parts.id);
  });

  it.each([
    ['http scheme', `http://discord.com/api/webhooks/${parts.id}/${parts.token}`, 'not_https'],
    [
      'the legacy host',
      `https://discordapp.com/api/webhooks/${parts.id}/${parts.token}`,
      'host_not_allowed',
    ],
    [
      'a subdomain',
      `https://canary.discord.com/api/webhooks/${parts.id}/${parts.token}`,
      'host_not_allowed',
    ],
    [
      'a look-alike suffix',
      `https://discord.com.evil.example/api/webhooks/${parts.id}/${parts.token}`,
      'host_not_allowed',
    ],
    [
      'the real host as userinfo',
      `https://discord.com@evil.example/api/webhooks/${parts.id}/${parts.token}`,
      'credentials_in_url',
    ],
    [
      'credentials in the URL',
      `https://user:pw@discord.com/api/webhooks/${parts.id}/${parts.token}`,
      'credentials_in_url',
    ],
    [
      'a Unicode look-alike host',
      `https://dіscord.com/api/webhooks/${parts.id}/${parts.token}`,
      'host_not_allowed',
    ],
    [
      'a trailing dot host',
      `https://discord.com./api/webhooks/${parts.id}/${parts.token}`,
      'host_not_allowed',
    ],
    ['loopback', `https://127.0.0.1/api/webhooks/${parts.id}/${parts.token}`, 'host_not_allowed'],
    [
      'an internal metadata address',
      `https://169.254.169.254/api/webhooks/${parts.id}/${parts.token}`,
      'host_not_allowed',
    ],
    [
      'a port',
      `https://discord.com:8443/api/webhooks/${parts.id}/${parts.token}`,
      'port_not_allowed',
    ],
    ['a query string', `${parts.url}?thread_id=1`, 'query_not_allowed'],
    ['a fragment', `${parts.url}#x`, 'query_not_allowed'],
    [
      'another path',
      `https://discord.com/api/channels/${parts.id}/${parts.token}`,
      'path_not_a_webhook',
    ],
    [
      'a path traversal',
      `https://discord.com/api/webhooks/${parts.id}/../${parts.token}`,
      'path_not_a_webhook',
    ],
    [
      'a non-numeric id',
      `https://discord.com/api/webhooks/abc/${parts.token}`,
      'path_not_a_webhook',
    ],
    ['a trailing path', `${parts.url}/extra`, 'path_not_a_webhook'],
    ['text', 'not a url', 'not_a_url'],
    ['empty', '', 'not_a_url'],
  ])('refuses %s', (_name, value, reason) => {
    expect(reasonOf(value)).toBe(reason);
  });

  it('tryParse returns undefined instead of throwing', () => {
    expect(DiscordWebhook.tryParse('nope')).toBeUndefined();
    expect(DiscordWebhook.tryParse(parts.url)?.id).toBe(parts.id);
  });
});

describe('DiscordWebhook never prints its token (N1)', () => {
  const webhook = DiscordWebhook.parse(parts.url);

  it('is redacted in String, JSON, template literals and util.inspect', () => {
    const shown = [
      String(webhook),
      webhook.toString(),
      JSON.stringify({ webhook }),
      inspect(webhook, { depth: 5 }),
      inspect({ nested: [webhook] }, { depth: 5 }),
      JSON.stringify(Object.entries(webhook)),
    ].join('\n');
    expect(shown).not.toContain(parts.token);
    expect(shown).toContain(`discord-webhook:${parts.id}`);
  });

  it('builds the execute URL on discord.com with wait=true', () => {
    expect(webhook.executeUrl()).toBe(`${parts.url}?wait=true`);
  });
});
