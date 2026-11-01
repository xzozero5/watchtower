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
export function createOutboundRegistration(context: ProcessorContext) {
  const outbound = context.overrides.outbound ?? {};
  const dispatcher = createOutboundDispatcher({
    database: context.database,
    domain: context.domain,
    channels: outbound.channels ?? NO_CHANNELS,
    appHost: new URL(context.config.APP_URL).hostname,
    realtime: context.realtime,
    logger: context.logger,
    ...(outbound.lineQuotaLimit === undefined ? {} : { lineQuotaLimit: outbound.lineQuotaLimit }),
    ...(outbound.lineRouter === undefined ? {} : { lineRouter: outbound.lineRouter }),
  });
  return createOutboundProcessor({ dispatcher, logger: context.logger });
}
