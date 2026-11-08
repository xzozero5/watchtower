import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import { KB_AUDIT_ACTIONS, KB_JOBS, KB_QUEUES, type Role } from '@watchtower/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from './client.js';
import {
  KbReembedActorDisabledError,
  KbReembedActorNotFoundError,
  KbReembedError,
  KbReembedPermissionDeniedError,
  requestKbReembed,
} from './kb-reembed.js';
import { parseArgs } from './kb-reembed-cli.js';
import { auditLog } from './schema/audit.js';
import { rolePermissions, users } from './schema/auth.js';
import { organization, outbox } from './schema/ticketing.js';
import { createTestDatabase, type TestDatabase } from './testing.js';

const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@127.0.0.1:47042/watchtower';

let testDb: TestDatabase;
let appDb: Database;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  appDb = createDatabase({ url: testDb.appUrl, max: 4, applicationName: 'test-kb-reembed' });
});

afterAll(async () => {
  await appDb.close();
  await testDb.cleanup();
});

async function createUser(fields: {
  email: string;
  name?: string;
  role: Role;
  permissions?: string[];
  status?: string;
  orgId?: string | null;
  lockedUntil?: Date | null;
}) {
  const [created] = await testDb.owner.db
    .insert(users)
    .values({
      email: fields.email.toLowerCase(),
      name: fields.name ?? 'Test User',
      role: fields.role,
      permissions: fields.permissions ?? [],
      status: fields.status ?? 'active',
      orgId: fields.orgId ?? null,
      lockedUntil: fields.lockedUntil ?? null,
    })
    .returning();
  if (!created) throw new Error('user not created');
  return created;
}

describe('T-434a: kb:reembed CLI argument parsing', () => {
  it('parses --actor and --reason correctly', () => {
    expect(parseArgs(['--actor', 'head@example.com', '--reason', 'manual reindex'])).toEqual({
      actor: 'head@example.com',
      reason: 'manual reindex',
    });
    expect(parseArgs(['--actor=lead@example.com', '--reason=upgrade'])).toEqual({
      actor: 'lead@example.com',
      reason: 'upgrade',
    });
    expect(parseArgs(['--actor', 'c9b4e76a-5432-4111-8888-123456789abc'])).toEqual({
      actor: 'c9b4e76a-5432-4111-8888-123456789abc',
      reason: undefined,
    });
  });

  it('rejects invalid or missing arguments', () => {
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(['--reason', 'no actor'])).toBeNull();
    expect(parseArgs(['--actor'])).toBeNull();
    expect(parseArgs(['--actor', '--reason'])).toBeNull();
    expect(parseArgs(['--actor', 'head@example.com', '--unexpected'])).toBeNull();
    expect(parseArgs(['positional', '--actor', 'head@example.com'])).toBeNull();
  });
});

