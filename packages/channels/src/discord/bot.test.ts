import { randomUUID } from 'node:crypto';

import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { ChannelError } from '../common/errors.js';
import { FakeBotTransport } from './bot-fake.js';
import {
  buildAlertAckedMessage,
  buildAlertEscalationMessage,
  buildIncidentMirrorLine,
  buildIncidentOpeningMessage,
  customIds,
  incidentThreadName,
  inert,
  parseCustomId,
  type AlertChatFacts,
} from './bot-messages.js';
import { BOT_MAX_CONTENT, BOT_MAX_LABEL, parseBotMessage, toDiscordPayload } from './bot.js';
import {
  CALLBACK_TYPES,
  EPHEMERAL_FLAG,
  ephemeralReply,
  generateInteractionKeys,
  INTERACTION_TOLERANCE_SECONDS,
  interactionTimestampFresh,
  interactionSchema,
  interactionUserId,
  publicKeyFromHex,
  updateMessage,
  verifyInteractionSignature,
} from './interactions.js';

// The bot seam with no token and no network: the fake, the messages Watchtower builds (N4: nothing
// from a customer, no organization name), and the Ed25519 check of interactions with a key pair made here.
const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const facts = (overrides: Partial<AlertChatFacts> = {}): AlertChatFacts => ({
  alertId: randomUUID(),
  level: 1,
  target: 'lead',
  severity: 'critical',
  serviceName: 'Checkout',
  count: 3,
  fallback: false,
  mentionUserIds: ['123456789012345678'],
  link: 'https://watchtower.example.test/alerts/1',
  ...overrides,
});

describe('interaction signatures (Ed25519)', () => {
  const keys = generateInteractionKeys();
  const body = Buffer.from(JSON.stringify({ id: '123456789012345678', type: 1 }));
  const timestamp = '1793584800';

  it('accepts what the key pair signed and nothing else', () => {
    const signatureHex = keys.sign(timestamp, body);
    const input = { publicKeyHex: keys.publicKeyHex, signatureHex, timestamp, rawBody: body };
    expect(verifyInteractionSignature(input)).toBe(true);
    expect(verifyInteractionSignature({ ...input, rawBody: Buffer.from('{"id":"1"}') })).toBe(
      false,
    );
    expect(verifyInteractionSignature({ ...input, timestamp: '1793584801' })).toBe(false);
    expect(
      verifyInteractionSignature({
        ...input,
        publicKeyHex: generateInteractionKeys().publicKeyHex,
      }),
    ).toBe(false);
  });

  it('is false, never an exception, for anything malformed or missing', () => {
    const signatureHex = keys.sign(timestamp, body);
    const base = { publicKeyHex: keys.publicKeyHex, signatureHex, timestamp, rawBody: body };
    for (const broken of [
      { signatureHex: undefined },
      { signatureHex: 'zz'.repeat(64) },
      { signatureHex: signatureHex.slice(2) },
      { timestamp: undefined },
      { timestamp: '' },
      { rawBody: undefined },
      { publicKeyHex: 'not a key' },
      { publicKeyHex: '' },
    ]) {
      expect(verifyInteractionSignature({ ...base, ...broken })).toBe(false);
    }
    expect(publicKeyFromHex('00'.repeat(31))).toBeNull();
  });
});

describe('interaction timestamp freshness (replay)', () => {
  const now = 1_793_600_000_000;
  const at = (seconds: number): string => String(now / 1000 + seconds);

  it('accepts a timestamp inside the tolerance either way and nothing outside it', () => {
    const t = INTERACTION_TOLERANCE_SECONDS;
    expect(interactionTimestampFresh(at(0), now)).toBe(true);
    expect(interactionTimestampFresh(at(-t), now)).toBe(true);
    expect(interactionTimestampFresh(at(t), now)).toBe(true);
    expect(interactionTimestampFresh(at(-t - 1), now)).toBe(false);
    expect(interactionTimestampFresh(at(t + 1), now)).toBe(false);
    expect(interactionTimestampFresh(at(-30 * 24 * 3600), now)).toBe(false);
  });

  it('refuses a missing or odd timestamp', () => {
    for (const odd of [undefined, '', 'now', '12.5', '-5', '1e9', ' 1793600000', '9'.repeat(13)]) {
      expect(interactionTimestampFresh(odd, now), String(odd)).toBe(false);
    }
  });
});

