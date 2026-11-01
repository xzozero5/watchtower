import { LocalKms } from '@watchtower/shared/credential-box';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from './client.js';
import {
  CredentialStoreError,
  createCredentialStore,
  type CredentialStore,
  type CredentialStoreOptions,
} from './credentials.js';
import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// T-116a (ADR-012): the credential store on a real Postgres, through the restricted application role.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const ROOT_1 = 'credential-root-key-one-0123456789abcdef';
const ROOT_2 = 'credential-root-key-two-0123456789abcdef';
const SECRET = 'LINE-SECRET-plaintext-9f1c2d';
const TOKEN = 'LINE-TOKEN-plaintext-77aa11';

let testDb: TestDatabase;
let app: Database;
let actorId: string;
const owner = () => testDb.owner.pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = createDatabase({ url: testDb.appUrl, max: 3, applicationName: 'wt-test-credentials' });
  const user = await owner().query<{ id: string }>(
    `INSERT INTO users (email, name, role) VALUES ('head-cred@example.com', 'Head Cred', 'head') RETURNING id`,
  );
  actorId = user.rows[0]?.id ?? '';
});
afterAll(async () => {
  await app.close();
  await testDb.cleanup();
});
beforeEach(async () => {
  await owner().query('DELETE FROM integration_credential');
});

const kmsV1 = () => new LocalKms({ current: { rootKey: ROOT_1, version: 1 } });
const kmsV2 = () =>
  new LocalKms({
    current: { rootKey: ROOT_2, version: 2 },
    previous: { rootKey: ROOT_1, version: 1 },
  });

function store(
  kms = kmsV1(),
  env: CredentialStoreOptions['env'] = {},
  extra: Partial<CredentialStoreOptions> = {},
): CredentialStore {
  return createCredentialStore({ database: app, kms, env, ...extra });
}

