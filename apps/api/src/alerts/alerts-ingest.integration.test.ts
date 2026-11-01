import { randomBytes } from 'node:crypto';

import { alerts } from '@watchtower/connectors';
import { schema } from '@watchtower/db';
import { ALERT_WEBHOOK_SIGNATURE_HEADER, type AlertIngestResult } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { asc, eq } from 'drizzle-orm';
import {
  SignJWT,
  createLocalJWKSet,
  errors as joseErrors,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOidcPushVerifier, type PushTokenVerifier } from '../gmail/push-verifier.js';
import { startHarness, type Harness } from '../testing/harness.js';
import { captureLogs } from '../testing/support.js';
import { ALERT_PUSH_VERIFIER } from './alerts-ingest.service.js';

// T-201c on the real application module, Postgres and Redis from docker compose. The Pub/Sub OIDC
// token is signed by a key pair made here and checked through a local key set; the webhook secret is
// generated per run. disableNetConnect allows loopback only and the last test shows nothing tried.
const AUDIENCE = 'https://watchtower.example.com/v1/inbound/alerts/gcp';
const SERVICE_ACCOUNT = 'alerts-push@project-id.iam.gserviceaccount.example.com';
const GCP = '/v1/inbound/alerts/gcp';
const WEBHOOK = '/v1/inbound/alerts/webhook';
const WEBHOOK_SECRET = randomBytes(24).toString('hex');

const net = disableNetConnect();
const logs = captureLogs();
let h: Harness;
let privateKey: CryptoKey;
let pushVerifier: PushTokenVerifier;
let counter = 0;
let ipCounter = 0;
const freshIp = (): string => `203.0.113.${String(++ipCounter % 250)}`;
const owner = () => h.db.owner.db;

async function token(claims: Record<string, unknown> = {}, audience = AUDIENCE): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: SERVICE_ACCOUNT, email_verified: true, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuer('https://accounts.google.com')
    .setAudience(audience)
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 3000)
    .sign(privateKey);
}

/** A Cloud Monitoring v1.2 notification, inline and synthetic. */
function incident(overrides: Record<string, unknown> = {}, instance = 'vm-1') {
  return {
    version: '1.2',
    incident: {
      incident_id: `0.incident-${instance}`,
      scoping_project_id: 'example-project',
      url: 'https://console.example.invalid/alert',
      started_at: 1_793_584_800,
      ended_at: null,
      state: 'open',
      summary: 'CPU is above the threshold',
      resource: {
        type: 'gce_instance',
        labels: { instance_id: instance, zone: 'asia-southeast1-a' },
      },
      policy_name: 'High CPU on API VMs',
      policy_user_labels: { team: 'platform', customer: 'Example Customer Ltd' },
      condition_name: 'CPU above 90%',
      severity: 'CRITICAL',
      ...overrides,
    },
  };
}

function envelope(data: unknown, messageId?: string) {
  counter += 1;
  return {
    message: {
      data: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)).toString('base64'),
      messageId: messageId ?? String(5_000_000 + counter),
      publishTime: '2026-11-02T03:00:00Z',
    },
    subscription: 'projects/project-id/subscriptions/watchtower-alerts',
  };
}

async function pushGcp(body: unknown, headers: Record<string, string>) {
  const response = await h.client().post<AlertIngestResult>(GCP, body, {
    headers,
    origin: null,
    csrf: false,
  });
  return response;
}

const bearer = async (claims?: Record<string, unknown>, audience?: string) => ({
  authorization: `Bearer ${await token(claims, audience)}`,
});