describe('interaction payloads and replies', () => {
  it('reads a guild press and a direct-message press the same way, ignoring unknown fields', () => {
    const guild = interactionSchema.parse({
      id: '111111111111111111',
      type: 3,
      member: { user: { id: '222222222222222222', username: 'someone' } },
      data: { custom_id: customIds.alertAck(randomUUID()), component_type: 2 },
      extra: 'ignored',
    });
    expect(interactionUserId(guild)).toBe('222222222222222222');
    const direct = interactionSchema.parse({
      id: '111111111111111111',
      type: 3,
      user: { id: '333333333333333333' },
    });
    expect(interactionUserId(direct)).toBe('333333333333333333');
    expect(interactionSchema.safeParse({ id: 'not a snowflake', type: 1 }).success).toBe(false);
  });

  it('replies are ephemeral or update the message, and never ping', () => {
    expect(ephemeralReply('nope')).toEqual({
      type: CALLBACK_TYPES.message,
      data: { content: 'nope', flags: EPHEMERAL_FLAG, allowed_mentions: { parse: [] } },
    });
    expect(updateMessage('done').type).toBe(CALLBACK_TYPES.updateMessage);
    expect(updateMessage('done').data?.components).toEqual([]);
  });
});

describe('what Watchtower says in Discord (N4)', () => {
  it('an escalation page holds the severity, service, count, step and link, with an Ack button', () => {
    const f = facts();
    const message = parseBotMessage(buildAlertEscalationMessage(f));
    expect(message.content).toContain('CRITICAL');
    expect(message.content).toContain('Checkout');
    expect(message.content).toContain(f.link);
    expect(message.content).toContain('<@123456789012345678>');
    expect(message.buttons).toEqual([
      { customId: customIds.alertAck(f.alertId), label: 'Ack', style: 'primary' },
    ]);
    const payload = toDiscordPayload(message);
    expect(payload.allowed_mentions).toEqual({ parse: [], users: ['123456789012345678'] });
    expect(JSON.stringify(payload.components)).toContain('"custom_id"');
  });

  it('a service name is made inert: no mention, no markdown, no line break, bounded', () => {
    const hostile = 'Checkout @everyone <@999999999999999999> `x`\nsecond line ' + 'y'.repeat(200);
    const message = buildAlertEscalationMessage(
      facts({ serviceName: hostile, mentionUserIds: [] }),
    );
    expect(message.content).not.toContain('@everyone');
    expect(message.content).not.toContain('<@999');
    expect(message.content).not.toContain('`');
    expect(message.content.split('\n')).toHaveLength(3);
    expect(inert(hostile).length).toBeLessThanOrEqual(60);
    expect(message.content.length).toBeLessThanOrEqual(BOT_MAX_CONTENT);
  });

  it('an unmapped alert says so, a fallback says nobody was on shift, an acked page has no button', () => {
    expect(
      buildAlertEscalationMessage(facts({ serviceName: null, fallback: true })).content,
    ).toMatch(/unmapped.*nobody on shift/s);
    const acked = buildAlertAckedMessage(facts(), '444444444444444444');
    expect(acked.buttons).toEqual([]);
    expect(acked.content).toContain('<@444444444444444444>');
    expect(acked.mentionUserIds).toEqual([]);
  });

  it('an incident thread is named from the key, severity and service slugs, never the title', () => {
    const name = incidentThreadName({
      key: 'INC-12',
      severity: 'SEV2',
      serviceSlugs: ['checkout', 'api'],
    });
    expect(name).toBe('INC-12 SEV2 checkout api');
    const opening = parseBotMessage(
      buildIncidentOpeningMessage({
        incidentId: randomUUID(),
        key: 'INC-12',
        severity: 'SEV2',
        status: 'investigating',
        serviceSlugs: ['checkout'],
        link: 'https://watchtower.example.test/incidents/12',
      }),
    );
    expect(opening.buttons.map((button) => button.label)).toEqual(['Ack alerts', 'Assign to me']);
  });

  it('a mirrored line says what kind of thing happened and never a note or a subject', () => {
    expect(
      buildIncidentMirrorLine(
        'status_changed',
        { from: 'investigating', to: 'identified' },
        'INC-12',
      ).content,
    ).toBe('INC-12 status: investigating -> identified');
    const note = buildIncidentMirrorLine(
      'note',
      { text: 'Customer Acme says the checkout is down' },
      'INC-12',
    );
    expect(note.content).not.toContain('Acme');
    const created = buildIncidentMirrorLine(
      'created',
      { severity: 'SEV1', title: 'Acme outage' },
      'INC-12',
    );
    expect(created.content).toBe('INC-12 opened as SEV1');
  });

  it('a button id round-trips and a forged one is nothing', () => {
    const id = randomUUID();
    expect(parseCustomId(customIds.alertAck(id))).toEqual({ kind: 'alert.ack', alertId: id });
    expect(parseCustomId(customIds.incidentAck(id))).toEqual({
      kind: 'incident.ack',
      incidentId: id,
    });
    expect(parseCustomId(customIds.incidentAssign(id))).toEqual({
      kind: 'incident.assign',
      incidentId: id,
    });
    for (const forged of [
      'alert:ack:1; DROP TABLE alert',
      'alert:ack:',
      `alert:resolve:${id}`,
      `x${customIds.alertAck(id)}`,
    ]) {
      expect(parseCustomId(forged)).toBeNull();
    }
  });
});

