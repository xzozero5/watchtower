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

/** One CSV row: the same fields as the list minus IP, before/after and metadata. */
export interface AuditExportRow {
  readonly id: string;
  readonly createdAt: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly requestId: string | null;
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

  /** The WHERE of a search, shared by the list and the CSV export so both filter the same way. */
  private conditions(query: Omit<AuditLogQuery, 'limit' | 'cursor'>): (SQL | undefined)[] {
    const { auditLog } = schema;
    return [
      query.actorId === undefined ? undefined : eq(auditLog.actorId, query.actorId),
      query.actorType === undefined ? undefined : eq(auditLog.actorType, query.actorType),
      query.action === undefined ? undefined : eq(auditLog.action, query.action),
      query.outcome === undefined ? undefined : eq(auditLog.outcome, query.outcome),
      query.targetType === undefined ? undefined : eq(auditLog.targetType, query.targetType),
      query.targetId === undefined ? undefined : eq(auditLog.targetId, query.targetId),
      query.from === undefined ? undefined : gte(auditLog.createdAt, new Date(query.from)),
      query.to === undefined ? undefined : lte(auditLog.createdAt, new Date(query.to)),
    ];
  }

  private cursorCondition(cursorText: string): SQL | undefined {
    const { auditLog } = schema;
    const cursor = decodeCursor(cursorText);
    if (!cursor) throw new BadRequestException('Invalid cursor');
    const at = sql`${cursor.t}::timestamptz`;
    return or(
      lt(auditLog.createdAt, at),
      and(eq(auditLog.createdAt, at), lt(auditLog.id, cursor.id)),
    );
  }

  /**
   * Rows for the CSV export, newest first, at most `maxRows`, read in keyset batches so a large log
   * never sits in memory twice. Only the columns the export carries are selected: no IP, no
   * before/after, no metadata.
   */
  async exportRows(
    query: Omit<AuditLogQuery, 'limit' | 'cursor'>,
    maxRows: number,
  ): Promise<AuditExportRow[]> {
    const { auditLog } = schema;
    const out: AuditExportRow[] = [];
    let cursor: string | undefined;
    while (out.length < maxRows) {
      const batch = Math.min(1000, maxRows - out.length);
      const rows = await this.database.db
        .select({
          id: auditLog.id,
          createdAt: auditLog.createdAt,
          actorType: auditLog.actorType,
          actorId: auditLog.actorId,
          action: auditLog.action,
          outcome: auditLog.outcome,
          targetType: auditLog.targetType,
          targetId: auditLog.targetId,
          requestId: auditLog.requestId,
          precise: sql<string>`to_char(${auditLog.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(auditLog)
        .where(
          and(
            ...this.conditions(query),
            cursor === undefined ? undefined : this.cursorCondition(cursor),
          ),
        )
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(batch);
      for (const row of rows) {
        out.push({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          actorType: row.actorType,
          actorId: row.actorId,
          action: row.action,
          outcome: row.outcome,
          targetType: row.targetType,
          targetId: row.targetId,
          requestId: row.requestId,
        });
      }
      const last = rows.at(-1);
      if (rows.length < batch || last === undefined) break;
      cursor = encodeCursor({ t: last.precise, id: last.id });
    }
    return out;
  }

  async list(query: AuditLogQuery): Promise<AuditPage> {
    const { auditLog } = schema;
    const conditions: (SQL | undefined)[] = this.conditions(query);
    if (query.cursor !== undefined) conditions.push(this.cursorCondition(query.cursor));

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
