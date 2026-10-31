import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  STAFF_ROLES,
  type CreateTeamQueue,
  type TeamQueue,
  type UpdateTeamQueue,
} from '@watchtower/shared';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';

import { AuditScope } from '../audit/audit-scope.js';
import { badRequest, conflict, notFound } from '../auth/http-errors.js';
import { PG, isPgError } from '../common/db-errors.js';
import { DATABASE } from '../database/database.module.js';
import type { DbTransaction } from '../realtime/unit-of-work.js';

type QueueRow = typeof schema.teamQueue.$inferSelect;

interface MemberView {
  readonly userId: string;
  readonly name: string;
  readonly role: string;
  readonly status: string;
}

function toApiQueue(row: QueueRow, members: readonly MemberView[]): TeamQueue {
  return {
    id: row.id,
    name: row.name,
    assignmentMode: row.assignmentMode === 'round_robin' ? 'round_robin' : 'manual',
    isDefault: row.isDefault,
    members: [...members],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Anyone who can be handed a ticket: active staff. (Shifts do not exist yet, so on-shift is `[ASSUMED]` to mean active.) */
export async function assertAssignableStaff(
  executor: Pick<Database['db'], 'select'>,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const rows = await executor
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        inArray(schema.users.id, [...userIds]),
        eq(schema.users.status, 'active'),
        inArray(schema.users.role, [...STAFF_ROLES]),
      ),
    );
  const found = new Set(rows.map((row) => row.id));
  const missing = userIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw badRequest('Every member must be an existing, active staff user');
  }
}

@Injectable()
export class TeamQueuesService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async list(): Promise<TeamQueue[]> {
    const queues = await this.database.db
      .select()
      .from(schema.teamQueue)
      .orderBy(asc(schema.teamQueue.name));
    return this.withMembers(queues);
  }

  async get(id: string): Promise<TeamQueue> {
    const [row] = await this.database.db
      .select()
      .from(schema.teamQueue)
      .where(eq(schema.teamQueue.id, id))
      .limit(1);
    if (!row) throw notFound('No such queue');
    const [queue] = await this.withMembers([row]);
    if (!queue) throw notFound('No such queue');
    return queue;
  }

  async create(input: CreateTeamQueue): Promise<TeamQueue> {
    const memberIds = [...new Set(input.memberIds)];
    await assertAssignableStaff(this.database.db, memberIds);
    try {
      const id = await this.database.db.transaction(async (tx) => {
        if (input.isDefault) await this.clearDefault(tx, undefined);
        const [row] = await tx
          .insert(schema.teamQueue)
          .values({
            name: input.name,
            assignmentMode: input.assignmentMode,
            isDefault: input.isDefault,
          })
          .returning({ id: schema.teamQueue.id });
        if (!row) throw new Error('queue insert returned no row');
        if (memberIds.length > 0) {
          await tx
            .insert(schema.teamQueueMember)
            .values(memberIds.map((userId) => ({ queueId: row.id, userId })));
        }
        return row.id;
      });
      const created = await this.get(id);
      AuditScope.set({ targetType: 'team_queue', targetId: id, after: this.snapshot(created) });
      return created;
    } catch (error) {
      throw this.translate(error);
    }
  }

  async update(id: string, patch: UpdateTeamQueue): Promise<TeamQueue> {
    const before = await this.get(id);
    AuditScope.set({ targetType: 'team_queue', targetId: id, before: this.snapshot(before) });
    const memberIds = patch.memberIds === undefined ? undefined : [...new Set(patch.memberIds)];
    if (memberIds) await assertAssignableStaff(this.database.db, memberIds);
    try {
      await this.database.db.transaction(async (tx) => {
        if (patch.isDefault === true) await this.clearDefault(tx, id);
        await tx
          .update(schema.teamQueue)
          .set({
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.assignmentMode === undefined ? {} : { assignmentMode: patch.assignmentMode }),
            ...(patch.isDefault === undefined ? {} : { isDefault: patch.isDefault }),
            updatedAt: sql`now()`,
          })
          .where(eq(schema.teamQueue.id, id));
        if (memberIds) {
          await tx.delete(schema.teamQueueMember).where(eq(schema.teamQueueMember.queueId, id));
          if (memberIds.length > 0) {
            await tx
              .insert(schema.teamQueueMember)
              .values(memberIds.map((userId) => ({ queueId: id, userId })));
          }
        }
      });
    } catch (error) {
      throw this.translate(error);
    }
    const after = await this.get(id);
    AuditScope.set({ after: this.snapshot(after) });
    return after;
  }

  async remove(id: string): Promise<void> {
    const before = await this.get(id);
    AuditScope.set({ targetType: 'team_queue', targetId: id, before: this.snapshot(before) });
    // Tickets keep existing: their queue_id becomes null (ON DELETE SET NULL).
    await this.database.db.delete(schema.teamQueue).where(eq(schema.teamQueue.id, id));
  }

  private snapshot(queue: TeamQueue): Record<string, unknown> {
    return {
      id: queue.id,
      name: queue.name,
      assignmentMode: queue.assignmentMode,
      isDefault: queue.isDefault,
      memberIds: queue.members.map((member) => member.userId),
    };
  }

  private async clearDefault(tx: DbTransaction, except: string | undefined): Promise<void> {
    await tx
      .update(schema.teamQueue)
      .set({ isDefault: false })
      .where(
        and(
          eq(schema.teamQueue.isDefault, true),
          except ? ne(schema.teamQueue.id, except) : undefined,
        ),
      );
  }

  private async withMembers(queues: readonly QueueRow[]): Promise<TeamQueue[]> {
    if (queues.length === 0) return [];
    const members = await this.database.db
      .select({
        queueId: schema.teamQueueMember.queueId,
        userId: schema.users.id,
        name: schema.users.name,
        role: schema.users.role,
        status: schema.users.status,
      })
      .from(schema.teamQueueMember)
      .innerJoin(schema.users, eq(schema.users.id, schema.teamQueueMember.userId))
      .where(
        inArray(
          schema.teamQueueMember.queueId,
          queues.map((queue) => queue.id),
        ),
      )
      .orderBy(asc(schema.users.name), asc(schema.users.id));
    return queues.map((queue) =>
      toApiQueue(
        queue,
        members.filter((member) => member.queueId === queue.id),
      ),
    );
  }

  private translate(error: unknown): unknown {
    if (isPgError(error, PG.uniqueViolation))
      return conflict('A queue with this name already exists');
    return error;
  }
}
