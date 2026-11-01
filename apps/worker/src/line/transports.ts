import type { line } from '@watchtower/channels';

import type { LineSender, OutboundChannels } from '../outbound/channels.js';

/**
 * How the worker reaches a LINE Official Account (T-103). One `LineTransport` per account; the
 * worker never builds a live one by itself: credentials come from the credential store (ADR-004,
 * ADR-012) and going live is an `[ASK-HUMAN]` step (PRD section 11 egress allow-list), so until a
 * deployment supplies `transportFor` there is no transport, media is only described, the
 * acknowledgment is not sent and the quota is not reconciled. Tests supply `FakeLineTransport`.
 */

export interface LineAccount {
  readonly id: string;
  readonly type: string;
}

export type LineTransportFor = (account: LineAccount) => line.LineTransport | undefined;

/** What a test (or the deployment that wires credentials) replaces. */
export interface LineOverrides {
  readonly transportFor?: LineTransportFor;
}

/** The outbound dispatcher's view of the same transports: sends reply and push through the adapter. */
export function lineChannelsFrom(
  transportFor: LineTransportFor | undefined,
  senderFor: (transport: line.LineTransport) => LineSender,
): Pick<OutboundChannels, 'line'> {
  return {
    line: (account) => {
      const transport = transportFor?.(account);
      return transport === undefined ? undefined : senderFor(transport);
    },
  };
}
