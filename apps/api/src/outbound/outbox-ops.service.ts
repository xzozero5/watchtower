import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  OUTBOX_AGE_CRITICAL_SECONDS,
  OUTBOX_AGE_WARNING_SECONDS,
  OUTBOUND_JOBS,
  QUEUE_NAMES,
  INGEST_JOBS,
  isUuid,
  outboxHealthStatus,
  type DeadOutboxItem,
  type DeadOutboxQuery,
  type OutboxHealth,
  type ResendOutboxResult,
} from '@watchtower/shared';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service.js';
import { conflict, notFound } from '../auth/http-errors.js';
import { beforeCursor, decodeCursor, preciseTimestamp, toPage } from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import { UnitOfWorkService, type DbTransaction } from '../realtime/unit-of-work.js';

type OutboxRow = typeof schema.outbox.$inferSelect;

/** `delivery-<uuid>-<attempt>`: the job id of a dispatch trigger (`dispatchJobId` in the domain). */
const DISPATCH_JOB_ID = /^delivery-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/;

/** What "resend" can do with a dead row. `payload` is the job rebuilt from its source record. */
type ReplayPlan =
  | { readonly replayable: true; readonly payload: Record<string, unknown> }
  | { readonly replayable: false; readonly reason: string };

const NOT_REBUILDABLE =
  'The payload was cleared when the row was given up on and this queue has no source record to rebuild it from';

/**
 * The head's view of the transactional outbox (T-121a, PRD section 8.3): how far behind it is, which
 * rows were given up on, and a way to put a dead row back.
 *
 * A dead row's payload was blanked when it died (ADR-006: it can hold a sealed one-time link), so a
 * resend cannot reuse it. Instead the job is rebuilt from the record the queue is only a nudge for:
 * `outbound` dispatch from its `outbound_delivery`, `ingest` from its `inbound_event`. Anything else
 * is shown as not replayable with the reason, never guessed at.
 */
