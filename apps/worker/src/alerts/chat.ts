import type { AlertSeverity, EscalationTarget } from '@watchtower/shared';

/**
 * What an escalation step says in chat (Discord). Ids, enumerations and counts only, plus a link back
 * to the app: the alert title and payload stay in the app (N4: no customer data, no organisation
 * names, nothing a policy or label name might carry). The text is built by whoever implements the
 * port, from these fields.
 */
export interface AlertChatMessage {
  readonly alertId: string;
  /** Index of the step in the policy. */
  readonly level: number;
  readonly target: EscalationTarget;
  readonly severity: AlertSeverity;
  /** Catalog name of the service, or null for an alert no service claims. */
  readonly serviceName: string | null;
  readonly count: number;
  /** True when nobody was on shift and the leads were told in place. */
  readonly fallback: boolean;
  /** Discord user ids to mention: only people who linked an account. */
  readonly mentionUserIds: readonly string[];
  /** The alert in the web app. */
  readonly link: string;
}

export interface AlertChatResult {
  /**
   * True only when the chat service accepted the message and created it. An in-memory fake always
   * says false: it recorded the message in this process and nothing left it. The caller records
   * "sent" from this value and never from "no error was thrown".
   */
  readonly delivered: boolean;
  readonly channelId: string | null;
  readonly messageId: string | null;
}

/**
 * The seam between the escalation and the chat service (T-201d). The domain never knows Discord; the
 * worker holds one of these. `FakeAlertChat` is the default (no token needed); T-202b adds the
 * implementation over the Discord bot transport. Rejects with a `ChannelError` (provider `discord`):
 * `rate_limited` with `retryAfterMs` when nothing was posted; `timeout`, `network` and `server` when
 * the outcome is unknown; `auth`, `not_found` and `client` when it will not work as it is.
 */
export interface AlertChatPort {
  /** `live` reaches Discord; `fake` never leaves the process. */
  readonly kind: 'live' | 'fake';
  postEscalation(message: AlertChatMessage): Promise<AlertChatResult>;
}

/** Records messages in memory. Never `delivered`. */
export class FakeAlertChat implements AlertChatPort {
  readonly kind = 'fake' as const;
  readonly posted: AlertChatMessage[] = [];
  /** Errors to throw on the next calls, one per call, in order (a test script). */
  readonly failures: Error[] = [];

  postEscalation(message: AlertChatMessage): Promise<AlertChatResult> {
    const failure = this.failures.shift();
    if (failure !== undefined) return Promise.reject(failure);
    this.posted.push(message);
    return Promise.resolve({ delivered: false, channelId: null, messageId: null });
  }
}
