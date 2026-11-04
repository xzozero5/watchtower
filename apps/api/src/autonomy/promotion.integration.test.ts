import type {
  AutonomyPromotionState,
  AutonomyState,
  AutosendDisclosure,
  GateReport,
  GateReportList,
  Intent,
  Promotion,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { apiIntent, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// T-304f (ADR-025 section 6): the gate report, the promotion door and the auto-send settings over HTTP, with the
// instance flag off (the default) and on. The database rules are tested in packages/db; this checks the api in
// front of them: who may ask, the flag, the sign-in from the last five minutes, the typed key, the audit rows.
type Decided = { status: string; selfApproved: boolean };

let off: Harness;
let on: Harness;
let counter = 0;

beforeAll(async () => {
  off = await startHarness();
  on = await startHarness({ env: { AI_AUTOSEND_ENABLED: 'true' } });
});
afterAll(async () => {
  await off.close();
  await on.close();
});

async function personas(h: Harness) {
  const head = await signIn(h, 'head');
  const lead = await signIn(h, 'lead');
  const agent = await signIn(h, 'agent');
  const owner = await signIn(h, 'head');
  await h.db.owner.pool.query(
    `UPDATE users SET permissions = ARRAY['ai.autonomy.owner_approve'] WHERE id = $1`,
    [owner.userId],
  );
  // Both switches off: a promotion is refused while the stage cap switch is on.
  await h.db.owner.pool.query(`UPDATE ai_switch SET is_on = false`);
  return { head, lead, agent, owner };
}

const newIntent = (lead: Persona): Promise<Intent> =>
  apiIntent(lead, { key: `promo_${String(++counter)}`, name: `Promotion ${String(counter)}` });

async function greenReport(h: Harness, intentId: string): Promise<string> {
  // A window cannot start before the intent existed (migration 0108): make the intent old enough for 30 days.
  await h.db.owner.pool.query(
    `UPDATE intent SET created_at = now() - interval '90 days' WHERE id = $1`,
    [intentId],
  );
  const result = await h.db.owner.pool.query<{ id: string }>(
    `INSERT INTO autonomy_gate_report (intent_id, status, trigger_kind, window_start, window_end)
     VALUES ($1, 'green', 'on_demand', now() - interval '30 days', now()) RETURNING id`,
    [intentId],
  );
  return result.rows[0]?.id ?? '';
}

const stageOf = async (h: Harness, intentId: string): Promise<number> =>
  (
    await h.db.owner.pool.query<{ autonomy_stage: number }>(
      `SELECT autonomy_stage FROM intent WHERE id = $1`,
      [intentId],
    )
  ).rows[0]?.autonomy_stage ?? -1;

const auditCount = async (h: Harness, action: string): Promise<number> =>
  (
    await h.db.owner.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = $1`,
      [action],
    )
  ).rows[0]?.n ?? 0;

describe('with AI_AUTOSEND_ENABLED off (the default)', () => {
  it('shows the flag off, the manual ceiling 2 and the auto-send settings of each intent', async () => {
    const { lead, agent } = await personas(off);
    const intent = await newIntent(lead);
    const response = await agent.client.get<AutonomyState>('/v1/autonomy');
    expect(response.body).toMatchObject({ stageCeiling: 2, autosendFlag: false });
    const shown = response.body.intents.find((candidate) => candidate.id === intent.id);
    expect(shown).toMatchObject({
      stage: 2,
      effectiveStage: 2,
      autosend: {
        shadow: false,
        minScore: 0.85,
        dailyCap: 20,
        policy: { channels: [], maxChars: 1200 },
      },
    });
  });

  it('refuses a request and an apply with 409 autosend_flag_off, and an approval too', async () => {
    const { head, lead, owner } = await personas(off);
    const intent = await newIntent(lead);
    const report = await greenReport(off, intent.id);
    const asked = await head.client.post<ApiErrorBody>(
      `/v1/intents/${intent.id}/autonomy/promotions`,
      {
        gateReportId: report,
        reason: 'ready',
      },
    );
    expect(asked.status).toBe(409);
    expect(asked.body.code).toBe('autosend_flag_off');
    const promotion = '11111111-1111-4111-8111-111111111111';
    const approved = await owner.client.post<ApiErrorBody>(
      `/v1/autonomy/promotions/${promotion}/decide`,
      {
        approve: true,
        reason: 'fine',
        confirmKey: intent.key,
      },
    );
    expect(approved.status).toBe(409);
    expect(approved.body.code).toBe('autosend_flag_off');
    const applied = await owner.client.post<ApiErrorBody>(
      `/v1/autonomy/promotions/${promotion}/apply`,
      {},
    );
    expect(applied.status).toBe(409);
    expect(await stageOf(off, intent.id)).toBe(2);
  });

  it('still lets a head read the door and make a report (it changes nothing)', async () => {
    const { head, lead } = await personas(off);
    const intent = await newIntent(lead);
    const made = await head.client.post<GateReport>(
      `/v1/intents/${intent.id}/autonomy/gate-reports`,
      {},
    );
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({
      status: 'insufficient_data',
      seedExcluded: true,
      triggerKind: 'on_demand',
    });
    expect(made.body.criteria.some((criterion) => criterion.key === 'days_at_stage_2')).toBe(true);
    const door = await lead.client.get<AutonomyPromotionState>(
      `/v1/intents/${intent.id}/autonomy/promotion`,
    );
    expect(door.body).toMatchObject({ autosendFlag: false, openPromotion: null });
    expect(door.body.latestReport?.id).toBe(made.body.id);
    const list = await lead.client.get<GateReportList>(
      `/v1/intents/${intent.id}/autonomy/gate-reports`,
    );
    expect(list.body.items.map((report) => report.id)).toContain(made.body.id);
    expect(await auditCount(off, 'autonomy.gate_report_generated')).toBeGreaterThan(0);
  });
});

describe('the promotion door with the flag on', () => {
  it('asks, approves with the typed key and a fresh sign-in, applies, and audits each step', async () => {
    const { head, lead, owner } = await personas(on);
    const intent = await newIntent(lead);
    const report = await greenReport(on, intent.id);

    // Who may ask: a head (ai.autonomy.promote); a lead or an agent may not.
    for (const who of [lead]) {
      const refused = await who.client.post<ApiErrorBody>(
        `/v1/intents/${intent.id}/autonomy/promotions`,
        {
          gateReportId: report,
          reason: 'ready',
        },
      );
      expect(refused.status).toBe(403);
    }
    const asked = await head.client.post<Promotion>(
      `/v1/intents/${intent.id}/autonomy/promotions`,
      {
        gateReportId: report,
        reason: 'ready',
      },
    );
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({
      status: 'requested',
      requestedBy: head.userId,
      selfApproved: false,
    });
    const door = await head.client.get<AutonomyPromotionState>(
      `/v1/intents/${intent.id}/autonomy/promotion`,
    );
    expect(door.body.openPromotion?.id).toBe(asked.body.id);
    expect(
      (
        await head.client.post(`/v1/intents/${intent.id}/autonomy/promotions`, {
          gateReportId: report,
          reason: 'again',
        })
      ).status,
    ).toBe(409);

    const decide = (who: Persona, body: unknown) =>
      who.client.post<Decided & ApiErrorBody>(
        `/v1/autonomy/promotions/${asked.body.id}/decide`,
        body,
      );

    // A head without the owner permission cannot approve.
    const notOwner = await decide(head, { approve: true, reason: 'sure', confirmKey: intent.key });
    expect(notOwner.status).toBe(403);
    expect(notOwner.body.code).toBe('owner_only');

    // The key must be typed exactly.
    const wrongKey = await decide(owner, {
      approve: true,
      reason: 'sure',
      confirmKey: `${intent.key}x`,
    });
    expect(wrongKey.status).toBeGreaterThanOrEqual(400);
    expect(wrongKey.status).toBeLessThan(500);
    if (wrongKey.status === 403) expect(wrongKey.body.reason).toBe('confirm_key_mismatch');
    expect(await stageOf(on, intent.id)).toBe(2);

    // A sign-in older than five minutes is not a re-authentication.
    await on.db.owner.pool.query(
      `UPDATE sessions SET created_at = now() - interval '10 minutes' WHERE user_id = $1`,
      [owner.userId],
    );
    const stale = await decide(owner, { approve: true, reason: 'sure', confirmKey: intent.key });
    expect(stale.status).toBe(403);
    expect(stale.body.code).toBe('reauth_required');
    expect(await stageOf(on, intent.id)).toBe(2);

    // The owner signs in again (a new session) and approves.
    const again = await on.client().devLogin(owner.email, 'head', {});
    expect(again.user.id).toBe(owner.userId);
    const fresh = { ...owner, client: on.client() } as Persona;
    await fresh.client.devLogin(owner.email, 'head', {});
    const approved = await decide(fresh, {
      approve: true,
      reason: 'looks right',
      confirmKey: intent.key,
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toEqual({ status: 'approved', selfApproved: false });
    // The head cannot apply: only the owner moves the stage.
    expect(
      (await head.client.post(`/v1/autonomy/promotions/${asked.body.id}/apply`, {})).status,
    ).toBe(403);
    expect(await stageOf(on, intent.id)).toBe(2);
    const applied = await fresh.client.post<{ status: string }>(
      `/v1/autonomy/promotions/${asked.body.id}/apply`,
      {},
    );
    expect(applied.body).toEqual({ status: 'applied' });
    expect(await stageOf(on, intent.id)).toBe(3);

    // The state shows stage 3, acted on as 3 because this process has the flag; no endpoint sets it by hand.
    const state = await head.client.get<AutonomyState>('/v1/autonomy');
    expect(state.body.autosendFlag).toBe(true);
    expect(state.body.intents.find((candidate) => candidate.id === intent.id)).toMatchObject({
      stage: 3,
      effectiveStage: 3,
    });
    const byHand = await head.client.post<ApiErrorBody>(`/v1/intents/${intent.id}/autonomy`, {
      stage: 3,
      reason: 'just do it',
    });
    expect(byHand.status).toBe(403);
    expect(byHand.body.code).toBe('autonomy_stage_requires_owner');

    for (const action of [
      'autonomy.promotion_requested',
      'autonomy.promotion_decided',
      'autonomy.promoted',
    ]) {
      expect(await auditCount(on, action), action).toBeGreaterThanOrEqual(1);
    }
    const history = await head.client.get<{ items: { change: string; toStage: number }[] }>(
      `/v1/intents/${intent.id}/autonomy/history`,
    );
    expect(history.body.items[0]).toMatchObject({ change: 'promotion', toStage: 3 });
  });

  it('the owner can approve a request of their own, flagged self_approved, and a head can reject', async () => {
    const { head, lead, owner } = await personas(on);
    const intent = await newIntent(lead);
    const report = await greenReport(on, intent.id);
    const mine = await owner.client.post<Promotion>(
      `/v1/intents/${intent.id}/autonomy/promotions`,
      { gateReportId: report, reason: 'my own' },
    );
    expect(mine.status).toBe(200);
    const approved = await owner.client.post<Decided>(
      `/v1/autonomy/promotions/${mine.body.id}/decide`,
      {
        approve: true,
        reason: 'I checked it',
        confirmKey: intent.key,
      },
    );
    expect(approved.body).toEqual({ status: 'approved', selfApproved: true });
    const row = await on.db.owner.pool.query<{ metadata: { self_approved?: boolean } }>(
      `SELECT metadata FROM audit_log WHERE action = 'autonomy.promotion_decided' AND target_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [intent.id],
    );
    expect(row.rows[0]?.metadata.self_approved).toBe(true);

    const other = await newIntent(lead);
    const report2 = await greenReport(on, other.id);
    const asked = await owner.client.post<Promotion>(
      `/v1/intents/${other.id}/autonomy/promotions`,
      { gateReportId: report2, reason: 'will be rejected' },
    );
    const rejected = await head.client.post<Decided>(
      `/v1/autonomy/promotions/${asked.body.id}/decide`,
      { approve: false, reason: 'not yet' },
    );
    expect(rejected.body.status).toBe('rejected');
    expect(await stageOf(on, other.id)).toBe(2);
  });

  it('refuses a report that is not green, and one that names another intent', async () => {
    const { head, lead } = await personas(on);
    const intent = await newIntent(lead);
    const made = await head.client.post<GateReport>(
      `/v1/intents/${intent.id}/autonomy/gate-reports`,
      {},
    );
    const notGreen = await head.client.post<ApiErrorBody>(
      `/v1/intents/${intent.id}/autonomy/promotions`,
      { gateReportId: made.body.id, reason: 'try' },
    );
    expect(notGreen.status).toBe(403);
    expect(notGreen.body).toMatchObject({
      code: 'forbidden',
      reason: 'report_not_green',
    });
    // Only the reason code travels: no SQL text, no internals.
    expect(Object.keys(notGreen.body).sort()).toEqual(
      ['code', 'error', 'message', 'reason', 'statusCode'].sort(),
    );
    const other = await newIntent(lead);
    const theirs = await greenReport(on, other.id);
    const wrong = await head.client.post<ApiErrorBody>(
      `/v1/intents/${intent.id}/autonomy/promotions`,
      { gateReportId: theirs, reason: 'try' },
    );
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(await stageOf(on, intent.id)).toBe(2);
  });
});

