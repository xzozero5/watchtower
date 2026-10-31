/**
 * Errors thrown by channel transports. They carry enough to decide "retry / dead-letter / ask a
 * human" (ADR-010) without ever holding a credential, a request body or a message text (N1, N4).
 */

export type ChannelProvider = 'gmail' | 'line';

export type ChannelFailureKind =
  /** The request did not finish in time. The provider may or may not have acted on it. */
  | 'timeout'
  /** Connection failed or dropped. The provider may or may not have acted on it. */
  | 'network'
  | 'rate_limited'
  | 'server'
  | 'auth'
  | 'not_found'
  | 'conflict'
  | 'client'
  | 'invalid_response'
  | 'unsupported';

export interface ChannelErrorInit {
  readonly provider: ChannelProvider;
  /** Provider operation, for example `users.history.list` or `message.push`. */
  readonly operation: string;
  readonly kind: ChannelFailureKind;
  readonly status?: number;
  /** Provider error code or reason (never the provider's free-text message, which may hold PII). */
  readonly code?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class ChannelError extends Error {
  readonly provider: ChannelProvider;
  readonly operation: string;
  readonly kind: ChannelFailureKind;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(init: ChannelErrorInit) {
    const status = init.status === undefined ? '' : ` status=${String(init.status)}`;
    const code = init.code === undefined ? '' : ` code=${init.code}`;
    super(`${init.provider} ${init.operation} failed: ${init.kind}${status}${code}`, {
      cause: init.cause,
    });
    this.name = 'ChannelError';
    this.provider = init.provider;
    this.operation = init.operation;
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
  }

  /**
   * True when the provider may have acted on the request (timeout, dropped connection, 5xx).
   * A dispatcher must not blindly re-send a customer-facing message in this case (ADR-010).
   */
  get outcomeUnknown(): boolean {
    return this.kind === 'timeout' || this.kind === 'network' || this.kind === 'server';
  }

  /**
   * True when trying again later can succeed. For `outcomeUnknown` failures the caller still
   * decides whether a repeat is safe (only with a provider idempotency key, ADR-010).
   */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.outcomeUnknown;
  }
}

/** Thrown for operations a channel does not offer (see `capabilities()`). */
export function unsupportedOperation(provider: ChannelProvider, operation: string): ChannelError {
  return new ChannelError({ provider, operation, kind: 'unsupported' });
}
