import { randomUUID } from 'node:crypto';

import {
  KB_AUDIT_ACTIONS,
  KB_JOBS,
  KB_OUTBOX_JOB_OPTIONS,
  KB_QUEUES,
  isHeadOnlyPermission,
  isPermission,
  kbReembedRequestSchema,
  type ReembedAllJob,
  type Role,
} from '@watchtower/shared';
import { and, desc, eq, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { enqueueOutbox } from './outbox.js';
import { auditLog } from './schema/audit.js';
import { rolePermissions, users } from './schema/auth.js';
import { outbox } from './schema/ticketing.js';

export class KbReembedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KbReembedError';
  }
}

export class KbReembedActorNotFoundError extends KbReembedError {
  constructor(actor: string) {
    super(`User not found: "${actor}"`);
    this.name = 'KbReembedActorNotFoundError';
  }
}

export class KbReembedActorDisabledError extends KbReembedError {
  constructor(actor: string) {
    super(`User is not active or is locked: "${actor}"`);
    this.name = 'KbReembedActorDisabledError';
  }
}

export class KbReembedPermissionDeniedError extends KbReembedError {
  constructor(actor: string, role: string) {
    super(
      `Permission denied: user "${actor}" with role "${role}" is not authorized to trigger KB re-embed`,
    );
    this.name = 'KbReembedPermissionDeniedError';
  }
}

export interface RequestKbReembedInput {
  /** Email or user UUID */
  readonly actor: string;
  readonly reason?: string | null;
}

export interface RequestKbReembedResult {
  readonly enqueued: boolean;
  readonly status: 'enqueued' | 'already_pending';
  readonly requestId: string;
  readonly outboxJobId?: string;
}

const ALLOWED_ADMIN_ROLES: ReadonlySet<Role> = new Set(['head', 'lead']);

const KB_ADMIN_PERMISSIONS: ReadonlySet<string> = new Set([
  'kb.publish.break_glass',
  'ai.provider.manage',
  'ai.emergency_switch',
  'kb.approve',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates the actor, checks permissions against actual role_permissions + user.permissions,
 * checks idempotence, and enqueues a `reembed_all` outbox job with an audit log row in a single
 * transaction (ADR-033 §7).
 */
export async function requestKbReembed(
  database: Database,
  input: RequestKbReembedInput,
): Promise<RequestKbReembedResult> {
  const parsed = kbReembedRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new KbReembedError(
      `Invalid request: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
    );
  }
  const { actor, reason } = parsed.data;

  return database.db.transaction(async (tx) => {
    // 1. Resolve user by ID or Email
    const isUuid = UUID_REGEX.test(actor);
    const userQuery = isUuid
      ? tx
          .select({
            id: users.id,
            email: users.email,
            role: users.role,
            permissions: users.permissions,
            status: users.status,
            lockedUntil: users.lockedUntil,
          })
          .from(users)
          .where(eq(users.id, actor))
          .for('share')
          .limit(1)
      : tx
          .select({
            id: users.id,
            email: users.email,
            role: users.role,
            permissions: users.permissions,
            status: users.status,
            lockedUntil: users.lockedUntil,
          })
          .from(users)
          .where(sql`lower(${users.email}) = lower(${actor})`)
          .for('share')
          .limit(1);

    const [user] = await userQuery;

    if (!user) {
      throw new KbReembedActorNotFoundError(actor);
    }

    // 2. Active status & lock check using DB clock (C-3)
    const clockResult = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
    const clockVal = clockResult.rows[0]?.now;
    const dbNow = clockVal instanceof Date ? clockVal : new Date();

    if (user.status !== 'active' || (user.lockedUntil !== null && user.lockedUntil > dbNow)) {
      throw new KbReembedActorDisabledError(actor);
    }

    // 3. Permission & Role check:
    // C-1: Allow-list human admin roles only (head, lead). Reject client, dev, agent, system, etc.
    const userRole = user.role as Role;
    if (!ALLOWED_ADMIN_ROLES.has(userRole)) {
      throw new KbReembedPermissionDeniedError(actor, user.role);
    }

    // Query effective permissions from role_permissions table
    const rolePermRows = await tx
      .select({ permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(eq(rolePermissions.role, userRole));

    const rawPermissions = [...rolePermRows.map((r) => r.permission), ...user.permissions];

    // Filter permissions: valid vocabulary + head-only enforcement
    const effectivePermissions = new Set(
      rawPermissions.filter(
        (p) => isPermission(p) && (userRole === 'head' || !isHeadOnlyPermission(p)),
      ),
    );

    const hasAdminPermission = Array.from(KB_ADMIN_PERMISSIONS).some((perm) =>
      effectivePermissions.has(perm),
    );

    if (!hasAdminPermission) {
      throw new KbReembedPermissionDeniedError(actor, user.role);
    }

    // 4. Concurrency lock to serialize reembed requests
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('kb_reembed_enqueue'))`);

    // 5. Idempotence check: is there a pending `reembed_all` job in outbox?
    const pendingRows = await tx
      .select({
        id: outbox.id,
        jobId: outbox.jobId,
        payload: outbox.payload,
        createdAt: outbox.createdAt,
      })
      .from(outbox)
      .where(
        and(
          eq(outbox.queue, KB_QUEUES.kb),
          eq(outbox.jobName, KB_JOBS.reembedAll),
          eq(outbox.status, 'pending'),
        ),
      )
      .orderBy(desc(outbox.createdAt))
      .limit(1);

    const [pending] = pendingRows;
    if (pending !== undefined) {
      const payload = pending.payload as Record<string, unknown> | null;
      const existingRequestId =
        typeof payload?.requestId === 'string' && payload.requestId.length > 0
          ? payload.requestId
          : pending.id;

      return {
        enqueued: false,
        status: 'already_pending',
        requestId: existingRequestId,
        outboxJobId: pending.jobId,
      };
    }

    // 6. Enqueue new `reembed_all` job (C-2: minimal payload without PII or free text)
    const requestId = randomUUID();
    const jobId = `reembed_all_${requestId}`;
    const payload: ReembedAllJob = {
      requestId,
      actorId: user.id,
      enqueuedAt: dbNow.toISOString(),
    };

    await enqueueOutbox(tx, {
      queue: KB_QUEUES.kb,
      jobName: KB_JOBS.reembedAll,
      jobId,
      payload,
      options: KB_OUTBOX_JOB_OPTIONS,
    });

    // 7. Write audit log (reason kept only in audit_log.metadata)
    await tx.insert(auditLog).values({
      actorType: 'user',
      actorId: user.id,
      action: KB_AUDIT_ACTIONS.kbReembed,
      outcome: 'success',
      targetType: 'kb',
      targetId: 'all',
      requestId,
      metadata: {
        reason: reason ?? null,
        outboxJobId: jobId,
        status: 'pending',
      },
    });

    return {
      enqueued: true,
      status: 'enqueued',
      requestId,
      outboxJobId: jobId,
    };
  });
}
