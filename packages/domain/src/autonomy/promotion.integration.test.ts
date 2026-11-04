import { schema } from '@watchtower/db';
import { AUDIT_ACTIONS } from '@watchtower/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addIntent,
  addStaff,
  auditRows,
  startDomainTest,
  type DomainTestEnv,
} from '../testing/support.js';

// ADR-025: the thin callers of the stage 3 doors (migration 0096) over a real Postgres, running as the
// restricted application role. The rules themselves are tested in packages/db; this checks the
// translation of the answers into DomainError and the audit rows.
let env: DomainTestEnv;
let head: Awaited<ReturnType<typeof addStaff>>;
let owner: Awaited<ReturnType<typeof addStaff>>;
let agent: Awaited<ReturnType<typeof addStaff>>;

beforeAll(async () => {
  env = await startDomainTest();
  head = await addStaff(env, 'head');
  agent = await addStaff(env, 'agent');
  owner = await addStaff(env, 'head');
  await env.db.owner.pool.query(
    `UPDATE users SET permissions = ARRAY['ai.autonomy.owner_approve'] WHERE id = $1`,
    [owner.id],
  );
});
afterAll(async () => {
  await env.close();
});

async function greenReport(intentId: string): Promise<string> {
  // The schema owner writes the fixture: the application role cannot insert a report (migration 0108), and a
  // window cannot start before the intent existed, so the intent is made old enough for it.
  await env.db.owner.db
    .update(schema.intent)
    .set({ createdAt: new Date(Date.now() - 90 * 86_400_000) })
    .where(eq(schema.intent.id, intentId));
  const [row] = await env.db.owner.db
    .insert(schema.autonomyGateReport)
    .values({
      intentId,
      status: 'green',
      triggerKind: 'on_demand',
      windowStart: new Date(Date.now() - 30 * 86_400_000),
      windowEnd: new Date(),
    })
    .returning({ id: schema.autonomyGateReport.id });
  if (row === undefined) throw new Error('report insert returned no row');
  return row.id;
}

const request = (actor: typeof head, intentId: string, gateReportId: string, reason = 'ready') =>
  env.tx((tx) =>
    env.domain.autonomy.requestPromotion(tx, env.ctx(actor.actor), {
      intentId,
      gateReportId,
      reason,
    }),
  );