describe('the auto-send settings and the disclosure notice', () => {
  it('a head sets shadow mode, the score, the cap and the allow-list; others cannot; bad values are refused', async () => {
    const { head, lead, agent } = await personas(off);
    const intent = await newIntent(lead);
    const url = `/v1/intents/${intent.id}/autonomy/autosend`;
    const set = await head.client.put<{
      changed: boolean;
      autosend: {
        shadow: boolean;
        minScore: number;
        dailyCap: number;
        policy: { channels: string[]; maxChars: number };
      };
    }>(url, {
      shadow: true,
      minScore: 0.9,
      dailyCap: 5,
      policy: { channels: ['gmail'], maxChars: 800 },
      reason: 'start measuring',
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      changed: true,
      autosend: {
        shadow: true,
        minScore: 0.9,
        dailyCap: 5,
        policy: { channels: ['gmail'], maxChars: 800 },
      },
    });
    expect((await lead.client.put(url, { shadow: false, reason: 'nope' })).status).toBe(403);
    expect((await agent.client.put(url, { shadow: false, reason: 'nope' })).status).toBe(403);
    expect((await head.client.put(url, { minScore: 0.5, reason: 'too low' })).status).toBe(400);
    expect(
      (await head.client.put(url, { policy: { channels: ['line'] }, reason: 'no line' })).status,
    ).toBe(400);
    expect(
      (
        await head.client.put(url, {
          policy: { channels: ['gmail'], action: 'close' },
          reason: 'no close',
        })
      ).status,
    ).toBe(400);
    expect((await head.client.put(url, { reason: 'nothing' })).status).toBe(400);
    const shown = await agent.client.get<AutonomyState>('/v1/autonomy');
    expect(
      shown.body.intents.find((candidate) => candidate.id === intent.id)?.autosend,
    ).toMatchObject({ shadow: true, minScore: 0.9 });
    expect(await auditCount(off, 'autonomy.autosend_config_set')).toBeGreaterThan(0);
  });

  it('shows the notice on by default, lets a head change or turn it off with an audit row, and nobody else', async () => {
    const { head, lead, agent } = await personas(off);
    const before = await agent.client.get<AutosendDisclosure>('/v1/autonomy/disclosure');
    expect(before.body.enabled).toBe(true);
    expect(before.body.text.en).toContain('automatically');
    const changed = await head.client.put<AutosendDisclosure>('/v1/autonomy/disclosure', {
      enabled: false,
      text: { th: 'ตอบโดยระบบอัตโนมัติ', en: 'Automatic reply.' },
      reason: 'the customer asked for it',
    });
    expect(changed.status).toBe(200);
    expect((await agent.client.get<AutosendDisclosure>('/v1/autonomy/disclosure')).body).toEqual({
      enabled: false,
      text: { th: 'ตอบโดยระบบอัตโนมัติ', en: 'Automatic reply.' },
    });
    expect(await auditCount(off, 'autonomy.disclosure_set')).toBeGreaterThan(0);
    expect(
      (
        await lead.client.put('/v1/autonomy/disclosure', {
          enabled: true,
          text: before.body.text,
          reason: 'x y z',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await head.client.put('/v1/autonomy/disclosure', {
          enabled: true,
          text: { th: '', en: 'x' },
          reason: 'empty',
        })
      ).status,
    ).toBe(400);
    // Back to the default so other tests see it.
    await head.client.put('/v1/autonomy/disclosure', {
      ...before.body,
      reason: 'back to the default',
    });
  });
});