describe('the fake bot transport', () => {
  it('records the final payload, says delivered false and hands back no id', async () => {
    const bot = new FakeBotTransport();
    const message = buildAlertEscalationMessage(facts());
    expect(await bot.postMessage('555555555555555555', message)).toEqual({
      delivered: false,
      channelId: null,
      messageId: null,
    });
    expect(
      await bot.createThread('555555555555555555', '666666666666666666', 'INC-1 SEV2\nlive'),
    ).toEqual({
      delivered: false,
      channelId: null,
      threadId: null,
    });
    expect(bot.calls.map((call) => call.op)).toEqual(['postMessage', 'createThread']);
    expect(bot.calls[1]?.payload).toEqual({ name: 'INC-1 SEV2 live', type: 11 });
    expect(bot.calls[0]?.payload.allowed_mentions).toEqual({
      parse: [],
      users: ['123456789012345678'],
    });
  });

  it('refuses what a live transport would: a label past 80 characters, a sixth button, odd mention ids', async () => {
    const bot = new FakeBotTransport();
    const button = (label: string) => ({ customId: 'x', label, style: 'primary' as const });
    await expect(
      bot.postMessage('1', { content: 'hi', buttons: [button('x'.repeat(BOT_MAX_LABEL + 1))] }),
    ).rejects.toMatchObject({ kind: 'client', code: 'invalid_message' });
    await expect(
      bot.postMessage('1', {
        content: 'hi',
        buttons: Array.from({ length: 6 }, () => button('ok')),
      }),
    ).rejects.toBeInstanceOf(ChannelError);
    await expect(
      bot.postMessage('1', { content: 'hi', mentionUserIds: ['@everyone'] }),
    ).rejects.toBeInstanceOf(ChannelError);
    await expect(
      bot.postMessage('1', { content: 'x'.repeat(BOT_MAX_CONTENT + 1) }),
    ).rejects.toBeInstanceOf(ChannelError);
    expect(bot.calls).toEqual([]);
  });

  it('fails the next call as scripted and behaves normally after it', async () => {
    const bot = new FakeBotTransport();
    bot.failNext(
      new ChannelError({
        provider: 'discord',
        operation: 'message.create',
        kind: 'rate_limited',
        retryAfterMs: 1200,
      }),
    );
    await expect(bot.postMessage('1', { content: 'hi' })).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 1200,
    });
    await bot.postMessage('1', { content: 'hi' });
    expect(bot.calls).toHaveLength(1);
  });
});
