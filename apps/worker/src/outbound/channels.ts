import type { gmail, line } from '@watchtower/channels';

/**
 * How the dispatcher reaches a provider. Production builds a sender only from the account's stored
 * credentials (T-102/T-103, ADR-004); until those exist nothing is wired, so a delivery fails
 * visibly with `channel_not_connected` instead of pretending to send. Tests inject senders over
 * `FakeGmailTransport` / `FakeLineTransport`. This file never constructs a live transport.
 */

export interface OutboundAccount {
  readonly id: string;
  readonly type: string;
  readonly name: string;
}

export interface GmailSender {
  /** The mailbox address (and optional display name) the reply goes out as (R-2.4). */
  readonly from: { readonly address: string; readonly name?: string | null };
  send(input: gmail.GmailSendInput): Promise<gmail.GmailSendResult>;
}

export interface LineSender {
  send(input: line.LineSendInput): Promise<line.LineSendResult>;
}

export interface OutboundChannels {
  /** Undefined for an account this process cannot reach (no credentials). */
  gmail(account: OutboundAccount): GmailSender | undefined | Promise<GmailSender | undefined>;
  line(account: OutboundAccount): LineSender | undefined;
}

/** The default: no account is connected. */
export const NO_CHANNELS: OutboundChannels = {
  gmail: () => undefined,
  line: () => undefined,
};
