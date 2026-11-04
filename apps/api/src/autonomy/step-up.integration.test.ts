import { randomUUID } from 'node:crypto';

import type { SessionInfo } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startFakeIdp, type FakeIdp, type IdentityClaims } from '../testing/fake-idp.js';
import { startHarness, uniqueEmail, type Harness, type TestClient } from '../testing/harness.js';

// T-306a C-5: approving a stage 3 promotion needs a step-up through Google (prompt=login, max_age=300, auth_time
// checked), stored on the session. A session that is only a few minutes old is no longer a re-authentication.
// The stack here runs Google in live mode against a local fake provider, with the auto-send flag on.
const DOMAIN = 'example.com';
let idp: FakeIdp;
let h: Harness;
let counter = 0;

beforeAll(async () => {
  idp = await startFakeIdp();
  h = await startHarness({
    env: {
      GOOGLE_OIDC_CLIENT_ID: idp.clientId,
      GOOGLE_OIDC_CLIENT_SECRET: idp.clientSecret,
      GOOGLE_ALLOWED_DOMAIN: DOMAIN,
      AI_AUTOSEND_ENABLED: 'true',
    },
    oidc: { issuer: idp.issuer },
  });
  await h.db.owner.pool.query(`UPDATE ai_switch SET is_on = false`);
});
afterAll(async () => {
  await h.close();
  await idp.stop();
});

const pool = () => h.db.owner.pool;
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

interface Person {
  readonly id: string;
  readonly email: string;
  readonly sub: string;
}

async function createPerson(permissions: string[] = []): Promise<Person> {
  const email = uniqueEmail('stepup').replace(/@.*$/, `@${DOMAIN}`);
  const row = await pool().query<{ id: string }>(
    `INSERT INTO users (email, name, role, status, permissions) VALUES ($1, 'Person', 'head', 'active', $2)
     RETURNING id`,
    [email, permissions],
  );
  return { id: row.rows[0]?.id ?? '', email, sub: `sub-${randomUUID()}` };
}

const claimsOf = (person: Person, authTime: number | null = nowSeconds()): IdentityClaims => ({
  sub: person.sub,
  email: person.email,
  email_verified: true,
  hd: DOMAIN,
  name: 'Person',
  ...(authTime === null ? {} : { auth_time: authTime }),
});

/** The ordinary Google sign-in: a session whose only proof is that sign-in. */
async function signInWithGoogle(
  person: Person,
): Promise<{ client: TestClient; sessionId: string }> {
  const client = h.client();
  const start = await client.get('/v1/auth/google/start');
  const request = idp.parseAuthorize(start.headers.get('location') ?? '');
  const code = idp.approve(request, claimsOf(person));
  const callback = await client.get(
    `/v1/auth/google/callback?code=${code}&state=${encodeURIComponent(request.state)}`,
  );
  expect(callback.status).toBe(302);
  const session = await client.get<SessionInfo>('/v1/auth/session');
  client.csrfToken = session.body.csrfToken;
  return { client, sessionId: session.body.sessionId };
}

/** The step-up: /step-up, the provider, /callback. Returns where the browser lands. */
async function stepUp(
  client: TestClient,
  claims: IdentityClaims,
  returnTo = '/admin/autonomy',
): Promise<{ landed: URL; authorize: ReturnType<FakeIdp['parseAuthorize']> }> {
  const start = await client.get(
    `/v1/auth/google/step-up?returnTo=${encodeURIComponent(returnTo)}`,
  );
  expect(start.status).toBe(302);
  const authorize = idp.parseAuthorize(start.headers.get('location') ?? '');
  const code = idp.approve(authorize, claims);
  const callback = await client.get(
    `/v1/auth/google/callback?code=${code}&state=${encodeURIComponent(authorize.state)}`,
  );
  expect(callback.status).toBe(302);
  return { landed: new URL(callback.headers.get('location') ?? ''), authorize };
}

async function newPromotion(
  requester: Person,
  key: string,
): Promise<{ intentId: string; promotionId: string }> {
  const intent = await pool().query<{ id: string }>(
    `INSERT INTO intent (key, name, created_at) VALUES ($1, 'Probe', now() - interval '90 days') RETURNING id`,
    [key],
  );
  const intentId = intent.rows[0]?.id ?? '';
  const report = await pool().query<{ id: string }>(
    `INSERT INTO autonomy_gate_report (intent_id, status, trigger_kind, window_start, window_end, metrics, criteria)
     VALUES ($1, 'green', 'on_demand', now() - interval '30 days', now(), '{"resolved":40}'::jsonb,
             '[{"key":"precision","pass":true,"value":1,"threshold":0.95}]'::jsonb) RETURNING id`,
    [intentId],
  );
  const { client } = await signInWithGoogle(requester);
  const asked = await client.post<{ id: string }>(`/v1/intents/${intentId}/autonomy/promotions`, {
    gateReportId: report.rows[0]?.id,
    reason: 'ready for stage 3',
  });
  expect(asked.status).toBe(200);
  return { intentId, promotionId: asked.body.id };
}

