import { schema, type Database } from '@watchtower/db';
import { redactForAudit, type AuditOutcome } from '@watchtower/shared';

import type { DomainContext, Effects } from './types.js';

/** Anything with `insert`: the database handle or a transaction. */
export type AuditWriter = Pick<Database['db'], 'insert'>;

export interface AuditEntry {
  readonly action: string;
  readonly outcome?: AuditOutcome;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Appends one `audit_log` row in the caller's transaction, so it commits (or rolls back) with the
 * change it describes. Everything passes through `redactForAudit` first. Marks `fx.audited`, which
 * tells the caller's request-level audit not to write a second row for the same mutation.
 */
export async function recordAuditInTx(
  tx: AuditWriter,
  ctx: Pick<DomainContext, 'actor' | 'auditMeta'>,
  fx: Pick<Effects, 'audited'>,
  entry: AuditEntry,
): Promise<void> {
  await tx.insert(schema.auditLog).values({
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    action: entry.action,
    outcome: entry.outcome ?? 'success',
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    before: entry.before === undefined ? null : redactForAudit(entry.before),
    after: entry.after === undefined ? null : redactForAudit(entry.after),
    ip: ctx.auditMeta.ip,
    requestId: ctx.auditMeta.requestId,
    metadata: redactForAudit(entry.metadata ?? {}),
  });
  fx.audited = true;
}