@Injectable()
export class OutboxOpsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

  async health(): Promise<OutboxHealth> {
    const { outbox } = schema;
    const rows = await this.database.db
      .select({
        queue: outbox.queue,
        pending: sql<number>`count(*) FILTER (WHERE ${outbox.status} = 'pending')::int`,
        dead: sql<number>`count(*) FILTER (WHERE ${outbox.status} = 'dead')::int`,
        // A row held back on purpose (an undo window, a retry delay) is not late until its time comes.
        oldest: sql<
          number | null
        >`extract(epoch FROM now() - min(${outbox.nextAttemptAt}) FILTER (WHERE ${outbox.status} = 'pending' AND ${outbox.nextAttemptAt} <= now()))::float`,
      })
      .from(outbox)
      .where(inArray(outbox.status, ['pending', 'dead']))
      .groupBy(outbox.queue)
      .orderBy(outbox.queue);
    const oldest = Math.max(0, ...rows.map((row) => Math.round(row.oldest ?? 0)));
    return {
      generatedAt: new Date().toISOString(),
      pending: rows.reduce((sum, row) => sum + row.pending, 0),
      dead: rows.reduce((sum, row) => sum + row.dead, 0),
      oldestPendingSeconds: oldest,
      status: outboxHealthStatus(oldest),
      warningSeconds: OUTBOX_AGE_WARNING_SECONDS,
      criticalSeconds: OUTBOX_AGE_CRITICAL_SECONDS,
      byQueue: rows
        .filter((row) => row.pending > 0 || row.dead > 0)
        .map((row) => ({ queue: row.queue, pending: row.pending, dead: row.dead })),
    };
  }

  async listDead(
    query: DeadOutboxQuery,
  ): Promise<{ items: DeadOutboxItem[]; nextCursor: string | null }> {
    const { outbox } = schema;
    const key = sql`coalesce(${outbox.finishedAt}, ${outbox.createdAt})`;
    const conditions: (SQL | undefined)[] = [
      eq(outbox.status, 'dead'),
      query.queue === undefined ? undefined : eq(outbox.queue, query.queue),
      query.cursor === undefined ? undefined : beforeCursor(key, outbox.id, decodeCursor(query.cursor)),
    ];
    const rows = await this.database.db
      .select({
        row: {
          id: outbox.id,
          queue: outbox.queue,
          jobName: outbox.jobName,
          jobId: outbox.jobId,
          attempts: outbox.attempts,
          lastError: outbox.lastError,
          createdAt: outbox.createdAt,
          finishedAt: outbox.finishedAt,
        },
        sortKey: preciseTimestamp(key),
      })
      .from(outbox)
      .where(and(...conditions))
      .orderBy(desc(key), desc(outbox.id))
      .limit(query.limit + 1);
    const page = toPage(
      rows.map((entry) => ({ id: entry.row.id, sortKey: entry.sortKey, row: entry.row })),
      query.limit,
    );
    const plans = await this.plan(
      this.database.db,
      page.rows.map((entry) => entry.row),
    );
    return {
      items: page.rows.map(({ row }) => {
        const plan = plans.get(row.id);
        return {
          id: row.id,
          queue: row.queue,
          jobName: row.jobName,
          jobId: row.jobId,
          attempts: row.attempts,
          lastError: row.lastError,
          createdAt: row.createdAt.toISOString(),
          finishedAt: row.finishedAt?.toISOString() ?? null,
          replayable: plan?.replayable === true,
          notReplayableReason: plan === undefined || plan.replayable ? null : plan.reason,
        };
      }),
      nextCursor: page.nextCursor,
    };
  }

  /** Puts a dead row back in the queue, rebuilt from its source record; one audit row, atomically. */
  async resend(id: string, actorId: string): Promise<ResendOutboxResult> {
    return this.uow.run(async ({ tx }) => {
      const { outbox } = schema;
      const [row] = await tx.select().from(outbox).where(eq(outbox.id, id)).for('update');
      if (!row) throw notFound('No such outbox row');
      if (row.status !== 'dead') throw conflict('Only a row that was given up on can be resent');
      const plan = (await this.plan(tx, [row])).get(row.id);
      if (plan === undefined || !plan.replayable) {
        throw conflict(plan === undefined ? NOT_REBUILDABLE : plan.reason);
      }
      // The old job id may still be remembered by the queue (a failed job is kept for a while): a
      // fresh one makes sure the resend is a new job. The consumer is idempotent on its record.
      const jobId = `${row.jobId}-resend-${String(Date.now())}`;
      await tx
        .update(outbox)
        .set({
          status: 'pending',
          jobId,
          payload: plan.payload,
          attempts: 0,
          nextAttemptAt: sql`now()`,
          lockedUntil: null,
          lastError: null,
          finishedAt: null,
          expiresAt: null,
        })
        .where(eq(outbox.id, row.id));
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: actorId },
        action: AUDIT_ACTIONS.outboxResend,
        targetType: 'outbox',
        targetId: row.id,
        metadata: {
          queue: row.queue,
          jobName: row.jobName,
          previousJobId: row.jobId,
          jobId,
          previousAttempts: row.attempts,
        },
      });
      return { id: row.id, queue: row.queue, jobId, status: 'pending' as const };
    });
  }

  /** For each dead row: whether it can be rebuilt, and the payload if so. */
  private async plan(
    executor: Pick<DbTransaction, 'select'>,
    rows: readonly Pick<OutboxRow, 'id' | 'queue' | 'jobName' | 'jobId'>[],
  ): Promise<Map<string, ReplayPlan>> {
    const plans = new Map<string, ReplayPlan>();
    const deliveries = new Map<string, string>(); // row id -> delivery id
    const events = new Map<string, string>(); // row id -> inbound event id
    for (const row of rows) {
      if (row.queue === QUEUE_NAMES.outbound && row.jobName === OUTBOUND_JOBS.dispatch) {
        const deliveryId = DISPATCH_JOB_ID.exec(row.jobId)?.[1];
        if (deliveryId === undefined) {
          plans.set(row.id, { replayable: false, reason: 'The job id names no delivery' });
        } else deliveries.set(row.id, deliveryId);
      } else if (row.queue === QUEUE_NAMES.ingest && row.jobName === INGEST_JOBS.process) {
        const base = row.jobId.slice(0, 36);
        if (!isUuid(base)) {
          plans.set(row.id, { replayable: false, reason: 'The job id names no received event' });
        } else events.set(row.id, base);
      } else {
        plans.set(row.id, { replayable: false, reason: NOT_REBUILDABLE });
      }
    }

    if (deliveries.size > 0) {
      const found = await executor
        .select({ id: schema.outboundDelivery.id, state: schema.outboundDelivery.state })
        .from(schema.outboundDelivery)
        .where(inArray(schema.outboundDelivery.id, [...new Set(deliveries.values())]));
      const states = new Map(found.map((delivery) => [delivery.id, delivery.state]));
      for (const [rowId, deliveryId] of deliveries) {
        const state = states.get(deliveryId);
        plans.set(
          rowId,
          state === 'scheduled'
            ? { replayable: true, payload: { deliveryId } }
            : {
                replayable: false,
                reason:
                  state === undefined
                    ? 'The delivery no longer exists'
                    : `The delivery is ${state}, so there is nothing left to trigger`,
              },
        );
      }
    }
    if (events.size > 0) {
      const found = await executor
        .select({ id: schema.inboundEvent.id, status: schema.inboundEvent.status })
        .from(schema.inboundEvent)
        .where(inArray(schema.inboundEvent.id, [...new Set(events.values())]));
      const statuses = new Map(found.map((event) => [event.id, event.status]));
      for (const [rowId, eventId] of events) {
        const status = statuses.get(eventId);
        plans.set(
          rowId,
          status === 'pending' || status === 'failed'
            ? { replayable: true, payload: { inboundEventId: eventId } }
            : {
                replayable: false,
                reason:
                  status === undefined
                    ? 'The received event no longer exists'
                    : 'The received event was processed already',
              },
        );
      }
    }
    return plans;
  }
}
