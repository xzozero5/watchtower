import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { resolveIntent } from '@watchtower/domain';
import {
  replyTemplateSchema,
  type CreateIntent,
  type Intent,
  type TicketPriority,
  type UpdateIntent,
} from '@watchtower/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import { badRequest, conflict, notFound } from '../auth/http-errors.js';
import { PG, isPgError } from '../common/db-errors.js';
import { DATABASE } from '../database/database.module.js';
import { translating } from '../domain/domain-errors.js';
import type { DbTransaction } from '../realtime/unit-of-work.js';

export type IntentRow = typeof schema.intent.$inferSelect;

const templatesSchema = z.array(replyTemplateSchema);

export function toApiIntent(row: IntentRow): Intent {
  const templates = templatesSchema.safeParse(row.replyTemplates);
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    typicalEvidence: row.typicalEvidence,
    defaultPriority: row.defaultPriority as TicketPriority,
    slaPolicyId: row.slaPolicyId,
    runbookArticleId: row.runbookArticleId,
    allowedTools: row.allowedTools,
    procedureVersionId: row.procedureVersionId,
    autonomyStage: row.autonomyStage,
    replyTemplates: templates.success ? templates.data : [],
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function snapshot(row: IntentRow): Record<string, unknown> {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    defaultPriority: row.defaultPriority,
    slaPolicyId: row.slaPolicyId,
    isActive: row.isActive,
    autonomyStage: row.autonomyStage,
  };
}

@Injectable()
export class IntentsService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async list(): Promise<IntentRow[]> {
    return this.database.db.select().from(schema.intent).orderBy(asc(schema.intent.key));
  }

  async find(id: string): Promise<IntentRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(schema.intent)
      .where(eq(schema.intent.id, id))
      .limit(1);
    return row;
  }

  async get(id: string): Promise<Intent> {
    const row = await this.find(id);
    if (!row) throw notFound('No such intent');
    return toApiIntent(row);
  }

  /**
   * The intent a ticket is filed under, by id or by key. Null when the caller named none: the
   * ticket is then unclassified and a person (or, in Phase 1, the AI) triages it. An unknown or
   * inactive intent is the caller's mistake.
   */
  async resolve(
    tx: DbTransaction,
    ref: { readonly intentId?: string | undefined; readonly intentKey?: string | undefined },
  ): Promise<IntentRow | null> {
    // The lookup moved to @watchtower/domain (ADR-009); a refusal still answers 400.
    return translating(() => resolveIntent(tx, ref));
  }

  async create(input: CreateIntent): Promise<Intent> {
    try {
      // autonomy_stage is not set: the column default (2, draft-for-approval) applies (N3).
      const [row] = await this.database.db
        .insert(schema.intent)
        .values({
          key: input.key,
          name: input.name,
          description: input.description,
          typicalEvidence: input.typicalEvidence,
          defaultPriority: input.defaultPriority,
          slaPolicyId: input.slaPolicyId,
          allowedTools: input.allowedTools,
          replyTemplates: input.replyTemplates,
          isActive: input.isActive,
        })
        .returning();
      if (!row) throw new Error('intent insert returned no row');
      AuditScope.set({ targetType: 'intent', targetId: row.id, after: snapshot(row) });
      return toApiIntent(row);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async update(id: string, patch: UpdateIntent): Promise<Intent> {
    const before = await this.find(id);
    if (!before) throw notFound('No such intent');
    AuditScope.set({ targetType: 'intent', targetId: id, before: snapshot(before) });
    try {
      const [row] = await this.database.db
        .update(schema.intent)
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.typicalEvidence === undefined
            ? {}
            : { typicalEvidence: patch.typicalEvidence }),
          ...(patch.defaultPriority === undefined
            ? {}
            : { defaultPriority: patch.defaultPriority }),
          ...(patch.slaPolicyId === undefined ? {} : { slaPolicyId: patch.slaPolicyId }),
          ...(patch.allowedTools === undefined ? {} : { allowedTools: patch.allowedTools }),
          ...(patch.replyTemplates === undefined ? {} : { replyTemplates: patch.replyTemplates }),
          ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.intent.id, id))
        .returning();
      if (!row) throw notFound('No such intent');
      AuditScope.set({ after: snapshot(row) });
      return toApiIntent(row);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async remove(id: string): Promise<void> {
    const before = await this.find(id);
    if (!before) throw notFound('No such intent');
    AuditScope.set({ targetType: 'intent', targetId: id, before: snapshot(before) });
    try {
      await this.database.db.delete(schema.intent).where(eq(schema.intent.id, id));
    } catch (error) {
      if (isPgError(error, PG.foreignKeyViolation)) {
        throw conflict('Tickets use this intent; set it to inactive instead');
      }
      throw error;
    }
  }

  private translate(error: unknown): unknown {
    if (isPgError(error, PG.uniqueViolation))
      return conflict('An intent with this key already exists');
    if (isPgError(error, PG.foreignKeyViolation)) {
      return badRequest('slaPolicyId does not refer to an SLA policy');
    }
    return error;
  }
}