describe('T-434a: Actor & Permission Checks', () => {
  it('rejects when actor is not provided or empty', async () => {
    await expect(requestKbReembed(appDb, { actor: '' })).rejects.toThrow(KbReembedError);
    await expect(requestKbReembed(appDb, { actor: '   ' })).rejects.toThrow(KbReembedError);
  });

  it('rejects when actor does not exist in users table', async () => {
    await expect(requestKbReembed(appDb, { actor: 'nonexistent@example.com' })).rejects.toThrow(
      KbReembedActorNotFoundError,
    );

    await expect(requestKbReembed(appDb, { actor: randomUUID() })).rejects.toThrow(
      KbReembedActorNotFoundError,
    );
  });

  it('rejects when actor is disabled', async () => {
    const disabledHead = await createUser({
      email: 'disabled-head@example.com',
      role: 'head',
      status: 'disabled',
    });

    await expect(requestKbReembed(appDb, { actor: disabledHead.email })).rejects.toThrow(
      KbReembedActorDisabledError,
    );

    const disabledLead = await createUser({
      email: 'disabled-lead@example.com',
      role: 'lead',
      status: 'disabled',
    });

    await expect(requestKbReembed(appDb, { actor: disabledLead.id })).rejects.toThrow(
      KbReembedActorDisabledError,
    );
  });

  it('rejects when actor is locked (lockedUntil is in the future)', async () => {
    const lockedUser = await createUser({
      email: 'locked-head@example.com',
      role: 'head',
      status: 'active',
      lockedUntil: new Date(Date.now() + 3600_000),
    });

    await expect(requestKbReembed(appDb, { actor: lockedUser.email })).rejects.toThrow(
      KbReembedActorDisabledError,
    );
  });

  it('rejects unauthorized roles (client, dev, agent) and writes nothing to outbox', async () => {
    const [clientOrg] = await testDb.owner.db
      .insert(organization)
      .values({ name: 'Client Org' })
      .returning();
    if (!clientOrg) throw new Error('client org not created');

    const clientUser = await createUser({
      email: 'client@example.com',
      role: 'client',
      orgId: clientOrg.id,
    });
    const devUser = await createUser({ email: 'dev@example.com', role: 'dev' });
    const agentUser = await createUser({ email: 'agent@example.com', role: 'agent' });

    for (const actor of [clientUser, devUser, agentUser]) {
      await expect(requestKbReembed(appDb, { actor: actor.email })).rejects.toThrow(
        KbReembedPermissionDeniedError,
      );
    }

    // C-1: role = 'system' is rejected even if granted admin permissions in users.permissions
    const systemUser = await createUser({
      email: 'system-service@example.com',
      role: 'system',
      permissions: ['ai.provider.manage', 'kb.publish.break_glass', 'kb.approve'],
    });
    await expect(requestKbReembed(appDb, { actor: systemUser.email })).rejects.toThrow(
      KbReembedPermissionDeniedError,
    );

    // C-1: if admin permissions are revoked from role_permissions for lead, lead is denied
    await testDb.owner.db
      .delete(rolePermissions)
      .where(
        and(
          eq(rolePermissions.role, 'lead'),
          inArray(rolePermissions.permission, ['kb.approve', 'ai.emergency_switch']),
        ),
      );

    const strippedLead = await createUser({
      email: 'stripped-lead@example.com',
      role: 'lead',
    });
    await expect(requestKbReembed(appDb, { actor: strippedLead.email })).rejects.toThrow(
      KbReembedPermissionDeniedError,
    );

    // Restore role_permissions for lead
    await testDb.owner.db
      .insert(rolePermissions)
      .values([
        { role: 'lead', permission: 'kb.approve' },
        { role: 'lead', permission: 'ai.emergency_switch' },
      ])
      .onConflictDoNothing();

    // Verify outbox remains empty
    const outboxRows = await testDb.owner.db
      .select()
      .from(outbox)
      .where(eq(outbox.queue, KB_QUEUES.kb));
    expect(outboxRows).toHaveLength(0);
  });

  it('rejects invalid inputs via Zod validation (C-2: NUL byte and length limits)', async () => {
    await expect(requestKbReembed(appDb, { actor: 'lead@example.com\u0000' })).rejects.toThrow(
      KbReembedError,
    );

    await expect(
      requestKbReembed(appDb, { actor: 'lead@example.com', reason: 'bad\u0000reason' }),
    ).rejects.toThrow(KbReembedError);

    await expect(
      requestKbReembed(appDb, { actor: 'lead@example.com', reason: 'x'.repeat(1001) }),
    ).rejects.toThrow(KbReembedError);

    await expect(requestKbReembed(appDb, { actor: 'x'.repeat(321) })).rejects.toThrow(
      KbReembedError,
    );
  });
});

