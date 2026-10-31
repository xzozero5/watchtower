import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@watchtower/db';
import type { RealtimeEvent } from '@watchtower/shared';

import { AuditScope } from '../audit/audit-scope.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { RealtimePublisher } from './realtime-publisher.js';

/** The transaction handle of Drizzle, as `Database['db'].transaction` passes it to its callback. */
export type DbTransaction = Parameters<Parameters<Database['db']['transaction']>[0]>[0];

/** What a piece of business logic gets while a transaction is open. */
export interface UnitOfWork {
  readonly tx: DbTransaction;
  /** Publishes a realtime event after the transaction commits (never when it rolls back). */
  emit(event: RealtimeEvent): void;
  /**
   * Runs `hook` after the transaction commits, in the order registered. Use it for work that must
   * only happen once the data is durable: enqueueing an email, notifying another system. A failing
   * hook is logged and does not undo the change.
   */
  afterCommit(hook: () => Promise<void> | void): void;
}

/**
 * Runs business logic in one database transaction and defers everything that leaves the process
 * until after the commit (docs/04-ARCHITECTURE.md section 2: enqueue and publish after commit
 * only). The portal channel (T-007) creates a ticket in the same transaction as its contact lookup
 * by calling the ticket service inside `run`.
 */
@Injectable()
export class UnitOfWorkService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(RealtimePublisher) private readonly publisher: RealtimePublisher,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  async run<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    const hooks: (() => Promise<void> | void)[] = [];
    let result: T;
    try {
      result = await this.database.db.transaction((tx) =>
        work({
          tx,
          emit: (event) => {
            hooks.push(() => this.publisher.publish(event));
          },
          afterCommit: (hook) => {
            hooks.push(hook);
          },
        }),
      );
    } catch (error) {
      // An audit entry written inside the rolled-back transaction is gone: let the request's audit
      // interceptor record the failure instead of believing it was already persisted.
      AuditScope.set({ persisted: false });
      throw error;
    }
    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        this.logger.error({ err: error }, 'after-commit hook failed');
      }
    }
    return result;
  }
}
