import { discord } from '@watchtower/channels';
import { createCredentialStore } from '@watchtower/db';
import { pickCredentialEnv } from '@watchtower/shared';
import { localKmsFromConfig } from '@watchtower/shared/credential-box';

import type { ProcessorContext } from '../processors/index.js';
import type { AlertChatMessage, AlertChatPort, AlertChatResult } from './chat.js';

/**
 * How the worker reaches the Discord bot (T-202b). Phase 2 has the in-memory fake only: no token is
 * used and nothing leaves the process. A live bot transport is a later task (`[ASK-HUMAN]`: bot token,
 * channel, application). If a bot token IS configured, the worker says so loudly once and keeps using
 * the fake, so nobody believes pages are being posted when they are only being recorded.
 *
 * Both the alert escalation (`alerts` queue) and the incident threads (`incidents` queue) go through
 * the same runtime, so one fake sees everything in a test.
 */
export interface BotRuntime {
  readonly transport: discord.BotTransport;
  /** The alerts channel id from the credential store (env first, then the encrypted database), or null. */
  channelId(): Promise<string | null>;
}

/** Channel id used with the fake when none is configured: it is never sent anywhere. */
export const FAKE_CHANNEL_ID = '0';

export function createBotRuntime(
  context: ProcessorContext,
  override: discord.BotTransport | undefined,
): BotRuntime {
  const { config, database, logger } = context;
  const store = createCredentialStore({
    database,
    kms: localKmsFromConfig(config),
    env: pickCredentialEnv(config),
  });
  const transport: discord.BotTransport = override ?? new discord.FakeBotTransport();
  let warned = false;
  return {
    transport,
    async channelId() {
      const fields = await store.resolve('discord');
      if (!warned) {
        warned = true;
        if (transport.kind === 'fake' && (fields.botToken?.value ?? '') !== '') {
          logger.warn(
            'discord bot: a bot token is configured but this build has no live bot transport; ' +
              'posts are recorded by the in-memory fake and NOT delivered',
          );
        } else if (transport.kind === 'fake') {
          logger.info('discord bot: FAKE (no bot token), nothing is sent');
        }
      }
      const channel = fields.alertChannelId?.value ?? '';
      return channel === '' ? null : channel;
    },
  };
}

/** The alert escalation port over the bot: builds the page from ids and counts and posts it with the Ack button. */
export class BotAlertChat implements AlertChatPort {
  constructor(private readonly runtime: BotRuntime) {}

  get kind(): 'live' | 'fake' {
    return this.runtime.transport.kind;
  }

  async postEscalation(message: AlertChatMessage): Promise<AlertChatResult> {
    const channel = (await this.runtime.channelId()) ?? FAKE_CHANNEL_ID;
    if (channel === FAKE_CHANNEL_ID && this.runtime.transport.kind === 'live') {
      throw new Error('no alerts channel configured for a live bot');
    }
    const posted = await this.runtime.transport.postMessage(
      channel,
      discord.buildAlertEscalationMessage(message),
    );
    return {
      delivered: posted.delivered,
      channelId: posted.channelId,
      messageId: posted.messageId,
    };
  }
}
