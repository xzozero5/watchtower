import type {
  AutonomyState,
  Intent,
  IntentAutonomyChange,
  SetAiSwitchResult,
} from '@watchtower/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DOMAIN, type Domain } from '../domain/domain.module.js';
import { startHarness, type Harness } from '../testing/harness.js';
import { apiIntent, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// T-112a: autonomy stage per intent, the two AI switches, and the policy gate wired into the api.

let h: Harness;
let app: Pool;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;
let counter = 0;

const owner = () => h.db.owner.pool;

beforeAll(async () => {
  h = await startHarness();
  app = new Pool({ connectionString: h.db.appUrl, max: 2 });
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  const org = await lead.client.post<{ id: string }>('/v1/orgs', { name: 'Acme Autonomy' });
  client = await signIn(h, 'client', org.body.id);
});
afterAll(async () => {
  await app.end();
  await h.close();
});

const newIntent = (): Promise<Intent> =>
  apiIntent(lead, { key: `auto_${String(++counter)}`, name: `Autonomy ${String(counter)}` });

async function auditCount(action: string, actorId?: string): Promise<number> {
  const result = await owner().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND ($2::text IS NULL OR actor_id::text = $2)`,
    [action, actorId ?? null],
  );
  return result.rows[0]?.n ?? 0;
}

describe('GET /v1/autonomy', () => {
  it('shows the ceiling, both switches off, and every intent at stage 2 to staff', async () => {
    const intent = await newIntent();
    const response = await agent.client.get<AutonomyState>('/v1/autonomy');
    expect(response.status).toBe(200);
    expect(response.body.stageCeiling).toBe(2);
    expect(response.body.switches).toEqual([
      expect.objectContaining({ key: 'ai_stage_cap_pinned', on: false }),
      expect.objectContaining({ key: 'ai_kill_switch', on: false }),
    ]);
    expect(response.body.intents.find((row) => row.id === intent.id)).toMatchObject({
      stage: 2,
      effectiveStage: 2,
      pinned: false,
    });
  });

  it('is closed to a client and to anyone not signed in', async () => {
    expect((await client.client.get('/v1/autonomy')).status).toBe(403);
    expect((await h.client().get('/v1/autonomy')).status).toBe(401);
  });
});

describe('POST /v1/autonomy/switches', () => {
  const flip = (who: Persona, body: unknown) =>
    who.client.post<SetAiSwitchResult & ApiErrorBody>('/v1/autonomy/switches', body);

  it('is for the head only: an agent and a lead are refused, and nothing changes', async () => {
    for (const who of [agent, lead, client]) {
      const response = await flip(who, { switch: 'ai_kill_switch', on: true, reason: 'not mine' });
      expect(response.status, who.session.user.role).toBe(403);
    }
    const state = await head.client.get<AutonomyState>('/v1/autonomy');
    expect(state.body.switches.every((row) => !row.on)).toBe(true);
  });

  it('requires a reason, in both directions', async () => {
    for (const body of [
      { switch: 'ai_kill_switch', on: true },
      { switch: 'ai_kill_switch', on: true, reason: '' },
      { switch: 'ai_kill_switch', on: true, reason: '  ' },
      { switch: 'nope', on: true, reason: 'valid reason' },
      { switch: 'ai_kill_switch', reason: 'valid reason' },
    ]) {
      expect((await flip(head, body)).status).toBe(400);
    }
  });

  it('turns the kill switch on and off with a reason, and audits each flip once', async () => {
    const before = await auditCount('autonomy.switch_set', head.userId);
    const on = await flip(head, {
      switch: 'ai_kill_switch',
      on: true,
      reason: 'provider is returning nonsense',
    });
    expect(on.status).toBe(200);
    expect(on.body.changed).toBe(true);
    expect(on.body.switches.find((row) => row.key === 'ai_kill_switch')).toMatchObject({
      on: true,
      reason: 'provider is returning nonsense',
      changedBy: head.userId,
    });
    const shown = await agent.client.get<AutonomyState>('/v1/autonomy');
    expect(shown.body.switches.find((row) => row.key === 'ai_kill_switch')?.on).toBe(true);

    const again = await flip(head, { switch: 'ai_kill_switch', on: true, reason: 'still on' });
    expect(again.body.changed).toBe(false);

    const off = await flip(head, {
      switch: 'ai_kill_switch',
      on: false,
      reason: 'provider is back',
    });
    expect(off.body.changed).toBe(true);
    expect(off.body.switches.find((row) => row.key === 'ai_kill_switch')).toMatchObject({
      on: false,
      reason: 'provider is back',
    });

    // Two real flips = two audit rows written by the domain (the request audit does not write a
    // second one for them); the no-op writes one request-level row of its own.
    expect(await auditCount('autonomy.switch_set', head.userId)).toBe(before + 2 + 1);
  });

  it('records who, when and why in the audit row', async () => {
    await flip(head, { switch: 'ai_stage_cap_pinned', on: true, reason: 'incident review' });
    const rows = await owner().query<{
      actor_id: string;
      outcome: string;
      target_type: string;
      metadata: { switch: string; on: boolean; reason: string };
    }>(
      `SELECT actor_id, outcome, target_type, metadata FROM audit_log
        WHERE action = 'autonomy.switch_set' AND metadata->>'reason' = 'incident review'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      actor_id: head.userId,
      outcome: 'success',
      target_type: 'ai_switch',
      metadata: { switch: 'ai_stage_cap_pinned', on: true },
    });
    await flip(head, { switch: 'ai_stage_cap_pinned', on: false, reason: 'review over' });
  });
});

