import { AsyncLocalStorage } from 'node:async_hooks';

import type { AuditActorType, AuditOutcome } from '@watchtower/shared';

export interface AuditActor {
  readonly type: AuditActorType;
  readonly id: string | null;
}

/** What a handler or service can tell the audit interceptor about the mutation in progress. */
export interface AuditDetails {
  /** Overrides the name from `@Audited`, for example `auth.break_glass.failed` on a failed login. */
  action?: string;
  /** Overrides the signed-in user, which is how a login attributes the entry to the person who just signed in. */
  actor?: AuditActor;
  outcome?: AuditOutcome;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  /** True when the entry was already written in the caller's own transaction. */
  persisted?: boolean;
}

/**
 * The audit context of one request. AuditInterceptor opens it around every mutating handler and
 * writes one audit row when the handler finishes, success or failure. Services reached from the
 * handler add what only they know (the target, the before and after state) without needing the
 * request object:
 *
 *   AuditScope.set({ targetType: 'user', targetId: user.id, before, after });
 *
 * Outside a request, or on a route the interceptor does not audit, `set` does nothing.
 */
export class AuditScope {
  private static readonly storage = new AsyncLocalStorage<AuditScope>();

  private details: AuditDetails = {};

  static run<T>(scope: AuditScope, callback: () => T): T {
    return AuditScope.storage.run(scope, callback);
  }

  static current(): AuditScope | undefined {
    return AuditScope.storage.getStore();
  }

  static set(patch: AuditDetails): void {
    AuditScope.current()?.merge(patch);
  }

  merge(patch: AuditDetails): void {
    this.details = {
      ...this.details,
      ...patch,
      metadata:
        patch.metadata === undefined
          ? this.details.metadata
          : { ...this.details.metadata, ...patch.metadata },
    };
  }

  read(): Readonly<AuditDetails> {
    return this.details;
  }
}
