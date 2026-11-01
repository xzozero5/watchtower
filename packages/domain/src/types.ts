import type { Database } from '@watchtower/db';
import type { AuditActorType, RealtimeEvent } from '@watchtower/shared';

import type { PolicyGate } from './policy.js';
import type { TicketNotifier } from './notifier.js';

/** The transaction handle of Drizzle, as `Database['db'].transaction` passes it to its callback. */
export type DbTransaction = Parameters<Parameters<Database['db']['transaction']>[0]>[0];

/** Anything that can `select`: the database handle or a transaction. */
export type ReadExecutor = Pick<Database['db'], 'select'>;

/** Who does something: written to the audit log and the ticket event log. */
export interface Actor {
  readonly type: AuditActorType;
  readonly id: string | null;
}

export interface DomainConfig {
  /** Prefix of ticket keys (`OPS` in `OPS-12`). The same value in api and worker. */
  readonly ticketKeyPrefix: string;
  /** A customer reply reopens a ticket resolved within this many days (R-1.10). */
  readonly reopenWindowDays: number;
  /** Subkey that seals the secret part of outbox jobs (`KEY_LABELS.outboxSecret`). */
  readonly sealKey: Buffer;
  /**
   * Where a customer can follow a request, for the automatic acknowledgment (ADR-010). Unset: the
   * sentence is left out. The same value in api and worker (`APP_URL` + the portal path).
   */
  readonly portalUrl?: string | undefined;
  /**
   * How long a delivery may keep being retried under the same LINE retry key (seconds). Unset:
   * `DELIVERY_RETRY_KEY_MAX_AGE_SECONDS`. Must stay below LINE's 24 hours.
   */
  readonly retryKeyMaxAgeSeconds?: number | undefined;
}

/**
 * Everything a domain function needs besides the transaction and its input. The domain never reads
 * `process.env` or a request: the app validates its config and builds the context.
 */
export interface DomainContext {
  readonly actor: Actor;
  /** Where the audit rows say the action came from (api: the request; worker: nulls). */
  readonly auditMeta: { readonly ip: string | null; readonly requestId: string | null };
  readonly now: () => Date;
  readonly config: DomainConfig;
  /** Asked before anything is created that goes to a customer. Unset means refuse (fail closed). */
  readonly policyGate?: PolicyGate | undefined;
  /** Customer-facing notices that belong to a ticket change (the portal's emails). */
  readonly notifier: TicketNotifier;
}

/**
 * What every domain operation returns. `events` are for the caller to publish after the commit;
 * `audited` says an `audit_log` row was written in the transaction, so the caller's request-level
 * audit must not write a second one.
 */
export interface DomainResult<T> {
  readonly value: T;
  readonly events: RealtimeEvent[];
  readonly audited: boolean;
}

/** Collects what one operation produces; internal steps share one so the result is the sum. */
export class Effects {
  readonly events: RealtimeEvent[] = [];
  audited = false;

  emit(event: RealtimeEvent): void {
    this.events.push(event);
  }

  result<T>(value: T): DomainResult<T> {
    return { value, events: this.events, audited: this.audited };
  }
}