describe('promotion through the domain', () => {
  it('asks, approves with re-auth and the key, applies, and audits each step', async () => {
    const intent = await addIntent(env);
    const report = await greenReport(intent.id);
    const { value } = await request(head, intent.id, report);

    const approved = await env.tx((tx) =>
      env.domain.autonomy.decidePromotion(tx, env.ctx(owner.actor), {
        promotionId: value.promotionId,
        approve: true,
        reason: 'looks good to me',
        reauthAt: new Date(),
        confirmKey: intent.key,
      }),
    );
    expect(approved.value).toEqual({ status: 'approved', selfApproved: false });

    const applied = await env.tx((tx) =>
      env.domain.autonomy.applyPromotion(tx, env.ctx(owner.actor), {
        promotionId: value.promotionId,
      }),
    );
    expect(applied.value).toEqual({ status: 'applied' });
    const [row] = await env.database.db
      .select({ stage: schema.intent.autonomyStage })
      .from(schema.intent)
      .where(eq(schema.intent.id, intent.id));
    expect(row?.stage).toBe(3);

    for (const action of [
      AUDIT_ACTIONS.autonomyPromotionRequested,
      AUDIT_ACTIONS.autonomyPromotionDecided,
      AUDIT_ACTIONS.autonomyPromoted,
    ]) {
      const entries = (await auditRows(env, action)).filter(
        (entry) => entry.targetId === intent.id,
      );
      expect(entries, action).toHaveLength(1);
    }
    const decided = (await auditRows(env, AUDIT_ACTIONS.autonomyPromotionDecided)).find(
      (entry) => entry.targetId === intent.id,
    );
    expect(decided?.metadata).toMatchObject({ self_approved: false, decision: 'approved' });
  });

  it('flags the owner approving their own request in the audit row', async () => {
    const intent = await addIntent(env);
    const report = await greenReport(intent.id);
    const { value } = await request(owner, intent.id, report);
    const decided = await env.tx((tx) =>
      env.domain.autonomy.decidePromotion(tx, env.ctx(owner.actor), {
        promotionId: value.promotionId,
        approve: true,
        reason: 'my own request',
        reauthAt: new Date(),
        confirmKey: intent.key,
      }),
    );
    expect(decided.value.selfApproved).toBe(true);
    const entry = (await auditRows(env, AUDIT_ACTIONS.autonomyPromotionDecided)).find(
      (candidate) => candidate.targetId === intent.id,
    );
    expect(entry?.metadata).toMatchObject({ self_approved: true });
  });

  it('turns the database answers into domain errors', async () => {
    const intent = await addIntent(env);
    const report = await greenReport(intent.id);
    // Not allowed to ask.
    await expect(request(agent, intent.id, report)).rejects.toMatchObject({ code: 'forbidden' });
    // Not eligible: the report names another intent.
    const other = await addIntent(env);
    await expect(request(head, intent.id, await greenReport(other.id))).rejects.toMatchObject({
      code: 'policy_denied',
      details: { reason: 'report_not_found' },
    });
    await expect(request(head, intent.id, report, 'no')).rejects.toMatchObject({
      code: 'bad_request',
    });
    const { value } = await request(head, intent.id, report);
    await expect(request(head, intent.id, report)).rejects.toMatchObject({ code: 'conflict' });
    // Approving needs the owner permission, a fresh re-auth and the key.
    const decide = (actor: typeof head, patch: { reauthAt?: Date; confirmKey?: string }) =>
      env.tx((tx) =>
        env.domain.autonomy.decidePromotion(tx, env.ctx(actor.actor), {
          promotionId: value.promotionId,
          approve: true,
          reason: 'trying',
          confirmKey: intent.key,
          reauthAt: new Date(),
          ...patch,
        }),
      );
    await expect(decide(head, {})).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      decide(owner, { reauthAt: new Date(Date.now() - 10 * 60_000) }),
    ).rejects.toMatchObject({
      code: 'policy_denied',
      details: { reason: 'reauth_required' },
    });
    await expect(decide(owner, { confirmKey: 'nope' })).rejects.toMatchObject({
      code: 'policy_denied',
      details: { reason: 'confirm_key_mismatch' },
    });
    // The stage never moved, and the failed attempts left no "decided" audit row.
    expect(
      (await auditRows(env, AUDIT_ACTIONS.autonomyPromotionDecided)).filter(
        (entry) => entry.targetId === intent.id,
      ),
    ).toHaveLength(0);
  });

  it('rolls back by itself, once, with the evidence in the audit row', async () => {
    const intent = await addIntent(env);
    const report = await greenReport(intent.id);
    const { value } = await request(owner, intent.id, report);
    await env.tx((tx) =>
      env.domain.autonomy.decidePromotion(tx, env.ctx(owner.actor), {
        promotionId: value.promotionId,
        approve: true,
        reason: 'ok go ahead',
        reauthAt: new Date(),
        confirmKey: intent.key,
      }),
    );
    await env.tx((tx) =>
      env.domain.autonomy.applyPromotion(tx, env.ctx(owner.actor), {
        promotionId: value.promotionId,
      }),
    );
    const system = { type: 'system', id: null } as const;
    const first = await env.tx((tx) =>
      env.domain.autonomy.rollbackIntent(tx, env.ctx(system), {
        intentId: intent.id,
        reason: 'policy violation found',
        evidence: { violations: 1 },
      }),
    );
    expect(first.value).toEqual({ rolledBack: true });
    const second = await env.tx((tx) =>
      env.domain.autonomy.rollbackIntent(tx, env.ctx(system), {
        intentId: intent.id,
        reason: 'policy violation found',
      }),
    );
    expect(second.value).toEqual({ rolledBack: false });
    const entries = (await auditRows(env, AUDIT_ACTIONS.autonomyAutoRollback)).filter(
      (entry) => entry.targetId === intent.id,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.metadata).toMatchObject({ evidence: { violations: 1 } });
  });

  it('changes the auto-send rules for a head only, with an audit row', async () => {
    const intent = await addIntent(env);
    await expect(
      env.tx((tx) =>
        env.domain.autonomy.setAutosend(tx, env.ctx(agent.actor), {
          intentId: intent.id,
          minScore: 0.9,
          reason: 'stricter',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const result = await env.tx((tx) =>
      env.domain.autonomy.setAutosend(tx, env.ctx(head.actor), {
        intentId: intent.id,
        minScore: 0.9,
        shadow: true,
        reason: 'stricter and watch',
      }),
    );
    expect(result.value).toEqual({ changed: true });
    const entry = (await auditRows(env, AUDIT_ACTIONS.autonomyAutosendConfigSet)).find(
      (candidate) => candidate.targetId === intent.id,
    );
    expect(entry?.metadata).toMatchObject({ minScore: 0.9, shadow: true });
  });
});