const decide = (client: TestClient, promotionId: string, key: string) =>
  client.post<{ status?: string; code?: string }>(`/v1/autonomy/promotions/${promotionId}/decide`, {
    approve: true,
    reason: 'looks right',
    confirmKey: key,
  });

describe('owner approval needs a step-up through Google (C-5)', () => {
  it('refuses a session that is only new, asks Google with prompt=login and max_age, stores the step-up on the session and approves', async () => {
    const requester = await createPerson(['ai.autonomy.promote']);
    const owner = await createPerson(['ai.autonomy.owner_approve']);
    const key = `stepup_${String((counter += 1))}`;
    const { promotionId } = await newPromotion(requester, key);

    const { client, sessionId } = await signInWithGoogle(owner);
    // A sign-in of a second ago is not a re-authentication any more.
    const before = await decide(client, promotionId, key);
    expect(before.status).toBe(403);
    expect(before.body.code).toBe('reauth_required');

    const { landed, authorize } = await stepUp(client, claimsOf(owner));
    expect(authorize.params.get('prompt')).toBe('login');
    expect(authorize.params.get('max_age')).toBe('300');
    expect(authorize.params.get('login_hint')).toBe(owner.email);
    expect(landed.pathname).toBe('/admin/autonomy');
    expect(landed.searchParams.get('stepup')).toBe('ok');

    // The proof is on THIS session (no new session), with its method.
    const row = await pool().query<{ step_up_at: Date; step_up_method: string }>(
      `SELECT step_up_at, step_up_method FROM sessions WHERE id = $1`,
      [sessionId],
    );
    expect(row.rows[0]?.step_up_method).toBe('google_oidc');
    expect(Math.abs((row.rows[0]?.step_up_at.getTime() ?? 0) / 1000 - nowSeconds())).toBeLessThan(
      10,
    );
    expect((await client.get<SessionInfo>('/v1/auth/session')).body.sessionId).toBe(sessionId);

    const approved = await decide(client, promotionId, key);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');

    // The audit trail says how the owner proved it.
    const audit = await pool().query<{ metadata: { reauthMethod?: string } }>(
      `SELECT metadata FROM audit_log WHERE action = 'autonomy.promotion_decided' AND actor_id = $1`,
      [owner.id],
    );
    expect(audit.rows.some((entry) => entry.metadata.reauthMethod === 'google_oidc')).toBe(true);
    const stepAudit = await pool().query<{ outcome: string; metadata: { authMethod?: string } }>(
      `SELECT outcome, metadata FROM audit_log WHERE action = 'auth.step_up.google' AND actor_id = $1`,
      [owner.id],
    );
    expect(stepAudit.rows).toHaveLength(1);
    expect(stepAudit.rows[0]).toMatchObject({
      outcome: 'success',
      metadata: { authMethod: 'google_oidc' },
    });
  });

  it('does not count a step-up that is older than five minutes, from another account, or without auth_time', async () => {
    const requester = await createPerson(['ai.autonomy.promote']);
    const owner = await createPerson(['ai.autonomy.owner_approve']);
    const stranger = await createPerson();
    const key = `stepup_${String((counter += 1))}`;
    const { promotionId } = await newPromotion(requester, key);
    const { client, sessionId } = await signInWithGoogle(owner);
    const stored = async () =>
      (
        await pool().query<{ step_up_at: Date | null }>(
          `SELECT step_up_at FROM sessions WHERE id = $1`,
          [sessionId],
        )
      ).rows[0]?.step_up_at;

    // Google says the person last typed their password 20 minutes ago (the provider ignored max_age).
    const stale = await stepUp(client, claimsOf(owner, nowSeconds() - 20 * 60));
    expect(stale.landed.pathname).toBe('/login');
    expect(await stored()).toBeNull();
    // No auth_time at all.
    const missing = await stepUp(client, claimsOf(owner, null));
    expect(missing.landed.pathname).toBe('/login');
    expect(await stored()).toBeNull();
    // Somebody else's Google account answered the prompt.
    const other = await stepUp(client, claimsOf(stranger));
    expect(other.landed.searchParams.get('stepup')).toBe('failed');
    expect(await stored()).toBeNull();
    expect((await decide(client, promotionId, key)).body.code).toBe('reauth_required');
    const failed = await pool().query(
      `SELECT 1 FROM audit_log WHERE action = 'auth.step_up.failed'`,
    );
    expect(failed.rowCount ?? 0).toBeGreaterThanOrEqual(1);

    // A good step-up that has since aged past five minutes is no proof either.
    await stepUp(client, claimsOf(owner));
    expect(await stored()).not.toBeNull();
    await pool().query(
      `UPDATE sessions SET step_up_at = now() - interval '10 minutes' WHERE id = $1`,
      [sessionId],
    );
    expect((await decide(client, promotionId, key)).body.code).toBe('reauth_required');
  });

  it('needs a signed-in session to start a step-up, and 404 means no Google here', async () => {
    const anonymous = await h.client().get('/v1/auth/google/step-up');
    expect(anonymous.status).toBe(401);
  });
});