describe('POST /v1/intents/:id/autonomy', () => {
  const setStage = (who: Persona, intentId: string, body: unknown) =>
    who.client.post<IntentAutonomyChange & ApiErrorBody>(`/v1/intents/${intentId}/autonomy`, body);
  const stored = async (intentId: string) =>
    (
      await owner().query<{ autonomy_stage: number; autonomy_pinned: boolean }>(
        'SELECT autonomy_stage, autonomy_pinned FROM intent WHERE id = $1',
        [intentId],
      )
    ).rows[0];

  it('lets a lead move an intent between 0 and 2 and keeps who/when/why/from/to', async () => {
    const intent = await newIntent();
    const response = await setStage(lead, intent.id, { stage: 1, reason: 'drafts are weak' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      changed: true,
      intent: { id: intent.id, stage: 1, effectiveStage: 1, pinned: false },
    });
    expect(await stored(intent.id)).toMatchObject({ autonomy_stage: 1 });
    const history = await owner().query(
      'SELECT change, from_stage, to_stage, reason, changed_by FROM intent_autonomy_history WHERE intent_id = $1',
      [intent.id],
    );
    expect(history.rows).toEqual([
      {
        change: 'stage',
        from_stage: 2,
        to_stage: 1,
        reason: 'drafts are weak',
        changed_by: lead.userId,
      },
    ]);
    expect(
      (
        await owner().query(
          "SELECT 1 FROM audit_log WHERE action = 'autonomy.stage_set' AND target_id = $1",
          [intent.id],
        )
      ).rowCount,
    ).toBe(1);
    // The same request again changes nothing.
    expect((await setStage(lead, intent.id, { stage: 1, reason: 'again' })).body.changed).toBe(
      false,
    );
    await setStage(head, intent.id, { stage: 0, reason: 'observe only for now' });
    expect(await stored(intent.id)).toMatchObject({ autonomy_stage: 0 });
  });

  it('refuses stage 3 and above with a clear error that needs the owner, for lead and head alike', async () => {
    const intent = await newIntent();
    for (const who of [lead, head]) {
      for (const stage of [3, 4, 50]) {
        const response = await setStage(who, intent.id, { stage, reason: 'try to promote' });
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('autonomy_stage_requires_owner');
        expect(response.body.message).toMatch(/owner/i);
      }
    }
    expect((await setStage(head, intent.id, { stage: -1, reason: 'negative stage' })).status).toBe(
      400,
    );
    expect((await setStage(head, intent.id, { stage: 1.5, reason: 'fractional' })).status).toBe(
      400,
    );
    expect((await stored(intent.id))?.autonomy_stage).toBe(2);
    const history = await owner().query(
      'SELECT 1 FROM intent_autonomy_history WHERE intent_id = $1',
      [intent.id],
    );
    expect(history.rowCount).toBe(0);
  });

  it('refuses an agent and a client, a missing reason, an empty body and an unknown intent', async () => {
    const intent = await newIntent();
    expect((await setStage(agent, intent.id, { stage: 1, reason: 'agents cannot' })).status).toBe(
      403,
    );
    expect((await setStage(client, intent.id, { stage: 1, reason: 'clients cannot' })).status).toBe(
      403,
    );
    expect((await setStage(lead, intent.id, { stage: 1 })).status).toBe(400);
    expect((await setStage(lead, intent.id, { reason: 'nothing to change' })).status).toBe(400);
    expect(
      (
        await setStage(lead, '00000000-0000-4000-8000-000000000000', {
          stage: 1,
          reason: 'nobody home',
        })
      ).status,
    ).toBe(404);
    expect((await stored(intent.id))?.autonomy_stage).toBe(2);
  });

  it('lets only the head pin; a pinned stage cannot change until it is unpinned', async () => {
    const intent = await newIntent();
    const leadPin = await setStage(lead, intent.id, { pinned: true, reason: 'lead tries to pin' });
    expect(leadPin.status).toBe(403);

    const pinned = await setStage(head, intent.id, { pinned: true, reason: 'freeze during audit' });
    expect(pinned.body.intent.pinned).toBe(true);
    const blocked = await setStage(lead, intent.id, { stage: 1, reason: 'change anyway' });
    expect(blocked.status).toBe(409);
    expect((await stored(intent.id))?.autonomy_stage).toBe(2);

    const state = await agent.client.get<AutonomyState>('/v1/autonomy');
    expect(state.body.intents.find((row) => row.id === intent.id)?.pinned).toBe(true);

    await setStage(head, intent.id, { pinned: false, reason: 'audit finished' });
    expect((await setStage(lead, intent.id, { stage: 1, reason: 'now it can' })).body.changed).toBe(
      true,
    );
  });

  it('cannot raise a stage while the limit switch is on, can lower, and never raises 0/1 by itself', async () => {
    const low = await newIntent();
    await setStage(lead, low.id, { stage: 0, reason: 'start at observe' });
    const high = await newIntent();
    await head.client.post('/v1/autonomy/switches', {
      switch: 'ai_stage_cap_pinned',
      on: true,
      reason: 'limit during the incident',
    });
    try {
      expect((await setStage(lead, low.id, { stage: 1, reason: 'raise under cap' })).status).toBe(
        409,
      );
      expect((await setStage(lead, low.id, { stage: 2, reason: 'raise under cap' })).status).toBe(
        409,
      );
      expect((await stored(low.id))?.autonomy_stage).toBe(0);
      const lowered = await setStage(lead, high.id, { stage: 1, reason: 'lowering is fine' });
      expect(lowered.status).toBe(200);
      const state = await agent.client.get<AutonomyState>('/v1/autonomy');
      expect(state.body.intents.find((row) => row.id === low.id)).toMatchObject({
        stage: 0,
        effectiveStage: 0,
      });
    } finally {
      await head.client.post('/v1/autonomy/switches', {
        switch: 'ai_stage_cap_pinned',
        on: false,
        reason: 'incident is over',
      });
    }
  });

  it('does not let an intent edit change the stage or the pin', async () => {
    const intent = await newIntent();
    await head.client.patch(`/v1/intents/${intent.id}`, { name: 'Renamed', autonomyStage: 0 });
    expect(await stored(intent.id)).toEqual({ autonomy_stage: 2, autonomy_pinned: false });
  });
});

