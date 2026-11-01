import { describe, expect, it } from 'vitest';

import { INTEGRATION_CATALOG } from './credentials.js';
import {
  DEFAULT_DISCORD_CHANNEL_MAP,
  DISCORD_SLOT_CREDENTIAL_FIELDS,
  DISCORD_WEBHOOK_SLOTS,
  DiscordChannelMapError,
  discordNotifyJobId,
  discordNotifyJobSchema,
  matchDiscordRoutes,
  parseDiscordChannelMap,
  type DiscordChannelMap,
} from './discord.js';

describe('webhook slots', () => {
  it('have one credential field each, and it is a secret that is never required', () => {
    for (const slot of DISCORD_WEBHOOK_SLOTS) {
      const field = DISCORD_SLOT_CREDENTIAL_FIELDS[slot];
      const definition = (INTEGRATION_CATALOG.discord.fields as Record<string, unknown>)[field];
      expect(definition, `${slot} -> ${field}`).toMatchObject({ secret: true, required: false });
    }
  });
});

describe('matchDiscordRoutes (fan-out)', () => {
  const map: DiscordChannelMap = {
    routes: [
      { name: 'everything', slot: 'default' },
      { name: 'urgent', slot: 'urgent', minPriority: 'P2' },
      { name: 'chat-only', slot: 'default', channels: ['line'], events: ['ticket.created'] },
    ],
  };
  const facts = (priority: 'P1' | 'P2' | 'P3' | 'P4', channel: 'gmail' | 'line' | 'portal') =>
    ({ event: 'ticket.created', priority, channel }) as const;

  it('selects every matching route and posts to a slot once', () => {
    expect(matchDiscordRoutes(map, facts('P1', 'line'))).toEqual([
      { slot: 'default', routes: ['everything', 'chat-only'] },
      { slot: 'urgent', routes: ['urgent'] },
    ]);
  });

  it('treats minPriority as "this or more urgent"', () => {
    const slots = (priority: 'P1' | 'P2' | 'P3' | 'P4') =>
      matchDiscordRoutes(map, facts(priority, 'gmail')).map((match) => match.slot);
    expect(slots('P1')).toEqual(['default', 'urgent']);
    expect(slots('P2')).toEqual(['default', 'urgent']);
    expect(slots('P3')).toEqual(['default']);
    expect(slots('P4')).toEqual(['default']);
  });

  it('returns nothing when no route matches', () => {
    const only: DiscordChannelMap = { routes: [{ name: 'p1', slot: 'urgent', minPriority: 'P1' }] };
    expect(matchDiscordRoutes(only, facts('P3', 'portal'))).toEqual([]);
  });

  it('the default map sends every new ticket to the default slot only', () => {
    expect(matchDiscordRoutes(DEFAULT_DISCORD_CHANNEL_MAP, facts('P4', 'portal'))).toEqual([
      { slot: 'default', routes: ['all-tickets'] },
    ]);
  });
});

describe('parseDiscordChannelMap', () => {
  it('parses a valid map', () => {
    const map = parseDiscordChannelMap(
      '{"routes":[{"name":"all","slot":"default"},{"name":"hot","slot":"urgent","minPriority":"P2"}]}',
    );
    expect(map.routes).toHaveLength(2);
  });

  it.each([
    ['not json', '{routes'],
    ['no routes', '{"routes":[]}'],
    ['an unknown slot', '{"routes":[{"name":"x","slot":"secret-channel"}]}'],
    [
      'a URL where a slot belongs',
      '{"routes":[{"name":"x","slot":"https://discord.com/api/webhooks/1/2"}]}',
    ],
    ['a bad priority', '{"routes":[{"name":"x","slot":"default","minPriority":"P9"}]}'],
    ['an empty event list', '{"routes":[{"name":"x","slot":"default","events":[]}]}'],
  ])('refuses %s without repeating the text', (_name, text) => {
    let caught: unknown;
    try {
      parseDiscordChannelMap(text);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DiscordChannelMapError);
    expect((caught as Error).message).not.toContain('discord.com');
  });
});

describe('notify job', () => {
  const ticketId = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';

  it('has a stable job id per event and ticket, and carries ids only', () => {
    expect(discordNotifyJobId('ticket.created', ticketId)).toBe(
      `discord-ticket-created-${ticketId}`,
    );
    expect(discordNotifyJobSchema.parse({ event: 'ticket.created', ticketId })).toEqual({
      event: 'ticket.created',
      ticketId,
    });
    expect(discordNotifyJobSchema.safeParse({ event: 'ticket.created' }).success).toBe(false);
  });
});