async function sendWebhook(
  raw: string,
  header: string | undefined,
  where: { base?: string; ip?: string } = {},
) {
  const response = await fetch(`${where.base ?? h.base}${WEBHOOK}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': where.ip ?? freshIp(),
      ...(header === undefined ? {} : { [ALERT_WEBHOOK_SIGNATURE_HEADER]: header }),
    },
    body: raw,
  });
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}

const signed = (raw: string, offsetSeconds = 0) =>
  alerts.signAlertWebhook({
    rawBody: raw,
    secret: WEBHOOK_SECRET,
    timestampSeconds: Math.floor(Date.now() / 1000) + offsetSeconds,
  });

const allAlerts = () => owner().select().from(schema.alert);
const eventsOf = (alertId: string) =>
  owner()
    .select()
    .from(schema.alertEvent)
    .where(eq(schema.alertEvent.alertId, alertId))
    .orderBy(asc(schema.alertEvent.createdAt));

async function reset() {
  await h.db.owner.pool.query('DELETE FROM alert');
}

function amBody(alertname: string, instance: string, status: 'firing' | 'resolved' = 'firing') {
  return JSON.stringify({
    version: '4',
    groupKey: '{}:{}',
    status,
    receiver: 'watchtower',
    externalURL: 'https://alertmanager.example.invalid',
    alerts: [
      {
        status,
        labels: {
          alertname,
          severity: 'critical',
          service: 'checkout',
          instance,
          customer: 'Acme',
        },
        annotations: { summary: 'Error rate above 5%' },
        startsAt: '2026-11-02T03:00:00.000Z',
        endsAt: status === 'resolved' ? '2026-11-02T03:12:00.000Z' : '0001-01-01T00:00:00Z',
        generatorURL: 'https://prometheus.example.invalid/graph',
        fingerprint: 'abcdef0123456789',
      },
    ],
  });
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key-1', alg: 'RS256' };
  pushVerifier = createOidcPushVerifier({
    audience: AUDIENCE,
    serviceAccountEmail: SERVICE_ACCOUNT,
    keys: createLocalJWKSet({ keys: [jwk] }),
  });
  h = await startHarness({
    logs,
    env: { LOG_LEVEL: 'info', ALERT_WEBHOOK_SECRET: WEBHOOK_SECRET },
    overrides: [{ token: ALERT_PUSH_VERIFIER, value: pushVerifier }],
  });
});

afterAll(async () => {
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

describe('POST /v1/inbound/alerts/gcp (AC-3, first half)', () => {
  it('opens an alert from a Cloud Monitoring notification', async () => {
    await reset();
    const response = await pushGcp(envelope(incident(), '7001'), await bearer());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accepted: 1, duplicates: 0, ignored: 0 });
    const [row] = await allAlerts();
    expect(row).toMatchObject({
      source: 'gcp_monitoring',
      state: 'open',
      severity: 'critical',
      title: 'High CPU on API VMs',
      count: 1,
    });
    expect(row?.payload).toMatchObject({
      policyName: 'High CPU on API VMs',
      kind: 'gcp_monitoring',
    });
    // N4: the policy label that names a customer is not kept anywhere.
    expect(JSON.stringify(row)).not.toContain('Example Customer');
  });

  it('a redelivery of the same Pub/Sub message does not add to the count', async () => {
    await reset();
    const body = envelope(incident(), '7002');
    const first = await pushGcp(body, await bearer());
    const again = await pushGcp(body, await bearer());
    const third = await pushGcp(body, await bearer());
    expect(first.body).toEqual({ accepted: 1, duplicates: 0, ignored: 0 });
    expect(again.body).toEqual({ accepted: 0, duplicates: 1, ignored: 0 });
    expect(third.body).toEqual({ accepted: 0, duplicates: 1, ignored: 0 });
    const rows = await allAlerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(1);
  });

  it('two real fires of the same alert are one alert with count 2', async () => {
    await reset();
    await pushGcp(envelope(incident(), '7003'), await bearer());
    const second = await pushGcp(
      envelope(incident({ started_at: 1_793_585_040 }), '7004'),
      await bearer(),
    );
    expect(second.body).toEqual({ accepted: 1, duplicates: 0, ignored: 0 });
    const rows = await allAlerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(2);
    expect((await eventsOf(rows[0]?.id ?? '')).map((event) => event.type)).toEqual([
      'fired',
      'fired',
    ]);
  });

  it('closed resolves the alert and touches nothing else', async () => {
    await reset();
    await pushGcp(envelope(incident(), '7005'), await bearer());
    const [open] = await allAlerts();
    const incidentId = '0f6b7f58-8d56-4a39-b6d2-6a3d0a2d1e11';
    await owner()
      .update(schema.alert)
      .set({ incidentId })
      .where(eq(schema.alert.id, open?.id ?? ''));
    const closed = await pushGcp(
      envelope(incident({ state: 'closed', ended_at: 1_793_585_400 }), '7006'),
      await bearer(),
    );
    expect(closed.body).toEqual({ accepted: 1, duplicates: 0, ignored: 0 });
    const [row] = await allAlerts();
    expect(row).toMatchObject({ state: 'resolved', incidentId, count: 1 });
    expect(row?.resolvedAt).not.toBeNull();
    // A close with nothing open is acknowledged and dropped.
    const orphan = await pushGcp(
      envelope(incident({ state: 'closed' }, 'vm-never-seen'), '7007'),
      await bearer(),
    );
    expect(orphan.body).toEqual({ accepted: 0, duplicates: 0, ignored: 1 });
  });

  it('reads a log-based alert as its own source', async () => {
    await reset();
    const log = incident({
      incident_id: '0.log-1',
      condition: { conditionMatchedLog: { filter: 'severity>=ERROR' } },
      policy_name: 'Unhandled exception',
    });
    await pushGcp(envelope(log, '7008'), await bearer());
    const [row] = await allAlerts();
    expect(row?.source).toBe('gcp_logging');
  });

  it('refuses a missing, wrong-audience, wrong-account, expired or foreign token with 401 and writes nothing', async () => {
    await reset();
    const other = await generateKeyPair('RS256');
    const foreign = await new SignJWT({ email: SERVICE_ACCOUNT, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 30)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3000)
      .sign(other.privateKey);
    const expired = await new SignJWT({ email: SERVICE_ACCOUNT, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);
    const attempts: Record<string, string>[] = [
      {},
      { authorization: 'Bearer short' },
      await bearer({}, 'https://other.example.com/'),
      await bearer({ email: 'someone-else@project-id.iam.gserviceaccount.example.com' }),
      await bearer({ email_verified: false }),
      { authorization: `Bearer ${expired}` },
      { authorization: `Bearer ${foreign}` },
    ];
    for (const headers of attempts) {
      const response = await pushGcp(envelope(incident(), '7100'), headers);
      expect(response.status, JSON.stringify(Object.keys(headers))).toBe(401);
    }
    expect(await allAlerts()).toHaveLength(0);
  });

  it('acknowledges an authentic message it cannot use, and writes nothing', async () => {
    await reset();
    for (const body of [
      envelope('{nope'),
      envelope({ version: '2.0', incident: {} }),
      envelope({ version: '1.2', incident: { incident_id: 'x', state: 'open' } }),
      { not: 'an envelope' },
    ]) {
      const response = await pushGcp(body, await bearer());
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ accepted: 0, duplicates: 0, ignored: 1 });
    }
    expect(await allAlerts()).toHaveLength(0);
  });
});

describe('POST /v1/inbound/alerts/webhook (R-3.3)', () => {
  it('applies every alert of a signed Alertmanager payload once', async () => {
    await reset();
    const raw = amBody('HighErrorRate', 'checkout-1');
    const first = await sendWebhook(raw, signed(raw));
    expect(first).toEqual({ status: 200, body: { accepted: 1, duplicates: 0, ignored: 0 } });
    // Alertmanager repeats the notification: same alert, same startsAt.
    const repeat = await sendWebhook(raw, signed(raw));
    expect(repeat.body).toEqual({ accepted: 0, duplicates: 1, ignored: 0 });
    const rows = await allAlerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'alertmanager', title: 'HighErrorRate', count: 1 });
    expect(JSON.stringify(rows[0])).not.toContain('Acme');
  });

  it('resolved closes the open alert', async () => {
    await reset();
    const firing = amBody('Disk', 'db-1');
    await sendWebhook(firing, signed(firing));
    const resolved = amBody('Disk', 'db-1', 'resolved');
    const response = await sendWebhook(resolved, signed(resolved));
    expect(response.body).toEqual({ accepted: 1, duplicates: 0, ignored: 0 });
    expect((await allAlerts())[0]?.state).toBe('resolved');
  });

  it('checks the signature against the exact bytes received', async () => {
    await reset();
    const raw = `{ "version" : "4",\n "alerts": [ { "status":"firing", "labels":{"alertname":"สวัสดี"}, "startsAt":"2026-11-02T03:00:00Z" } ] }`;
    const response = await sendWebhook(raw, signed(raw));
    expect(response.status).toBe(200);
    expect((await allAlerts())[0]?.title).toBe('สวัสดี');
  });

  it('refuses no signature, a wrong secret, another body, a replay outside five minutes with 401, and writes nothing', async () => {
    await reset();
    const raw = amBody('HighErrorRate', 'checkout-2');
    const wrongSecret = alerts.signAlertWebhook({
      rawBody: raw,
      secret: randomBytes(24).toString('hex'),
      timestampSeconds: Math.floor(Date.now() / 1000),
    });
    const attempts: (string | undefined)[] = [
      undefined,
      'garbage',
      wrongSecret,
      signed(raw + ' '),
      signed(raw, -400),
      signed(raw, 400),
    ];
    for (const header of attempts) {
      const response = await sendWebhook(raw, header);
      expect(response.status, String(header)).toBe(401);
    }
    expect(await allAlerts()).toHaveLength(0);
  });

  it('answers 400 to a signed body that is not an Alertmanager payload', async () => {
    const raw = JSON.stringify({ hello: 'world' });
    expect((await sendWebhook(raw, signed(raw))).status).toBe(400);
    const notJson = '{nope';
    expect((await sendWebhook(notJson, signed(notJson))).status).toBe(400);
  });

  it('counts a bad alert inside a good request as ignored and still applies the rest', async () => {
    await reset();
    const raw = JSON.stringify({
      version: '4',
      alerts: [
        { status: 'firing', labels: { alertname: 'Good' }, startsAt: '2026-11-02T03:00:00Z' },
        { status: 'firing', labels: {} },
      ],
    });
    const response = await sendWebhook(raw, signed(raw));
    expect(response.body).toEqual({ accepted: 1, duplicates: 0, ignored: 1 });
  });
});

describe('what the log and the audit trail hold', () => {
  it('never contain the secret, a signature, a token or the body of an alert', async () => {
    const raw = amBody('SecretAlertName', 'log-check');
    const header = signed(raw);
    await sendWebhook(raw, header);
    await sendWebhook(raw, header.replace('v1=', 'v1=0'));
    const jwt = await token();
    await pushGcp(envelope(incident({ policy_name: 'PolicyNameInLog' }), '7200'), {
      authorization: `Bearer ${jwt}`,
    });
    const log = logs.raw();
    for (const forbidden of [WEBHOOK_SECRET, header, jwt, 'Error rate above 5%']) {
      expect(log.includes(forbidden), forbidden.slice(0, 12)).toBe(false);
    }
    const audit = await h.db.owner.pool.query<{ rows: string }>(
      `SELECT coalesce(json_agg(row_to_json(a)), '[]')::text AS rows FROM audit_log a`,
    );
    for (const forbidden of [WEBHOOK_SECRET, header, jwt]) {
      expect(audit.rows[0]?.rows.includes(forbidden)).toBe(false);
    }
  });
});

describe('not configured, keys unavailable, flood', () => {
  it('answers 503 to the GCP route and 401 to the webhook when nothing is configured', async () => {
    const bare = await startHarness();
    try {
      const gcp = await bare.client().post(GCP, envelope(incident()), {
        headers: { authorization: `Bearer ${await token()}` },
        origin: null,
        csrf: false,
      });
      expect(gcp.status).toBe(503);
      const raw = amBody('X', 'y');
      const webhook = await fetch(`${bare.base}${WEBHOOK}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [ALERT_WEBHOOK_SIGNATURE_HEADER]: signed(raw),
        },
        body: raw,
      });
      expect(webhook.status).toBe(401);
      expect((await bare.db.owner.db.select().from(schema.alert)).length).toBe(0);
    } finally {
      await bare.close();
    }
  });

  it('answers 503 (so Pub/Sub retries) when the Google keys cannot be fetched', async () => {
    const broken = await startHarness({
      overrides: [
        {
          token: ALERT_PUSH_VERIFIER,
          value: createOidcPushVerifier({
            audience: AUDIENCE,
            serviceAccountEmail: SERVICE_ACCOUNT,
            keys: () => {
              throw new joseErrors.JWKSTimeout();
            },
          }),
        },
      ],
    });
    try {
      const response = await broken.client().post(GCP, envelope(incident()), {
        headers: { authorization: `Bearer ${await token()}` },
        origin: null,
        csrf: false,
      });
      expect(response.status).toBe(503);
    } finally {
      await broken.close();
    }
  });

  it('limits a verified source, and forged requests from the same address do not use its budget up', async () => {
    const limited = await startHarness({
      env: { ALERT_INGEST_RATE_PER_MINUTE: '3', ALERT_WEBHOOK_SECRET: WEBHOOK_SECRET },
    });
    try {
      const where = { base: limited.base, ip: '198.51.100.7' };
      const raw = amBody('Budget', 'b-1');
      // Ten forged requests from the very address the real sender uses (a proxy that hides the real one).
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect((await sendWebhook(raw, 'garbage', where)).status).toBe(401);
      }
      // The real sender still gets its three deliveries per minute, from any address...
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const body = amBody('Budget', `b-${String(attempt + 2)}`);
        statuses.push((await sendWebhook(body, signed(body), where)).status);
      }
      // ...and the fourth is over the budget of the source, not of the address.
      expect(statuses).toEqual([200, 200, 200, 429]);
      const other = amBody('Budget', 'b-other');
      expect((await sendWebhook(other, signed(other), { base: limited.base })).status).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it('answers 429 to an address that keeps failing authentication, with no work done', async () => {
    const where = { ip: '198.51.100.8' };
    const raw = amBody('Flood', 'f-1');
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 32; attempt += 1) {
      statuses.push((await sendWebhook(raw, 'garbage', where)).status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    // Even a correct signature from that address waits; another address is not affected.
    expect((await sendWebhook(raw, signed(raw), where)).status).toBe(429);
    expect((await sendWebhook(raw, signed(raw))).status).toBe(200);
  });

  it('GCP: forged tokens do not use up the budget of the Pub/Sub service account', async () => {
    const limited = await startHarness({
      env: { ALERT_INGEST_RATE_PER_MINUTE: '2' },
      overrides: [{ token: ALERT_PUSH_VERIFIER, value: pushVerifier }],
    });
    try {
      const forged = { authorization: `Bearer ${'x'.repeat(40)}` };
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await limited.client().post(GCP, envelope(incident()), {
          headers: forged,
          origin: null,
          csrf: false,
        });
        expect(response.status).toBe(401);
      }
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await limited
          .client()
          .post(GCP, envelope(incident({}, `vm-${String(attempt)}`)), {
            headers: await bearer(),
            origin: null,
            csrf: false,
          });
        statuses.push(response.status);
      }
      expect(statuses).toEqual([200, 200, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('payloads that can never be valid (review of T-200)', () => {
  it('a severity word that exists on every object is just an unknown severity', async () => {
    await reset();
    for (const word of ['constructor', '__proto__', 'toString']) {
      const response = await pushGcp(
        envelope(incident({ severity: word }, `sev-${word}`)),
        await bearer(),
      );
      expect(response.status, word).toBe(200);
      expect(response.body).toEqual({ accepted: 1, duplicates: 0, ignored: 0 });
    }
    expect((await allAlerts()).map((row) => row.severity)).toEqual([
      'unknown',
      'unknown',
      'unknown',
    ]);
    const raw = JSON.stringify({
      version: '4',
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'Odd', severity: 'constructor' },
          startsAt: '2026-11-02T03:00:00Z',
        },
      ],
    });
    expect((await sendWebhook(raw, signed(raw))).body).toEqual({
      accepted: 1,
      duplicates: 0,
      ignored: 0,
    });
  });

  it('a stale close from an old incident is acknowledged and leaves the newer alert open', async () => {
    await reset();
    await pushGcp(envelope(incident({ incident_id: '0.old' }), '8001'), await bearer());
    await pushGcp(envelope(incident({ incident_id: '0.new' }), '8002'), await bearer());
    const stale = await pushGcp(
      envelope(
        incident({ incident_id: '0.old', state: 'closed', ended_at: 1_793_585_400 }),
        '8003',
      ),
      await bearer(),
    );
    expect(stale.status).toBe(200);
    expect(stale.body).toEqual({ accepted: 0, duplicates: 0, ignored: 1 });
    expect((await allAlerts())[0]).toMatchObject({ state: 'open', count: 2 });
  });

  it('every delivery that changes an alert is on the audit log, with no content', async () => {
    await reset();
    await pushGcp(
      envelope(incident({ summary: 'Contact jane@example.invalid' }), '8101'),
      await bearer(),
    );
    await pushGcp(envelope(incident(), '8102'), await bearer());
    const audit = await h.db.owner.pool.query<{
      metadata: Record<string, unknown>;
      actor_type: string;
    }>(
      `SELECT metadata, actor_type FROM audit_log
        WHERE action = 'alert.ingest' AND target_id = $1 ORDER BY created_at`,
      [(await allAlerts())[0]?.id],
    );
    expect(audit.rows.map((row) => row.metadata.kind)).toEqual(['opened', 'counted']);
    expect(audit.rows.every((row) => row.actor_type === 'system')).toBe(true);
    expect(JSON.stringify(audit.rows)).not.toContain('jane');
  });
});