describe('0010_integration_credential', () => {
  it('creates the table, drops the unused column, and goes back and forth', async () => {
    const later = await migrationsAfter('0010_integration_credential');
    expect(await migrateDown(owner(), { steps: 1 + later.length })).toEqual([
      ...later.toReversed(),
      '0010_integration_credential',
    ]);
    const gone = await owner().query(`SELECT to_regclass('public.integration_credential') AS t`);
    expect(gone.rows[0]).toEqual({ t: null });
    const column = await owner().query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'channel_account' AND column_name = 'config_encrypted'`,
    );
    expect(column.rowCount).toBe(1);

    expect(await migrateUp(owner())).toEqual(['0010_integration_credential', ...later]);
    const back = await owner().query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'channel_account' AND column_name = 'config_encrypted'`,
    );
    expect(back.rowCount).toBe(0);
  });

  it('refuses to drop channel_account.config_encrypted while a row holds data', async () => {
    const later = await migrationsAfter('0010_integration_credential');
    await migrateDown(owner(), { steps: 1 + later.length });
    await owner().query(
      `INSERT INTO channel_account (type, name, config_encrypted) VALUES ('line', 'has data', '\\x01')`,
    );
    await expect(migrateUp(owner())).rejects.toThrow(/config_encrypted holds data/);
    await owner().query(`DELETE FROM channel_account WHERE name = 'has data'`);
    expect((await migrateUp(owner())).length).toBe(1 + later.length);
  });

  it('has no plaintext-like column and enforces names, versions and one row per field', async () => {
    const columns = await owner().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'integration_credential'`,
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      'created_at',
      'created_by',
      'dek_wrapped',
      'field',
      'id',
      'integration',
      'key_version',
      'updated_at',
      'updated_by',
      'value_sealed',
    ]);
    const insert = (integration: string, field: string, version: number) =>
      owner().query(
        `INSERT INTO integration_credential (integration, field, value_sealed, dek_wrapped, key_version)
         VALUES ($1, $2, 'a', 'b', $3)`,
        [integration, field, version],
      );
    await insert('line', 'channelSecret', 1);
    await expect(insert('line', 'channelSecret', 1)).rejects.toThrow(
      /integration_credential_field_key/,
    );
    await expect(insert('Bad Name', 'x', 1)).rejects.toThrow(/integration_check/);
    await expect(insert('line', 'bad field', 1)).rejects.toThrow(/field_check/);
    await expect(insert('line', 'other', 0)).rejects.toThrow(/key_version_check/);
  });

  it('lets the application role read, write and delete, and not truncate or alter', async () => {
    await app.pool.query(
      `INSERT INTO integration_credential (integration, field, value_sealed, dek_wrapped, key_version)
       VALUES ('line', 'channelSecret', 'a', 'b', 1)`,
    );
    await app.pool.query(`UPDATE integration_credential SET key_version = 2`);
    expect((await app.pool.query(`SELECT 1 FROM integration_credential`)).rowCount).toBe(1);
    await app.pool.query(`DELETE FROM integration_credential`);
    await expect(app.pool.query(`TRUNCATE integration_credential`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(app.pool.query(`DROP TABLE integration_credential`)).rejects.toThrow(
      /must be owner/,
    );
  });
});

describe('credential store', () => {
  it('saves encrypted, reads back what was saved, and keeps the database free of plaintext', async () => {
    const s = store();
    const written = await s.put(
      'line',
      { channelSecret: SECRET, channelAccessToken: TOKEN },
      actorId,
    );
    expect(written.sort()).toEqual(['channelAccessToken', 'channelSecret']);

    const resolved = await s.resolve('line');
    expect(resolved.channelSecret).toEqual({ value: SECRET, source: 'db' });
    expect(resolved.channelAccessToken).toEqual({ value: TOKEN, source: 'db' });
    expect(resolved.channelId).toBeUndefined();

    const dump = await owner().query(
      `SELECT row_to_json(t)::text AS j FROM integration_credential t`,
    );
    const text = dump.rows.map((row: { j: string }) => row.j).join('\n');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(TOKEN);
    const raw = await owner().query<{ value_sealed: string; dek_wrapped: string }>(
      `SELECT value_sealed, dek_wrapped FROM integration_credential WHERE field = 'channelSecret'`,
    );
    expect(raw.rows[0]?.value_sealed).toMatch(/^v1\./);
    expect(raw.rows[0]?.dek_wrapped).toMatch(/^v1\./);
  });

  it('replaces a value, keeps created_by, and changes updated_by and the data key', async () => {
    const s = store();
    await s.put('line', { channelSecret: SECRET }, actorId);
    const before = await owner().query<{ dek_wrapped: string; value_sealed: string }>(
      `SELECT dek_wrapped, value_sealed FROM integration_credential`,
    );
    const second = await owner().query<{ id: string }>(
      `INSERT INTO users (email, name, role) VALUES ('head2-cred@example.com', 'Second Head', 'head') RETURNING id`,
    );
    const otherId = second.rows[0]?.id ?? '';
    await s.put('line', { channelSecret: 'replacement-value' }, otherId);
    const after = await owner().query<{
      dek_wrapped: string;
      value_sealed: string;
      created_by: string;
      updated_by: string;
    }>(`SELECT dek_wrapped, value_sealed, created_by, updated_by FROM integration_credential`);
    expect(after.rowCount).toBe(1);
    expect(after.rows[0]?.created_by).toBe(actorId);
    expect(after.rows[0]?.updated_by).toBe(otherId);
    expect(after.rows[0]?.dek_wrapped).not.toBe(before.rows[0]?.dek_wrapped);
    expect(after.rows[0]?.value_sealed).not.toBe(before.rows[0]?.value_sealed);
    expect((await s.resolve('line')).channelSecret?.value).toBe('replacement-value');
  });

  it('reports status without values: configured, source, who and when', async () => {
    const s = store();
    expect((await s.status('line'))[0]).toMatchObject({ key: 'line', status: 'not_configured' });
    await s.put('line', { channelSecret: SECRET }, actorId);
    const [line] = await s.status('line');
    expect(line?.status).toBe('partial');
    const secret = line?.fields.find((field) => field.field === 'channelSecret');
    expect(secret).toMatchObject({
      configured: true,
      source: 'db',
      envVar: 'LINE_CHANNEL_SECRET',
      updatedBy: { id: actorId, name: 'Head Cred' },
    });
    expect(secret?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(line?.fields.find((field) => field.field === 'channelId')).toMatchObject({
      configured: false,
      source: 'none',
      updatedAt: null,
      updatedBy: null,
    });
    expect(JSON.stringify(line)).not.toContain(SECRET);

    await s.put('line', { channelId: '1234', channelAccessToken: TOKEN }, actorId);
    expect((await s.status('line'))[0]?.status).toBe('configured');
    expect((await s.status()).map((entry) => entry.key)).toEqual(
      expect.arrayContaining(['gmail', 'line', 'discord', 'github', 'ai', 'web_push']),
    );
  });

  it('treats an integration with no required field as configured once any field is set', async () => {
    const s = store();
    expect((await s.status('ai'))[0]?.status).toBe('not_configured');
    await s.put('ai', { vertexLocation: 'asia-southeast1' }, actorId);
    expect((await s.status('ai'))[0]?.status).toBe('configured');
  });

  it('environment wins: resolve uses it, status says so, put refuses, delete still works', async () => {
    const withEnv = store(kmsV1(), { LINE_CHANNEL_SECRET: 'from-the-environment' });
    // A value stored before the variable was set is ignored afterwards.
    await store().put('line', { channelSecret: SECRET, channelAccessToken: TOKEN }, actorId);

    const resolved = await withEnv.resolve('line');
    expect(resolved.channelSecret).toEqual({ value: 'from-the-environment', source: 'env' });
    expect(resolved.channelAccessToken).toEqual({ value: TOKEN, source: 'db' });

    const [line] = await withEnv.status('line');
    expect(line?.fields.find((field) => field.field === 'channelSecret')).toMatchObject({
      configured: true,
      source: 'env',
      updatedAt: null,
      updatedBy: null,
    });

    await expect(withEnv.put('line', { channelSecret: 'new' }, actorId)).rejects.toMatchObject({
      code: 'env_locked',
    });
    // Nothing was written, not even the other fields of the same request.
    await expect(
      withEnv.put('line', { channelAccessToken: 'other', channelSecret: 'new' }, actorId),
    ).rejects.toBeInstanceOf(CredentialStoreError);
    expect((await store().resolve('line')).channelAccessToken?.value).toBe(TOKEN);

    expect(await withEnv.remove('line', 'channelSecret')).toBe(true);
  });

  it('ranks unsaved values between the environment and the database', async () => {
    const s = store(kmsV1(), { LINE_CHANNEL_ID: 'env-id' });
    await s.put('line', { channelSecret: SECRET }, actorId);
    const resolved = await s.resolve('line', {
      supplied: { channelId: 'typed-id', channelSecret: 'typed-secret' },
    });
    expect(resolved.channelId).toEqual({ value: 'env-id', source: 'env' });
    expect(resolved.channelSecret?.value).toBe('typed-secret');
    // Supplying values saved nothing.
    expect((await store().resolve('line')).channelSecret?.value).toBe(SECRET);
  });

  it('reads a field from the file an environment variable names, and never says the path', async () => {
    const files = new Map([['/run/keys/sa.json', '{"type":"service_account"}']]);
    const readFile = (path: string): Promise<string> => {
      const content = files.get(path);
      return content === undefined
        ? Promise.reject(new Error('ENOENT secret-path'))
        : Promise.resolve(content);
    };
    const ok = store(
      kmsV1(),
      { GMAIL_SERVICE_ACCOUNT_JSON_PATH: '/run/keys/sa.json' },
      { readFile },
    );
    expect((await ok.resolve('gmail')).serviceAccountJson).toEqual({
      value: '{"type":"service_account"}',
      source: 'env',
    });
    const broken = store(
      kmsV1(),
      { GMAIL_SERVICE_ACCOUNT_JSON_PATH: '/nowhere/sa.json' },
      { readFile },
    );
    const error = await broken.resolve('gmail').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'env_file_unreadable' });
    expect((error as Error).message).not.toContain('/nowhere');
    // Listing does not open the file.
    expect(
      (await broken.status('gmail'))[0]?.fields.find(
        (field) => field.field === 'serviceAccountJson',
      ),
    ).toMatchObject({ source: 'env', configured: true });
  });

  it('refuses unknown integrations and fields', async () => {
    const s = store();
    await expect(s.put('line', { nope: 'x' }, actorId)).rejects.toMatchObject({
      code: 'unknown_field',
    });
    await expect(s.remove('line', 'nope')).rejects.toMatchObject({ code: 'unknown_field' });
  });

  it('removes one field and reports when there was nothing to remove', async () => {
    const s = store();
    await s.put('line', { channelSecret: SECRET, channelAccessToken: TOKEN }, actorId);
    expect(await s.remove('line', 'channelSecret')).toBe(true);
    expect(await s.remove('line', 'channelSecret')).toBe(false);
    const resolved = await s.resolve('line');
    expect(resolved.channelSecret).toBeUndefined();
    expect(resolved.channelAccessToken?.value).toBe(TOKEN);
  });

  it('does not open a row moved to another field, or one written under a key that is gone', async () => {
    const s = store();
    await s.put('line', { channelSecret: SECRET, channelAccessToken: TOKEN }, actorId);
    // Swap the two ciphertexts: each now sits under the wrong field.
    await owner().query(`
      UPDATE integration_credential a
         SET value_sealed = b.value_sealed, dek_wrapped = b.dek_wrapped
        FROM integration_credential b
       WHERE a.field = 'channelSecret' AND b.field = 'channelAccessToken'`);
    const error = await s.resolve('line').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'cannot_open' });
    expect((error as Error).message).not.toContain(SECRET);
    expect((error as Error).message).not.toContain(TOKEN);

    await expect(
      store(new LocalKms({ current: { rootKey: ROOT_2, version: 1 } })).resolve('line'),
    ).rejects.toMatchObject({
      code: 'cannot_open',
    });
  });
});

describe('rotation', () => {
  it('re-wraps every data key under the new version without changing any value', async () => {
    await store().put(
      'line',
      { channelSecret: SECRET, channelAccessToken: TOKEN, channelId: '42' },
      actorId,
    );
    await store().put('discord', { botToken: 'discord-bot-token-value' }, actorId);
    const before = await owner().query<{
      field: string;
      value_sealed: string;
      dek_wrapped: string;
      updated_at: Date;
    }>(
      `SELECT field, value_sealed, dek_wrapped, updated_at FROM integration_credential ORDER BY field`,
    );

    const rotating = store(kmsV2());
    expect(await rotating.versionCounts()).toEqual([{ keyVersion: 1, rows: 4 }]);
    // Before rotation the new configuration already reads the old rows (previous key present).
    expect((await rotating.resolve('line')).channelSecret?.value).toBe(SECRET);

    const result = await rotating.rotate({ batchSize: 2 });
    expect(result).toMatchObject({
      rewrapped: 4,
      alreadyCurrent: 0,
      skipped: 0,
      failed: [],
      fromVersions: [1],
      toVersion: 2,
    });
    expect(await rotating.versionCounts()).toEqual([{ keyVersion: 2, rows: 4 }]);

    const after = await owner().query<{
      field: string;
      value_sealed: string;
      dek_wrapped: string;
      updated_at: Date;
    }>(
      `SELECT field, value_sealed, dek_wrapped, updated_at FROM integration_credential ORDER BY field`,
    );
    for (const [index, row] of after.rows.entries()) {
      expect(row.value_sealed).toBe(before.rows[index]?.value_sealed);
      expect(row.dek_wrapped).not.toBe(before.rows[index]?.dek_wrapped);
      expect(row.updated_at).toEqual(before.rows[index]?.updated_at);
    }

    // The old key can now be retired: only the new one is configured.
    const retired = store(new LocalKms({ current: { rootKey: ROOT_2, version: 2 } }));
    expect((await retired.resolve('line')).channelAccessToken?.value).toBe(TOKEN);
    expect((await retired.resolve('discord')).botToken?.value).toBe('discord-bot-token-value');

    // Idempotent.
    expect(await rotating.rotate()).toMatchObject({ rewrapped: 0, alreadyCurrent: 4, failed: [] });
  });

  it('writes made after the key change are already on the new version', async () => {
    const rotating = store(kmsV2());
    await rotating.put('line', { channelSecret: SECRET }, actorId);
    expect(await rotating.versionCounts()).toEqual([{ keyVersion: 2, rows: 1 }]);
  });

  it('reports rows it cannot open, keeps going, and leaves them untouched', async () => {
    await store().put('line', { channelSecret: SECRET }, actorId);
    await owner().query(
      `INSERT INTO integration_credential (integration, field, value_sealed, dek_wrapped, key_version)
       VALUES ('discord', 'botToken', 'v1.AAAA.BBBB.CCCC', 'v1.AAAA.BBBB.CCCC', 1),
              ('discord', 'webhookUrl', 'x', 'y', 7)`,
    );
    const rotating = store(kmsV2());
    const result = await rotating.rotate({ batchSize: 1 });
    expect(result.rewrapped).toBe(1);
    expect(result.failed).toEqual(
      expect.arrayContaining([
        { integration: 'discord', field: 'botToken', reason: 'cannot_open' },
        { integration: 'discord', field: 'webhookUrl', reason: 'no_key' },
      ]),
    );
    expect(result.failed).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const left = await owner().query<{ field: string; key_version: number }>(
      `SELECT field, key_version FROM integration_credential ORDER BY field`,
    );
    expect(left.rows).toEqual([
      { field: 'botToken', key_version: 1 },
      { field: 'channelSecret', key_version: 2 },
      { field: 'webhookUrl', key_version: 7 },
    ]);
  });
});
