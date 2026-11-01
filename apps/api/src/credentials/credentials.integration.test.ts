import { createCredentialStore, createDatabase } from '@watchtower/db';
import type { IntegrationList, IntegrationStatus, TestConnectionResult } from '@watchtower/shared';
import { pickCredentialEnv } from '@watchtower/shared';
import { LocalKms } from '@watchtower/shared/credential-box';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCredentialsCli } from '../cli/credentials-cli.js';
import { startHarness, type Harness } from '../testing/harness.js';
import { captureLogs } from '../testing/support.js';
import { signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';
import { ConnectionTesterRegistry } from './connection-tester.js';

// T-116a (ADR-004, ADR-012): the credential store over HTTP, on real Postgres and Redis.
// Every value below is a made-up marker so the tests can search logs, audit rows and responses for it.

const SECRET = 'PLAINTEXT-channel-secret-3c9d7e1a';
const TOKEN = 'PLAINTEXT-access-token-b82f04aa';
const TYPED = 'PLAINTEXT-typed-not-saved-51d0c9';
const ENV_TOKEN = 'PLAINTEXT-from-environment-9e66aa';
const MARKERS = [SECRET, TOKEN, TYPED, ENV_TOKEN];

const logs = captureLogs();
let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;

const owner = () => h.db.owner.pool;
/** Every response body the tests received, as text, to search at the end. */
const seen: string[] = [];

async function call<T>(
  who: Persona,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
) {
  const response = await who.client.request<T>(method, path, body === undefined ? {} : { body });
  seen.push(JSON.stringify(response.body));
  return response;
}

beforeAll(async () => {
  h = await startHarness({
    logs,
    env: {
      LOG_LEVEL: 'trace',
      // The environment sets one field of LINE: it wins over any saved value.
      LINE_CHANNEL_ACCESS_TOKEN: ENV_TOKEN,
    },
  });
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  const org = await lead.client.post<{ id: string }>('/v1/orgs', { name: 'Acme Credentials' });
  client = await signIn(h, 'client', org.body.id);
});
afterAll(async () => {
  await h.close();
});

async function auditRows(action: string) {
  const result = await owner().query<{
    actor_id: string | null;
    actor_type: string;
    outcome: string;
    target_type: string | null;
    target_id: string | null;
    before: unknown;
    after: unknown;
    metadata: Record<string, unknown>;
  }>(
    `SELECT actor_id, actor_type, outcome, target_type, target_id, before, after, metadata
       FROM audit_log WHERE action = $1 ORDER BY created_at, id`,
    [action],
  );
  return result.rows;
}

describe('access', () => {
  const routes: readonly [string, string, unknown][] = [
    ['GET', '/v1/admin/integrations', undefined],
    ['PUT', '/v1/admin/integrations/line', { fields: { channelId: 'x' } }],
    ['DELETE', '/v1/admin/integrations/line/fields/channelId', undefined],
    ['POST', '/v1/admin/integrations/line/test', {}],
  ];

  it('is for the head only: lead, agent and client get 403, no session gets 401', async () => {
    for (const [method, path, body] of routes) {
      for (const who of [lead, agent, client]) {
        const response = await who.client.request(method, path, body === undefined ? {} : { body });
        expect(response.status, `${who.session.user.role} ${method} ${path}`).toBe(403);
      }
      const anonymous = await h
        .client()
        .request(method, path, body === undefined ? {} : { body, csrf: false });
      expect(anonymous.status, `anonymous ${method} ${path}`).toBe(401);
    }
    // Nothing was written by the refused calls.
    expect((await owner().query('SELECT 1 FROM integration_credential')).rowCount).toBe(0);
  });
});

describe('GET /v1/admin/integrations', () => {
  it('lists every integration with what is set, never a value; the environment shows as env', async () => {
    const response = await call<IntegrationList>(head, 'GET', '/v1/admin/integrations');
    expect(response.status).toBe(200);
    expect(response.body.testMode).toBe('mock');
    const keys = response.body.items.map((item) => item.key);
    expect(keys).toEqual(expect.arrayContaining(['gmail', 'line', 'discord', 'github', 'ai']));

    const line = response.body.items.find((item) => item.key === 'line');
    expect(line?.status).toBe('partial');
    expect(line?.fields.find((field) => field.field === 'channelAccessToken')).toEqual({
      field: 'channelAccessToken',
      label: 'Channel access token',
      secret: true,
      required: true,
      configured: true,
      source: 'env',
      envVar: 'LINE_CHANNEL_ACCESS_TOKEN',
      updatedAt: null,
      updatedBy: null,
    });
    expect(line?.fields.find((field) => field.field === 'channelSecret')).toMatchObject({
      configured: false,
      source: 'none',
    });
    expect(JSON.stringify(response.body)).not.toContain(ENV_TOKEN);
  });
});

describe('PUT /v1/admin/integrations/:integration', () => {
  it('saves encrypted, answers with status only, and audits field names', async () => {
    const response = await call<IntegrationStatus>(head, 'PUT', '/v1/admin/integrations/line', {
      fields: { channelSecret: SECRET, channelId: '  1234567  ' },
    });
    expect(response.status).toBe(200);
    expect(response.body.key).toBe('line');
    const secret = response.body.fields.find((field) => field.field === 'channelSecret');
    expect(secret).toMatchObject({
      configured: true,
      source: 'db',
      updatedBy: { id: head.userId },
    });
    expect(secret?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Every byte of the answer: no value, no mask, no length.
    const text = JSON.stringify(response.body);
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/last4|mask|length|value/i);

    const rows = await owner().query<{
      field: string;
      value_sealed: string;
      dek_wrapped: string;
      key_version: number;
    }>(
      `SELECT field, value_sealed, dek_wrapped, key_version FROM integration_credential ORDER BY field`,
    );
    expect(rows.rows.map((row) => row.field)).toEqual(['channelId', 'channelSecret']);
    for (const row of rows.rows) {
      expect(row.key_version).toBe(1);
      expect(JSON.stringify(row)).not.toContain(SECRET);
      expect(JSON.stringify(row)).not.toContain('1234567');
    }

    const audit = await auditRows('integration.credential.set');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: 'user',
      actor_id: head.userId,
      outcome: 'success',
      target_type: 'integration',
      target_id: 'line',
      metadata: expect.objectContaining({ fields: ['channelId', 'channelSecret'] }) as unknown,
    });
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    expect(JSON.stringify(audit)).not.toContain('1234567');
  });

  it('shows the saved field to the head with who and when, on the next read', async () => {
    const response = await call<IntegrationList>(head, 'GET', '/v1/admin/integrations');
    const line = response.body.items.find((item) => item.key === 'line');
    expect(line?.fields.find((field) => field.field === 'channelSecret')).toMatchObject({
      source: 'db',
      configured: true,
      updatedBy: { id: head.userId },
    });
    // required: channelId, channelSecret and the env one => complete.
    expect(line?.status).toBe('configured');
  });

  it('refuses a field that an environment variable sets (409) and writes nothing of the request', async () => {
    const response = await call<ApiErrorBody>(head, 'PUT', '/v1/admin/integrations/line', {
      fields: { channelSecret: 'PLAINTEXT-would-replace', channelAccessToken: TYPED },
    });
    expect(response.status).toBe(409);
    expect(response.body.message).toContain('LINE_CHANNEL_ACCESS_TOKEN');
    expect(response.body.message).not.toContain(TYPED);
    const rows = await owner().query(
      `SELECT 1 FROM integration_credential WHERE field = 'channelAccessToken'`,
    );
    expect(rows.rowCount).toBe(0);
    // The first field of the same request was not written either.
    const secret = await call<IntegrationList>(head, 'GET', '/v1/admin/integrations');
    expect(
      secret.body.items
        .find((item) => item.key === 'line')
        ?.fields.find((field) => field.field === 'channelSecret')?.updatedAt,
    ).not.toBeNull();
    const failure = await auditRows('integration.credential.set');
    expect(failure.at(-1)).toMatchObject({ outcome: 'failure' });
    expect(JSON.stringify(failure)).not.toContain(TYPED);
  });

  it('validates the request: unknown integration or field, empty, blank and oversized values', async () => {
    const bodies: [string, unknown][] = [
      ['/v1/admin/integrations/nope', { fields: { a: 'b' } }],
      ['/v1/admin/integrations/line', { fields: { nope: 'b' } }],
      ['/v1/admin/integrations/line', { fields: {} }],
      ['/v1/admin/integrations/line', {}],
      ['/v1/admin/integrations/line', { fields: { channelId: '   ' } }],
      ['/v1/admin/integrations/line', { fields: { channelId: 12 } }],
      ['/v1/admin/integrations/line', { fields: { channelId: 'x'.repeat(20_000) } }],
    ];
    for (const [path, body] of bodies) {
      const response = await call<ApiErrorBody>(head, 'PUT', path, body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
  });

  it('replaces a value and keeps the other fields', async () => {
    await call(head, 'PUT', '/v1/admin/integrations/line', { fields: { channelId: '7654321' } });
    const store = createCredentialStore({
      database: h.db.owner,
      kms: new LocalKms({ current: { rootKey: h.config.APP_ENCRYPTION_KEY, version: 1 } }),
      env: {},
    });
    const resolved = await store.resolve('line');
    expect(resolved.channelId?.value).toBe('7654321');
    expect(resolved.channelSecret?.value).toBe(SECRET);
  });
});

describe('DELETE /v1/admin/integrations/:integration/fields/:field', () => {
  it('deletes a saved field (204), audits it, and then answers 404', async () => {
    await call(head, 'PUT', '/v1/admin/integrations/discord', {
      fields: { botToken: 'PLAINTEXT-discord-bot-1' },
    });
    const first = await call(head, 'DELETE', '/v1/admin/integrations/discord/fields/botToken');
    expect(first.status).toBe(204);
    const again = await call<ApiErrorBody>(
      head,
      'DELETE',
      '/v1/admin/integrations/discord/fields/botToken',
    );
    expect(again.status).toBe(404);
    expect(
      (await owner().query(`SELECT 1 FROM integration_credential WHERE integration = 'discord'`))
        .rowCount,
    ).toBe(0);
    const audit = await auditRows('integration.credential.delete');
    expect(audit.map((row) => row.outcome)).toEqual(['success', 'failure']);
    expect(audit[0]).toMatchObject({
      target_id: 'discord',
      metadata: expect.objectContaining({ fields: ['botToken'] }) as unknown,
    });
  });

  it('rejects a field that is not in the catalog', async () => {
    const response = await call<ApiErrorBody>(
      head,
      'DELETE',
      '/v1/admin/integrations/discord/fields/nope',
    );
    expect(response.status).toBe(400);
  });
});

describe('POST /v1/admin/integrations/:integration/test', () => {
  const test = (integration: string, body: unknown = {}) =>
    call<TestConnectionResult & ApiErrorBody>(
      head,
      'POST',
      `/v1/admin/integrations/${integration}/test`,
      body,
    );

  it('uses the offline fake while live tests are off, and says what is missing', async () => {
    const missing = await test('github');
    expect(missing.status).toBe(200);
    expect(missing.body).toMatchObject({ ok: false, mode: 'mock', identity: null });
    expect(missing.body.message).toContain('App ID');

    const typed = await test('github', { fields: { appId: '123', privateKey: TYPED } });
    expect(typed.body).toMatchObject({ ok: true, mode: 'mock', identity: 'mock:github' });
    expect(JSON.stringify(typed.body)).not.toContain(TYPED);
    // Testing unsaved values saved nothing.
    expect(
      (await owner().query(`SELECT 1 FROM integration_credential WHERE integration = 'github'`))
        .rowCount,
    ).toBe(0);
  });

  it('tests the values in effect: saved ones and the environment', async () => {
    const result = await test('line');
    expect(result.body).toMatchObject({ ok: true, mode: 'mock', identity: 'mock:line' });
  });

  it('knows the AI provider needs one of its keys, not all', async () => {
    expect((await test('ai')).body.ok).toBe(false);
    expect((await test('ai', { fields: { vertexProjectId: 'p' } })).body.ok).toBe(true);
  });

  it('rejects unknown fields and integrations', async () => {
    expect((await test('line', { fields: { nope: 'x' } })).status).toBe(400);
    expect((await test('nope')).status).toBe(400);
  });

  it('is audited with the outcome and the names of the fields typed, never their values', async () => {
    const audit = await auditRows('integration.credential.test');
    expect(audit.length).toBeGreaterThanOrEqual(4);
    const typed = audit.find(
      (row) =>
        row.target_id === 'github' &&
        Array.isArray(row.metadata.suppliedFields) &&
        row.metadata.suppliedFields.length === 2,
    );
    expect(typed?.metadata).toMatchObject({
      ok: true,
      mode: 'mock',
      suppliedFields: ['appId', 'privateKey'],
    });
    expect(JSON.stringify(audit)).not.toContain(TYPED);
  });

  it('reports a saved value that the current key cannot open, without a value', async () => {
    await owner().query(
      `INSERT INTO integration_credential (integration, field, value_sealed, dek_wrapped, key_version)
       VALUES ('web_push', 'vapidPublic', 'v1.AAAA.BBBB.CCCC', 'v1.AAAA.BBBB.CCCC', 9)`,
    );
    const result = await test('web_push');
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(false);
    expect(result.body.message).toMatch(/cannot be opened/);
    await owner().query(`DELETE FROM integration_credential WHERE integration = 'web_push'`);
  });
});

describe('live tests stay behind the flag', () => {
  it('never calls an adapter live check while the flag is off', async () => {
    let called = 0;
    h.app.get(ConnectionTesterRegistry).register({
      integration: 'discord',
      fake: () => ({ ok: true, identity: 'fake', message: 'fake' }),
      live: () => {
        called += 1;
        return Promise.resolve({ ok: true, identity: 'real', message: 'real' });
      },
    });
    const result = await call<TestConnectionResult>(
      head,
      'POST',
      '/v1/admin/integrations/discord/test',
      {},
    );
    expect(result.body).toMatchObject({ mode: 'mock', identity: 'fake' });
    expect(called).toBe(0);
  });

  it('with the flag on, runs the live check, and tells when there is none', async () => {
    const live = await startHarness({ env: { CREDENTIAL_LIVE_TEST_ENABLED: 'true' } });
    try {
      const admin = await signIn(live, 'head');
      expect(
        (await admin.client.get<IntegrationList>('/v1/admin/integrations')).body.testMode,
      ).toBe('live');

      const none = await admin.client.post<TestConnectionResult>(
        '/v1/admin/integrations/line/test',
        {},
      );
      expect(none.body).toMatchObject({ ok: false, mode: 'live' });
      expect(none.body.message).toMatch(/no live check/i);

      let received: Record<string, string> = {};
      live.app.get(ConnectionTesterRegistry).register({
        integration: 'line',
        fake: () => ({ ok: true, identity: 'fake', message: 'fake' }),
        live: (config) => {
          received = { ...config };
          return Promise.resolve({ ok: true, identity: 'bot-name', message: 'Connected' });
        },
      });
      const ok = await admin.client.post<TestConnectionResult>('/v1/admin/integrations/line/test', {
        fields: { channelSecret: TYPED },
      });
      expect(ok.body).toMatchObject({ ok: true, mode: 'live', identity: 'bot-name' });
      expect(received.channelSecret).toBe(TYPED);

      live.app.get(ConnectionTesterRegistry).register({
        integration: 'line',
        fake: () => ({ ok: true, identity: 'fake', message: 'fake' }),
        live: () => Promise.reject(new Error(`provider said: bad token ${TYPED}`)),
      });
      const failed = await admin.client.post<TestConnectionResult>(
        '/v1/admin/integrations/line/test',
        { fields: { channelSecret: TYPED } },
      );
      expect(failed.body).toMatchObject({ ok: false, mode: 'live' });
      expect(JSON.stringify(failed.body)).not.toContain(TYPED);
    } finally {
      await live.close();
    }
  });
});

describe('rotation', () => {
  it('re-wraps under a new key version through the CLI, with no value in its output or the audit row', async () => {
    const newRoot = 'rotated-root-key-0123456789abcdef-new';
    const rotatedConfig = {
      ...h.config,
      APP_ENCRYPTION_KEY: newRoot,
      APP_ENCRYPTION_KEY_VERSION: 2,
      APP_ENCRYPTION_KEY_PREVIOUS: h.config.APP_ENCRYPTION_KEY,
      APP_ENCRYPTION_KEY_PREVIOUS_VERSION: 1,
    };
    const app = createDatabase({ url: h.db.appUrl, max: 2 });
    const out: string[] = [];
    const err: string[] = [];
    try {
      const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
      expect(await runCredentialsCli(['status'], rotatedConfig, app, io)).toBe(0);
      expect(out.join('\n')).toContain('key version 1: 2 row(s) (needs rotate)');

      expect(await runCredentialsCli(['rotate'], rotatedConfig, app, io)).toBe(0);
      expect(out.join('\n')).toContain('rotated to key version 2: 2 re-wrapped');
      expect(err).toEqual([]);
      expect(await runCredentialsCli(['rotate'], rotatedConfig, app, io)).toBe(0);
      expect(out.join('\n')).toContain('0 re-wrapped, 2 already current');

      expect(await runCredentialsCli(['nope'], rotatedConfig, app, io)).toBe(2);
    } finally {
      await app.close();
    }

    const versions = await owner().query<{ key_version: number }>(
      `SELECT DISTINCT key_version FROM integration_credential`,
    );
    expect(versions.rows).toEqual([{ key_version: 2 }]);

    // Only the new key is configured now: the saved values still open.
    const retired = createCredentialStore({
      database: h.db.owner,
      kms: new LocalKms({ current: { rootKey: newRoot, version: 2 } }),
      env: pickCredentialEnv({}),
    });
    const resolved = await retired.resolve('line');
    expect(resolved.channelSecret?.value).toBe(SECRET);
    expect(resolved.channelId?.value).toBe('7654321');

    const audit = await auditRows('integration.credential.rotate');
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      actor_type: 'system',
      actor_id: 'credentials-cli',
      outcome: 'success',
      metadata: expect.objectContaining({
        rewrapped: 2,
        fromVersions: [1],
        toVersion: 2,
      }) as unknown,
    });
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    expect(JSON.stringify(audit)).not.toContain(newRoot);
    expect(out.join('\n') + err.join('\n')).not.toContain(SECRET);
    expect(out.join('\n') + err.join('\n')).not.toContain(newRoot);
  });
});

describe('no plaintext anywhere (N1)', () => {
  it('appears in no log line, no response body and no audit row', async () => {
    // The log captured everything the api wrote at trace level while all of the above ran.
    const log = logs.raw();
    expect(log.length).toBeGreaterThan(0);
    // The requests themselves were logged, so the search below looks at something real.
    expect(log).toContain('/v1/admin/integrations');
    const audit = await owner().query<{ text: string }>(
      `SELECT row_to_json(a)::text AS text FROM audit_log a`,
    );
    const auditText = audit.rows.map((row) => row.text).join('\n');
    const everything = seen.join('\n');
    expect(everything.length).toBeGreaterThan(0);
    for (const marker of MARKERS) {
      expect(log, `log contains ${marker}`).not.toContain(marker);
      expect(everything, `a response contains ${marker}`).not.toContain(marker);
      expect(auditText, `audit contains ${marker}`).not.toContain(marker);
    }
    expect(log).not.toContain('1234567');
    // The root keys never appear either.
    expect(log).not.toContain(h.config.APP_ENCRYPTION_KEY);
    expect(auditText).not.toContain(h.config.APP_ENCRYPTION_KEY);
  });
});