describe('T-434a: Transactional Enqueue + Audit + Idempotence', () => {
  it('enqueues reembed_all job and writes audit log in the same transaction for authorized actor', async () => {
    const headUser = await createUser({ email: 'authorized-head@example.com', role: 'head' });
    const reasonText = 'testing re-embed enqueue';

    const result = await requestKbReembed(appDb, {
      actor: headUser.email,
      reason: reasonText,
    });

    expect(result.enqueued).toBe(true);
    expect(result.status).toBe('enqueued');
    expect(result.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.outboxJobId).toBe(`reembed_all_${result.requestId}`);
    const outboxJobId = result.outboxJobId;
    if (!outboxJobId) throw new Error('outboxJobId missing');

    // Verify outbox row (C-2: minimal payload, no actorEmail or reason stored in Redis queue)
    const [outboxRow] = await testDb.owner.db
      .select()
      .from(outbox)
      .where(eq(outbox.jobId, outboxJobId));

    expect(outboxRow).toBeDefined();
    expect(outboxRow?.queue).toBe(KB_QUEUES.kb);
    expect(outboxRow?.jobName).toBe(KB_JOBS.reembedAll);
    expect(outboxRow?.status).toBe('pending');
    const outboxPayload = outboxRow?.payload as Record<string, unknown> | undefined;
    expect(outboxPayload?.requestId).toBe(result.requestId);
    expect(outboxPayload?.actorId).toBe(headUser.id);
    expect(typeof outboxPayload?.enqueuedAt).toBe('string');
    expect(outboxPayload).not.toHaveProperty('actorEmail');
    expect(outboxPayload).not.toHaveProperty('reason');

    // Verify audit log row (reason kept only in audit_log metadata)
    const [auditRow] = await testDb.owner.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, result.requestId));

    expect(auditRow).toBeDefined();
    expect(auditRow?.actorType).toBe('user');
    expect(auditRow?.actorId).toBe(headUser.id);
    expect(auditRow?.action).toBe(KB_AUDIT_ACTIONS.kbReembed);
    expect(auditRow?.outcome).toBe('success');
    expect(auditRow?.targetType).toBe('kb');
    expect(auditRow?.targetId).toBe('all');
    expect(auditRow?.metadata).toMatchObject({
      reason: reasonText,
      outboxJobId: result.outboxJobId,
      status: 'pending',
    });
  });

  it('is idempotent: repeated requests return existing requestId and do not create duplicate outbox jobs', async () => {
    const leadUser = await createUser({ email: 'authorized-lead@example.com', role: 'lead' });

    // The first request from previous test or this test already left a pending job
    const initialOutboxCount = (
      await testDb.owner.db.select().from(outbox).where(eq(outbox.queue, KB_QUEUES.kb))
    ).length;
    expect(initialOutboxCount).toBe(1);

    const initialAuditCount = (
      await testDb.owner.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, KB_AUDIT_ACTIONS.kbReembed))
    ).length;
    expect(initialAuditCount).toBe(1);

    // Call again while pending
    const secondResult = await requestKbReembed(appDb, {
      actor: leadUser.id, // using UUID this time
      reason: 'second attempt while pending',
    });

    expect(secondResult.enqueued).toBe(false);
    expect(secondResult.status).toBe('already_pending');
    expect(secondResult.requestId).toBeDefined();

    // Verify outbox count did not increase
    const currentOutboxRows = await testDb.owner.db
      .select()
      .from(outbox)
      .where(eq(outbox.queue, KB_QUEUES.kb));
    expect(currentOutboxRows).toHaveLength(initialOutboxCount);

    // Verify audit log did not duplicate
    const currentAuditRows = await testDb.owner.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, KB_AUDIT_ACTIONS.kbReembed));
    expect(currentAuditRows).toHaveLength(initialAuditCount);
  });

  it('allows a new reembed_all request after previous job has finished/sent', async () => {
    // Mark the pending outbox job as sent
    await testDb.owner.db
      .update(outbox)
      .set({ status: 'sent', finishedAt: new Date() })
      .where(eq(outbox.queue, KB_QUEUES.kb));

    const leadUser = await createUser({ email: 'lead2@example.com', role: 'lead' });
    const freshResult = await requestKbReembed(appDb, {
      actor: leadUser.email,
      reason: 'after previous job sent',
    });

    expect(freshResult.enqueued).toBe(true);
    expect(freshResult.status).toBe('enqueued');

    const pendingRows = await testDb.owner.db
      .select()
      .from(outbox)
      .where(eq(outbox.status, 'pending'));
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]?.jobId).toBe(freshResult.outboxJobId);
  });
});

describe('T-434a: CLI Executable Integration', () => {
  const cliScriptPath = resolve(process.cwd(), 'dist', 'kb-reembed-cli.js');

  const runCli = async (args: string[], envOverrides: Record<string, string> = {}) => {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [cliScriptPath, ...args], {
        env: {
          ...process.env,
          DATABASE_URL: testDb.appUrl,
          MIGRATION_DATABASE_URL: testDb.appUrl,
          ...envOverrides,
        },
      });
      return { code: 0, stdout, stderr };
    } catch (error: unknown) {
      const execError = error as { code?: number; stdout?: string; stderr?: string };
      return {
        code: execError.code ?? 1,
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? '',
      };
    }
  };

  it('exits with code 2 on missing or invalid args', async () => {
    const resNoArgs = await runCli([]);
    expect(resNoArgs.code).toBe(2);
    expect(resNoArgs.stderr).toContain('usage: kb-reembed-cli.js');

    const resBadFlag = await runCli(['--invalid']);
    expect(resBadFlag.code).toBe(2);
    expect(resBadFlag.stderr).toContain('usage: kb-reembed-cli.js');
  });

  it('exits with code 1 on unknown user and does not leak connection string or secrets', async () => {
    const res = await runCli(['--actor', 'no-such-user@example.com']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('kb:reembed refused: User not found: "no-such-user@example.com"');

    // N1 check: neither stdout nor stderr leaks database URL or password
    expect(res.stdout).not.toContain(testDb.appUrl);
    expect(res.stderr).not.toContain(testDb.appUrl);
    expect(res.stderr).not.toContain('watchtower@');
  });

  it('exits with code 1 on unauthorized role (agent)', async () => {
    const agent = await createUser({ email: 'cli-agent@example.com', role: 'agent' });
    const res = await runCli(['--actor', agent.email]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('kb:reembed refused: Permission denied');
  });

  it('exits with code 0 for authorized head user and prints clean requestId', async () => {
    // Clear any previous pending outbox job
    await testDb.owner.db
      .update(outbox)
      .set({ status: 'sent', finishedAt: new Date() })
      .where(eq(outbox.queue, KB_QUEUES.kb));

    const head = await createUser({ email: 'cli-head@example.com', role: 'head' });
    const res = await runCli(['--actor', head.email, '--reason', 'CLI test execution']);

    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/^kb:reembed requestId=[0-9a-f-]+ status=enqueued/);
    expect(res.stdout).not.toContain(testDb.appUrl);
    expect(res.stderr).toBe('');
  });
});
