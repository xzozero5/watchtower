import { describe, expect, it } from 'vitest';

import { buildPayload, buildTicketCreatedMessage, discordWebhookMessageSchema } from './message.js';

const at = new Date('2030-01-01T00:00:00.000Z');

describe('buildTicketCreatedMessage', () => {
  it('has the ticket key, priority as text, channel and a link, and nothing else', () => {
    const message = buildTicketCreatedMessage({
      ticketKey: 'OPS-42',
      priority: 'P1',
      channel: 'gmail',
      link: 'https://desk.example.test/tickets/OPS-42',
      at,
    });
    const embed = message.embeds?.[0];
    expect(embed?.title).toBe('New ticket OPS-42');
    expect(embed?.url).toBe('https://desk.example.test/tickets/OPS-42');
    expect(embed?.fields).toEqual([
      { name: 'Priority', value: 'P1 (critical)', inline: true },
      { name: 'Channel', value: 'gmail', inline: true },
    ]);
    expect(message.content).toBeUndefined();
    // No subject, customer or body fields exist to be filled.
    expect(Object.keys(embed ?? {}).sort()).toEqual([
      'color',
      'fields',
      'timestamp',
      'title',
      'url',
    ]);
  });

  it('leaves the link out when it is missing or not an http(s) URL', () => {
    for (const link of [undefined, 'javascript:alert(1)', 'not a url']) {
      const message = buildTicketCreatedMessage({
        ticketKey: 'OPS-1',
        priority: 'P3',
        channel: 'line',
        link,
        at,
      });
      expect(message.embeds?.[0]?.url).toBeUndefined();
    }
  });

  it('refuses a ticket key that is not shaped like one, so free text cannot ride in the title', () => {
    for (const ticketKey of ['@everyone', 'Reset my password', 'OPS-1\nhello', 'OPS-']) {
      expect(() =>
        buildTicketCreatedMessage({ ticketKey, priority: 'P3', channel: 'portal', at }),
      ).toThrow();
    }
  });
});

describe('buildPayload', () => {
  it('always adds allowed_mentions with an empty parse list, so nothing can ping anyone', () => {
    const payload = buildPayload({ content: 'hello @everyone <@&123>' });
    expect(payload).toEqual({
      content: 'hello @everyone <@&123>',
      allowed_mentions: { parse: [] },
    });
  });

  it('cannot be given its own allowed_mentions (strict schema)', () => {
    expect(
      discordWebhookMessageSchema.safeParse({
        content: 'x',
        allowed_mentions: { parse: ['everyone'] },
      }).success,
    ).toBe(false);
  });
});

describe('discordWebhookMessageSchema limits', () => {
  it('accepts the documented maxima and refuses one over', () => {
    expect(discordWebhookMessageSchema.safeParse({ content: 'x'.repeat(2000) }).success).toBe(true);
    expect(discordWebhookMessageSchema.safeParse({ content: 'x'.repeat(2001) }).success).toBe(
      false,
    );
    expect(
      discordWebhookMessageSchema.safeParse({
        embeds: [{ description: 'a'.repeat(3000) }, { description: 'b'.repeat(3000) }],
      }).success,
    ).toBe(true);
    expect(
      discordWebhookMessageSchema.safeParse({
        embeds: [{ description: 'a'.repeat(3000) }, { description: 'b'.repeat(3001) }],
      }).success,
    ).toBe(false);
    expect(discordWebhookMessageSchema.safeParse({}).success).toBe(false);
  });
});
