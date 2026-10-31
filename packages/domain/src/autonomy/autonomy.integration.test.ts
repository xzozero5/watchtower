import { schema } from '@watchtower/db';
import { AUDIT_ACTIONS } from '@watchtower/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DomainError } from '../errors.js';
import { requireAiAction, requireCustomerSend, type PolicyGate } from '../policy.js';
import {
  addIntent,
  addOrg,
  addStaff,
  auditRows,
  startDomainTest,
  type DomainTestEnv,
} from '../testing/support.js';
import { createPolicyGate } from './gate.js';

let env: DomainTestEnv;
let gate: PolicyGate;

const AI = { type: 'ai', id: null } as const;
const SYSTEM = { type: 'system', id: null } as const;
const TICKET = '00000000-0000-4000-8000-0000000000aa';

beforeAll(async () => {
  env = await startDomainTest();
  gate = createPolicyGate({ db: env.database.db });
});
afterAll(async () => {
  await env.close();
});

async function setSwitch(key: string, on: boolean): Promise<void> {
  await env.db.owner.pool.query(
    `UPDATE ai_switch SET is_on = $2, reason = 'test', changed_by = NULL, changed_at = now() WHERE key = $1`,
    [key, on],
  );
}

describe('the real policy gate', () => {
  it('lets a person send, writes no audit row', async () => {
    const staff = await addStaff(env);
    const before = (await auditRows(env, AUDIT_ACTIONS.autonomyPolicyDenied)).length;
    await expect(
      gate.check({ ticketId: TICKET, channel: 'line', intentId: null, actor: staff.actor }),
    ).resolves.toEqual({ allowed: true, reason: 'human_staff' });
    expect((await auditRows(env, AUDIT_ACTIONS.autonomyPolicyDenied)).length).toBe(before);
  });

  it('refuses the AI sending on its own at every stage, and audits each denial', async () => {
    for (const stage of [0, 1, 2]) {
      const intent = await addIntent(env, { autonomyStage: stage });
      const decision = await gate.check({
        ticketId: TICKET,
        channel: 'gmail',
        intentId: intent.id,
        actor: AI,
        auditMeta: { ip: '203.0.113.9', requestId: 'req-denied' },
      });
      expect(decision).toEqual({ allowed: false, reason: 'ai_auto_send_disabled_phase1' });
    }
    const rows = (await auditRows(env, AUDIT_ACTIONS.autonomyPolicyDenied)).filter(
      (row) => row.requestId === 'req-denied',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      actorType: 'ai',
      outcome: 'denied',
      targetType: 'ticket',
      targetId: TICKET,
      ip: '203.0.113.9',
    });
    expect(rows[0]?.metadata).toMatchObject({
      reason: 'ai_auto_send_disabled_phase1',
      origin: 'ai_auto',
      channel: 'gmail',
      killSwitch: false,
    });
  });

  it('keeps the denial audit row when the request transaction rolls back', async () => {
    const intent = await addIntent(env);
    await expect(
      env.tx(async (tx) => {
        await requireCustomerSend(
          { policyGate: gate, auditMeta: { ip: null, requestId: 'req-rollback' } },
          { ticketId: TICKET, channel: 'line', intentId: intent.id, actor: AI },
        ).catch((error: unknown) => {
          expect(error).toBeInstanceOf(DomainError);
          throw error;
        });
        return tx;
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    const rows = (await auditRows(env, AUDIT_ACTIONS.autonomyPolicyDenied)).filter(
      (row) => row.requestId === 'req-rollback',
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a domain reply written by the AI, with the gate reason, and writes no message', async () => {
    const org = await addOrg(env);
    const staff = await addStaff(env);
    const intent = await addIntent(env);
    const created = await env.tx((tx) =>
      env.domain.tickets.create(tx, env.ctx(staff.actor), {
        orgId: org.id,
        subject: 'S',
        body: 'B',
        intentId: intent.id,
        requester: { email: `${crypto.randomUUID()}@example.test`, name: 'Requester' },
      }),
    );
    const ticketId = created.value.ticket.id;
    const error = await env
      .tx((tx) =>
        env.domain.tickets.reply(tx, env.ctx(AI, { policyGate: gate }), {
          ref: ticketId,
          reply: { body: 'automatic answer' },
          sender: { kind: 'staff', userId: staff.id },
        }),
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'policy_denied',
      details: { reason: 'ai_auto_send_disabled_phase1' },
    });
    const messages = await env.db.owner.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticketId));
    expect(messages.filter((message) => message.direction === 'outbound')).toHaveLength(0);
  });

  it('allows AI classification at any stage, refuses it under the kill switch, and audits the refusal', async () => {
    const intent = await addIntent(env, { autonomyStage: 0 });
    const ask = () =>
      gate.checkAiAction({
        ticketId: TICKET,
        intentId: intent.id,
        actor: AI,
        action: 'classify',
        auditMeta: { ip: null, requestId: 'req-kill' },
      });
    await expect(ask()).resolves.toEqual({ allowed: true, reason: 'ai_internal_allowed' });
    await expect(
      gate.checkAiAction({ ticketId: null, intentId: null, actor: AI, action: 'classify' }),
    ).resolves.toMatchObject({ allowed: true });

    await setSwitch('ai_kill_switch', true);
    try {
      await expect(ask()).resolves.toEqual({ allowed: false, reason: 'kill_switch_on' });
      await expect(
        requireAiAction(
          { policyGate: gate },
          {
            ticketId: null,
            intentId: null,
            actor: AI,
            action: 'summarize',
          },
        ),
      ).rejects.toMatchObject({ code: 'policy_denied', details: { reason: 'kill_switch_on' } });
    } finally {
      await setSwitch('ai_kill_switch', false);
    }
    await expect(ask()).resolves.toMatchObject({ allowed: true });
    const rows = (await auditRows(env, AUDIT_ACTIONS.autonomyPolicyDenied)).filter(
      (row) => row.requestId === 'req-kill',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({
      reason: 'kill_switch_on',
      action: 'classify',
      killSwitch: true,
    });
  });

  it('keeps sending safe auto-acks under the kill switch and refuses an unlisted template', async () => {
    await setSwitch('ai_kill_switch', true);
    try {
      await expect(
        gate.check({
          ticketId: TICKET,
          channel: 'line',
          intentId: null,
          actor: SYSTEM,
          origin: 'system_template',
          templateKey: 'auto_ack.received',
        }),
      ).resolves.toEqual({ allowed: true, reason: 'safe_template_auto_ack' });
      await expect(
        gate.check({
          ticketId: TICKET,
          channel: 'line',
          intentId: null,
          actor: SYSTEM,
          origin: 'system_template',
          templateKey: 'custom_reply',
        }),
      ).resolves.toEqual({ allowed: false, reason: 'template_not_allowlisted' });
    } finally {
      await setSwitch('ai_kill_switch', false);
    }
  });

  it('lets a person send an AI draft they approved, and refuses one nobody approved', async () => {
    const staff = await addStaff(env);
    const intent = await addIntent(env, { autonomyStage: 1 });
    const base = {
      ticketId: TICKET,
      channel: 'gmail',
      intentId: intent.id,
      actor: staff.actor,
      origin: 'ai_approved' as const,
    };
    await expect(gate.check({ ...base, approvedBy: staff.id })).resolves.toEqual({
      allowed: true,
      reason: 'ai_draft_human_approved',
    });
    await expect(gate.check(base)).resolves.toEqual({ allowed: false, reason: 'approval_missing' });
    const stageZero = await addIntent(env, { autonomyStage: 0 });
    await expect(
      gate.check({ ...base, intentId: stageZero.id, approvedBy: staff.id }),
    ).resolves.toEqual({ allowed: false, reason: 'stage_0_no_customer_draft' });
  });

  it('fails closed: an unknown intent id, a damaged switch table and a broken database are refusals', async () => {
    await expect(
      gate.checkAiAction({
        ticketId: null,
        intentId: '00000000-0000-4000-8000-00000000dead',
        actor: AI,
        action: 'classify',
      }),
    ).resolves.toEqual({ allowed: false, reason: 'intent_not_found' });

    // A switch row that is missing reads as ON. The schema owner removes one for this test.
    await env.db.owner.pool.query(`DELETE FROM ai_switch WHERE key = 'ai_kill_switch'`);
    try {
      await expect(
        gate.checkAiAction({ ticketId: null, intentId: null, actor: AI, action: 'classify' }),
      ).resolves.toEqual({ allowed: false, reason: 'kill_switch_on' });
    } finally {
      await env.db.owner.pool.query(`INSERT INTO ai_switch (key) VALUES ('ai_kill_switch')`);
    }

    const broken = createPolicyGate({
      db: {
        select: () => {
          throw new Error('database down');
        },
        insert: () => {
          throw new Error('database down');
        },
      } as never,
    });
    await expect(
      requireCustomerSend(
        { policyGate: broken },
        {
          ticketId: TICKET,
          channel: 'line',
          intentId: null,
          actor: AI,
        },
      ),
    ).rejects.toThrow('database down');
  });
});

describe('domain.autonomy.setSwitch', () => {
  it('flips a switch with a reason, audits it in the transaction, and reports no-ops without writing', async () => {
    const head = await addStaff(env, 'head');
    const ctx = env.ctx(head.actor);
    const on = await env.tx((tx) =>
      env.domain.autonomy.setSwitch(tx, ctx, {
        switch: 'ai_kill_switch',
        on: true,
        reason: 'provider is misbehaving',
      }),
    );
    expect(on.audited).toBe(true);
    expect(on.value.changed).toBe(true);
    expect(on.value.switches.find((s) => s.key === 'ai_kill_switch')).toMatchObject({
      on: true,
      reason: 'provider is misbehaving',
      changedBy: head.id,
    });

    const again = await env.tx((tx) =>
      env.domain.autonomy.setSwitch(tx, ctx, {
        switch: 'ai_kill_switch',
        on: true,
        reason: 'x again',
      }),
    );
    expect(again.value.changed).toBe(false);
    expect(again.audited).toBe(false);

    const off = await env.tx((tx) =>
      env.domain.autonomy.setSwitch(tx, ctx, {
        switch: 'ai_kill_switch',
        on: false,
        reason: 'resolved upstream',
      }),
    );
    expect(off.value.changed).toBe(true);

    const rows = (await auditRows(env, AUDIT_ACTIONS.autonomySwitchSet)).filter(
      (row) => row.actorId === head.id,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => (row.after as { on: boolean }).on).toSorted()).toEqual([false, true]);
    expect(rows[0]).toMatchObject({
      ip: '203.0.113.7',
      requestId: 'req-test',
      targetType: 'ai_switch',
    });
  });

  it('needs a reason and a person, and a rolled-back flip leaves no audit row', async () => {
    const head = await addStaff(env, 'head');
    await expect(
      env.tx((tx) =>
        env.domain.autonomy.setSwitch(tx, env.ctx(head.actor), {
          switch: 'ai_kill_switch',
          on: true,
          reason: '  ',
        }),
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      env.tx((tx) =>
        env.domain.autonomy.setSwitch(tx, env.ctx(AI), {
          switch: 'ai_kill_switch',
          on: true,
          reason: 'AI tries',
        }),
      ),
    ).rejects.toMatchObject({ code: 'policy_denied', details: { reason: 'actor_not_a_person' } });
    await expect(
      env.tx(async (tx) => {
        await env.domain.autonomy.setSwitch(tx, env.ctx(head.actor), {
          switch: 'ai_stage_cap_pinned',
          on: true,
          reason: 'rolled back',
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const state = await env.domain.autonomy.read(env.database.db);
    expect(state.switches.every((s) => !s.on)).toBe(true);
    expect(
      (await auditRows(env, AUDIT_ACTIONS.autonomySwitchSet)).filter(
        (row) => row.actorId === head.id,
      ),
    ).toHaveLength(0);
  });
});

describe('domain.autonomy.setIntentStage', () => {
  const change = (
    actorId: string,
    intentId: string,
    input: { stage?: number; pinned?: boolean; reason?: string },
  ) =>
    env.tx((tx) =>
      env.domain.autonomy.setIntentStage(tx, env.ctx({ type: 'user', id: actorId }), {
        intentId,
        reason: 'because',
        ...input,
      }),
    );

  it('changes the stage within 0-2, records the history and the audit row together', async () => {
    const lead = await addStaff(env, 'lead');
    const intent = await addIntent(env);
    const result = await change(lead.id, intent.id, { stage: 1, reason: 'drafts need work' });
    expect(result.audited).toBe(true);
    expect(result.value).toMatchObject({
      changed: true,
      intent: { stage: 1, effectiveStage: 1, pinned: false },
    });
    const history = await env.database.db
      .select()
      .from(schema.intentAutonomyHistory)
      .where(eq(schema.intentAutonomyHistory.intentId, intent.id));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      change: 'stage',
      fromStage: 2,
      toStage: 1,
      reason: 'drafts need work',
      changedBy: lead.id,
    });
    const audit = (await auditRows(env, AUDIT_ACTIONS.autonomyStageSet)).filter(
      (row) => row.targetId === intent.id,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ before: { stage: 2 }, after: { stage: 1 } });

    const noop = await change(lead.id, intent.id, { stage: 1 });
    expect(noop.value.changed).toBe(false);
    expect(noop.audited).toBe(false);
  });

  it('refuses stage 3 and above in the domain, before it reaches the database', async () => {
    const lead = await addStaff(env, 'lead');
    const intent = await addIntent(env);
    for (const stage of [3, 4, 99]) {
      await expect(change(lead.id, intent.id, { stage })).rejects.toMatchObject({
        code: 'policy_denied',
        details: { reason: 'stage_requires_owner' },
      });
    }
    await expect(change(lead.id, intent.id, { stage: -1 })).rejects.toMatchObject({
      code: 'bad_request',
    });
    const [row] = await env.database.db
      .select()
      .from(schema.intent)
      .where(eq(schema.intent.id, intent.id));
    expect(row?.autonomyStage).toBe(2);
  });

  it('honours the pin and the cap switch with conflicts, and never raises a stage 0/1 by itself', async () => {
    const head = await addStaff(env, 'head');
    const intent = await addIntent(env, { autonomyStage: 0 });
    await change(head.id, intent.id, { pinned: true, reason: 'freeze for the audit' });
    await expect(change(head.id, intent.id, { stage: 1 })).rejects.toMatchObject({
      code: 'conflict',
    });
    const unpinned = await change(head.id, intent.id, { pinned: false, reason: 'audit over' });
    expect(unpinned.value.intent).toMatchObject({ stage: 0, pinned: false });

    await env.tx((tx) =>
      env.domain.autonomy.setSwitch(tx, env.ctx(head.actor), {
        switch: 'ai_stage_cap_pinned',
        on: true,
        reason: 'incident',
      }),
    );
    try {
      await expect(change(head.id, intent.id, { stage: 1 })).rejects.toMatchObject({
        code: 'conflict',
      });
      const state = await env.domain.autonomy.read(env.database.db);
      expect(state.intents.find((candidate) => candidate.id === intent.id)).toMatchObject({
        stage: 0,
        effectiveStage: 0,
      });
      const lowered = await addIntent(env);
      await expect(change(head.id, lowered.id, { stage: 1 })).resolves.toMatchObject({
        value: { changed: true },
      });
    } finally {
      await setSwitch('ai_stage_cap_pinned', false);
    }
  });

  it('needs a person, a reason and an existing intent', async () => {
    const lead = await addStaff(env, 'lead');
    const intent = await addIntent(env);
    await expect(
      env.tx((tx) =>
        env.domain.autonomy.setIntentStage(tx, env.ctx(AI), {
          intentId: intent.id,
          stage: 1,
          reason: 'AI tries',
        }),
      ),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(change(lead.id, intent.id, { stage: 1, reason: ' ' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(
      change(lead.id, '00000000-0000-4000-8000-000000000000', { stage: 1 }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(change(lead.id, intent.id, {})).rejects.toMatchObject({ code: 'bad_request' });
  });
});
