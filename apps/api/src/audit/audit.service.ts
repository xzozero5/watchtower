import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import type {
  AuditActorType,
  AuditLogEntry,
  AuditLogQuery,
  AuditOutcome,
} from '@watchtower/shared';
import { and, desc, eq, gte, lt, lte, or, sql, type SQL } from 'drizzle-orm';

import { DATABASE } from '../database/database.module.js';
import { redactForAudit } from './audit-redact.js';
import { AuditScope, type AuditActor } from './audit-scope.js';

/** Anything with `insert`: the database handle or a transaction. */
export type AuditExecutor = Pick<Database['db'], 'insert'>;

export interface AuditEntryInput {
  readonly actor: AuditActor;
  readonly action: string;
  readonly outcome?: AuditOutcome;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly ip?: string | null;
  readonly requestId?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface AuditPage {
  readonly entries: AuditLogEntry[];
  readonly nextCursor: string | null;
}

interface Cursor {
  /** created_at with microseconds, as text, so paging never skips or repeats rows. */
  readonly t: string;
  readonly id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      't' in parsed &&
      'id' in parsed &&
      typeof parsed.t === 'string' &&
      typeof parsed.id === 'string' &&
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(parsed.t) &&
      /^[0-9a-f-]{36}$/.test(parsed.id)
    ) {
      return { t: parsed.t, id: parsed.id };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Writes and reads the audit log (PRD section 8.2). The table is append-only; this class has no
 * update or delete. Everything written passes through `redactForAudit` first.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /** Appends one entry. Pass a transaction as `executor` to make the entry commit with the change it describes. */
  async record(entry: AuditEntryInput, executor?: AuditExecutor): Promise<void> {
    const target = executor ?? this.database.db;
    await target.insert(schema.auditLog).values({
      actorType: entry.actor.type,
      actorId: entry.actor.id,
      action: entry.action,
      outcome: entry.outcome ?? 'success',
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      before: entry.before === undefined ? null : redactForAudit(entry.before),
      after: entry.after === undefined ? null : redactForAudit(entry.after),
      ip: entry.ip ?? null,
      requestId: entry.requestId ?? null,
      metadata: redactForAudit(entry.metadata ?? {}),
    });
  }

  /**
   * Same as `record`, inside the caller's transaction, and tells the request's audit interceptor
   * that this mutation is already on the log so it does not write a second row. T-005 uses it for
   * changes that must commit atomically with their audit entry.
   */
  async recordInTransaction(tx: AuditExecutor, entry: AuditEntryInput): Promise<void> {
    const meta = AuditScope.current()?.meta;
    await this.record(
      {
        ...entry,
        ip: entry.ip ?? meta?.ip ?? null,
        requestId: entry.requestId ?? meta?.requestId ?? null,
      },
      tx,
    );
    AuditScope.set({ persisted: true });
  }

  /** Personal data was returned to `actor`: one row, action `pii.read` (PRD section 8.2). */
  async recordPiiRead(
    entry: Omit<AuditEntryInput, 'action'> & { readonly action?: string },
  ): Promise<void> {
    await this.record({ ...entry, action: entry.action ?? 'pii.read' });
  }

  async list(query: AuditLogQuery): Promise<AuditPage> {
    const { auditLog } = schema;
    const conditions: (SQL | undefined)[] = [
      query.actorId === undefined ? undefined : eq(auditLog.actorId, query.actorId),
      query.action === undefined ? undefined : eq(auditLog.action, query.action),
      query.outcome === undefined ? undefined : eq(auditLog.outcome, query.outcome),
      query.targetType === undefined ? undefined : eq(auditLog.targetType, query.targetType),
      query.targetId === undefined ? undefined : eq(auditLog.targetId, query.targetId),
      query.from === undefined ? undefined : gte(auditLog.createdAt, new Date(query.from)),
      query.to === undefined ? undefined : lte(auditLog.createdAt, new Date(query.to)),
    ];
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor);
      if (!cursor) throw new BadRequestException('Invalid cursor');
      const at = sql`${cursor.t}::timestamptz`;
      conditions.push(
        or(lt(auditLog.createdAt, at), and(eq(auditLog.createdAt, at), lt(auditLog.id, cursor.id))),
      );
    }

    const rows = await this.database.db
      .select({
        row: auditLog,
        precise: sql<string>`to_char(${auditLog.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      entries: page.map(({ row }) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        actorType: row.actorType as AuditActorType,
        actorId: row.actorId,
        action: row.action,
        outcome: row.outcome as AuditOutcome,
        targetType: row.targetType,
        targetId: row.targetId,
        before: row.before,
        after: row.after,
        ip: row.ip,
        requestId: row.requestId,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ t: last.precise, id: last.row.id })
          : null,
    };
  }
}