describe('the database underneath', () => {
  it('rejects stage 3 even if the code were wrong, and a direct write by the application role', async () => {
    const intent = await newIntent();
    await expect(
      owner().query('UPDATE intent SET autonomy_stage = 3 WHERE id = $1', [intent.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      app.query('UPDATE intent SET autonomy_stage = 0 WHERE id = $1', [intent.id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app.query('SELECT set_intent_autonomy($1::uuid, 3::smallint, NULL, $2::uuid, $3)', [
        intent.id,
        lead.userId,
        'forced',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps the history append-only for the application role', async () => {
    const intent = await newIntent();
    await lead.client.post(`/v1/intents/${intent.id}/autonomy`, {
      stage: 1,
      reason: 'for the log',
    });
    await expect(
      app.query('UPDATE intent_autonomy_history SET reason = $2 WHERE intent_id = $1', [
        intent.id,
        'edited',
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app.query('DELETE FROM intent_autonomy_history WHERE intent_id = $1', [intent.id]),
    ).rejects.toMatchObject({ code: '42501' });
    const rows = await app.query(
      'SELECT reason FROM intent_autonomy_history WHERE intent_id = $1',
      [intent.id],
    );
    expect(rows.rows).toEqual([{ reason: 'for the log' }]);
  });
});

describe('the policy gate in the api domain', () => {
  it('is the real gate: the AI cannot send to a customer, a person can, safe acks pass, kill switch stops AI work', async () => {
    const domain = h.app.get<Domain>(DOMAIN);
    const ai = domain.context({ actor: { type: 'ai', id: null } });
    const gate = ai.policyGate;
    expect(gate).toBeDefined();
    if (gate === undefined) return;
    const ticketId = '00000000-0000-4000-8000-0000000000bb';

    expect(
      await gate.check({ ticketId, channel: 'line', intentId: null, actor: ai.actor }),
    ).toEqual({
      allowed: false,
      reason: 'ai_auto_send_disabled_phase1',
    });
    expect(
      await gate.check({
        ticketId,
        channel: 'line',
        intentId: null,
        actor: { type: 'user', id: lead.userId },
      }),
    ).toMatchObject({ allowed: true, reason: 'human_staff' });
    expect(
      await gate.check({
        ticketId,
        channel: 'line',
        intentId: null,
        actor: { type: 'system', id: null },
        templateKey: 'auto_ack.received',
      }),
    ).toMatchObject({ allowed: true, reason: 'safe_template_auto_ack' });

    const classify = () =>
      gate.checkAiAction({ ticketId: null, intentId: null, actor: ai.actor, action: 'classify' });
    expect(await classify()).toMatchObject({ allowed: true });
    await head.client.post('/v1/autonomy/switches', {
      switch: 'ai_kill_switch',
      on: true,
      reason: 'gate test',
    });
    try {
      expect(await classify()).toEqual({ allowed: false, reason: 'kill_switch_on' });
      // Auto-ack from a safe template continues under the kill switch [ASSUMED, po 23].
      expect(
        await gate.check({
          ticketId,
          channel: 'line',
          intentId: null,
          actor: { type: 'system', id: null },
          templateKey: 'auto_ack.received',
        }),
      ).toMatchObject({ allowed: true });
    } finally {
      await head.client.post('/v1/autonomy/switches', {
        switch: 'ai_kill_switch',
        on: false,
        reason: 'gate test over',
      });
    }
    expect(await classify()).toMatchObject({ allowed: true });
  });
});
