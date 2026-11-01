import { line } from '@watchtower/channels';

import { lineChannelsFrom } from '../line/transports.js';
import type { ProcessorContext } from '../processors/index.js';
import { NO_CHANNELS, type OutboundChannels } from './channels.js';
import { createOutboundDispatcher, type DispatcherDeps } from './dispatcher.js';
import { createOutboundProcessor } from './processor.js';

export { NO_CHANNELS } from './channels.js';
export type { GmailSender, LineSender, OutboundAccount, OutboundChannels } from './channels.js';
export { createOutboundDispatcher, splitLineText } from './dispatcher.js';
export type { DispatchOutcome, DispatcherDeps, OutboundDispatcher } from './dispatcher.js';
export { createOutboundProcessor } from './processor.js';

/** What a test (or the credential tasks T-102/T-103) replaces; production wires no provider yet. */
export interface OutboundOverrides {
  readonly channels?: OutboundChannels;
  readonly lineQuotaLimit?: number | null;
  readonly lineRouter?: DispatcherDeps['lineRouter'];
}

/**
 * Wires the `outbound` consumer from the worker's context. The domain it receives carries the real
 * policy gate, built on the worker's own database handle, so the worker enforces the same rules as
 * the api (ADR-011 section 1).
 */
/** The providers this process can send through: an override, else what the deployment wired. */
export function outboundChannelsFor(context: ProcessorContext): OutboundChannels {
  return context.overrides.outbound?.channels ?? defaultChannels(context);
}

export function createOutboundDispatcherFor(context: ProcessorContext) {
  const outbound = context.overrides.outbound ?? {};
  return createOutboundDispatcher({
    database: context.database,
    domain: context.domain,
    channels: outboundChannelsFor(context),
    appHost: new URL(context.config.APP_URL).hostname,
    realtime: context.realtime,
    logger: context.logger,
    ...(outbound.lineQuotaLimit === undefined ? {} : { lineQuotaLimit: outbound.lineQuotaLimit }),
    ...(outbound.lineRouter === undefined ? {} : { lineRouter: outbound.lineRouter }),
  });
}

/**
 * Without an override, Gmail goes through the worker's mailbox runtime (T-102d) and LINE is reachable
 * exactly where the deployment supplied a LINE transport (T-103).
 */
function defaultChannels(context: ProcessorContext): OutboundChannels {
  const channels: OutboundChannels = {
    ...NO_CHANNELS,
    gmail: (account) => context.gmail.senderFor(account),
  };
  const transportFor = context.overrides.line?.transportFor;
  if (transportFor === undefined) return channels;
  return {
    ...channels,
    ...lineChannelsFrom(transportFor, (transport) => {
      // The channel secret is for verifying webhooks, which the api does; sending never asks for it.
      const adapter = new line.LineAdapter({
        transport,
        getChannelSecret: () => Promise.reject(new Error('the worker does not verify webhooks')),
      });
      return { send: (input) => adapter.send(input) };
    }),
  };
}

export function createOutboundRegistration(context: ProcessorContext) {
  const dispatcher = createOutboundDispatcherFor(context);
  return createOutboundProcessor({ dispatcher, logger: context.logger });
}
