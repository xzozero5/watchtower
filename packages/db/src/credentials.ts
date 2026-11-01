import { readFile } from 'node:fs/promises';

import {
  INTEGRATION_CATALOG,
  integrationFields,
  isIntegrationComplete,
  isIntegrationKey,
  type CredentialFieldStatus,
  type CredentialSource,
  type IntegrationKey,
  type IntegrationStatus,
} from '@watchtower/shared';
import {
  credentialContext,
  openCredential,
  rewrapCredential,
  sealCredential,
  type KmsPort,
} from '@watchtower/shared/credential-box';
import { and, asc, eq, gt, ne, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { integrationCredential, users } from './schema/index.js';

/** Anything with the query builders: the database handle or a transaction. */
export type CredentialExecutor = Pick<Database['db'], 'select' | 'insert' | 'update' | 'delete'>;

export const CREDENTIAL_ERROR_CODES = [
  /** The integration or field is not in the catalog. */
  'unknown_field',
  /** An environment variable sets this field, so the database value would never be used. */
  'env_locked',
  /** The variable names a file that cannot be read. */
  'env_file_unreadable',
  /** A stored value cannot be opened (no key for its version, or it was changed). */
  'cannot_open',
] as const;
export type CredentialErrorCode = (typeof CREDENTIAL_ERROR_CODES)[number];

/** Thrown by the store. The message names the integration, field or variable and never a value. */
export class CredentialStoreError extends Error {
  constructor(
    readonly code: CredentialErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialStoreError';
  }
}

export interface CredentialStoreOptions {
  readonly database: Pick<Database, 'db'>;
  readonly kms: KmsPort;
  /**
   * The environment variables of the catalog (use `pickCredentialEnv` on the validated configuration).
   * Passed in so the store never reads `process.env` itself and tests can supply their own.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Reads a file named by an `envKind: "file"` variable. Tests replace it. */
  readonly readFile?: (path: string) => Promise<string>;
}

/** The value in effect for one field and where it comes from. */
export interface ResolvedField {
  readonly value: string;
  readonly source: Exclude<CredentialSource, 'none'>;
}

export interface ResolveOptions {
  readonly executor?: CredentialExecutor;
  /**
   * Values not saved yet (the "test connection" button). They rank between the environment, which
   * still wins, and the database.
   */
  readonly supplied?: Readonly<Record<string, string>>;
}

export interface RotateFailure {
  readonly integration: string;
  readonly field: string;
  readonly reason: 'no_key' | 'cannot_open';
}

export interface RotateResult {
  /** Rows whose data key is now wrapped under the current key version. */
  readonly rewrapped: number;
  /** Rows that were already on the current version. */
  readonly alreadyCurrent: number;
  /** Rows changed by someone else while the rotation ran; they are on the current version already. */
  readonly skipped: number;
  readonly failed: readonly RotateFailure[];
  /** The key versions the rewrapped rows came from. */
  readonly fromVersions: readonly number[];
  readonly toVersion: number;
}

export interface RotateOptions {
  readonly batchSize?: number;
  /** Called after each row that was changed, so a caller can report progress even if a later row throws. */
  readonly onRow?: () => void;
}

export interface ResealResult {
  /** Rows now sealed under a new data key. */
  readonly resealed: number;
  /** Rows changed by someone else while this ran; they are already on the current version. */
  readonly skipped: number;
  readonly failed: readonly RotateFailure[];
  readonly toVersion: number;
}

export interface CredentialStore {
  /** Status of every integration, or of one. Never decrypts. */
  status(integration?: IntegrationKey, executor?: CredentialExecutor): Promise<IntegrationStatus[]>;
  /** Encrypts and saves the given fields (others are untouched). Returns the field names written. */
  put(
    integration: IntegrationKey,
    values: Readonly<Record<string, string>>,
    actorId: string | null,
    executor?: CredentialExecutor,
  ): Promise<string[]>;
  /** Deletes one stored field. False when there was none. */
  remove(
    integration: IntegrationKey,
    field: string,
    executor?: CredentialExecutor,
  ): Promise<boolean>;
  /** The values in effect for an integration: environment first, then `supplied`, then the database. */
  resolve(
    integration: IntegrationKey,
    options?: ResolveOptions,
  ): Promise<Record<string, ResolvedField>>;
  /** Re-wraps every data key that is not under the current key version. Idempotent. */
  rotate(options?: RotateOptions): Promise<RotateResult>;
  /**
   * Re-seals every value under a brand-new data key (and wraps it under the current key version).
   * Stronger than `rotate`, which only re-wraps the data keys; still does not help against a leaked
   * plaintext (the credential must then be rotated at the provider). Idempotent.
   */
  reseal(options?: RotateOptions): Promise<ResealResult>;
  /** How many rows use each key version. */
  versionCounts(): Promise<{ keyVersion: number; rows: number }[]>;
  readonly currentKeyVersion: number;
}

/**
 * The integration credential store (ADR-004, ADR-012). Adapters read through `resolve`; the admin
 * API writes through `put`/`remove`; `rotate` is run by the CLI. Environment wins over the database
 * for every field.
 */
export function createCredentialStore(options: CredentialStoreOptions): CredentialStore {
  const { kms } = options;
  const readFileText = options.readFile ?? ((path: string) => readFile(path, 'utf8'));
  const dbOf = (executor?: CredentialExecutor): CredentialExecutor =>
    executor ?? options.database.db;

  const envValue = (name: string): string | undefined => {
    const value = options.env[name];
    return value === undefined || value.trim() === '' ? undefined : value;
  };

  function definitionOf(integration: string, field: string) {
    // Own properties only: `toString` or `__proto__` must not pass for a field name. The message
    // does not repeat what the caller sent.
    if (!isIntegrationKey(integration)) {
      throw new CredentialStoreError('unknown_field', 'unknown integration or field');
    }
    const fields = integrationFields(integration);
    const definition = Object.hasOwn(fields, field) ? fields[field] : undefined;
    if (definition === undefined) {
      throw new CredentialStoreError('unknown_field', 'unknown integration or field');
    }
    return definition;
  }

  async function readEnvField(name: string, kind: 'value' | 'file'): Promise<string> {
    const raw = envValue(name);
    if (raw === undefined) throw new CredentialStoreError('unknown_field', `${name} is not set`);
    if (kind === 'value') return raw;
    try {
      return await readFileText(raw);
    } catch {
      // The path may be sensitive and the reason adds nothing: name the variable only.
      throw new CredentialStoreError(
        'env_file_unreadable',
        `${name} names a file that cannot be read`,
      );
    }
  }

  async function rowsOf(executor: CredentialExecutor, integration?: IntegrationKey) {
    return executor
      .select({
        integration: integrationCredential.integration,
        field: integrationCredential.field,
        valueSealed: integrationCredential.valueSealed,
        dekWrapped: integrationCredential.dekWrapped,
        keyVersion: integrationCredential.keyVersion,
        updatedAt: integrationCredential.updatedAt,
        updatedBy: integrationCredential.updatedBy,
        updatedByName: users.name,
      })
      .from(integrationCredential)
      .leftJoin(users, eq(users.id, integrationCredential.updatedBy))
      .where(
        integration === undefined ? undefined : eq(integrationCredential.integration, integration),
      )
      .orderBy(asc(integrationCredential.integration), asc(integrationCredential.field));
  }

  return {
    currentKeyVersion: kms.currentKeyVersion,

    async status(integration, executor) {
      const rows = await rowsOf(dbOf(executor), integration);
      const keys = integration === undefined ? Object.keys(INTEGRATION_CATALOG) : [integration];
      const result: IntegrationStatus[] = [];
      for (const key of keys) {
        if (!isIntegrationKey(key)) continue;
        const fields: CredentialFieldStatus[] = Object.entries(integrationFields(key)).map(
          ([field, definition]) => {
            const stored = rows.find((row) => row.integration === key && row.field === field);
            const fromEnv = envValue(definition.env) !== undefined;
            const source: CredentialSource = fromEnv ? 'env' : stored === undefined ? 'none' : 'db';
            return {
              field,
              label: definition.label,
              secret: definition.secret,
              required: definition.required,
              configured: source !== 'none',
              source,
              envVar: definition.env,
              updatedAt: source === 'db' && stored ? stored.updatedAt.toISOString() : null,
              updatedBy:
                source === 'db' && stored?.updatedBy !== undefined && stored.updatedBy !== null
                  ? { id: stored.updatedBy, name: stored.updatedByName ?? '' }
                  : null,
            };
          },
        );
        const configured = fields.filter((entry) => entry.configured);
        const complete = isIntegrationComplete(key, (name) =>
          fields.some((entry) => entry.field === name && entry.configured),
        );
        result.push({
          key,
          name: INTEGRATION_CATALOG[key].name,
          status: complete ? 'configured' : configured.length > 0 ? 'partial' : 'not_configured',
          fields,
        });
      }
      return result;
    },

    async put(integration, values, actorId, executor) {
      const names = Object.keys(values);
      // Check everything before sealing or writing anything.
      for (const name of names) {
        const definition = definitionOf(integration, name);
        if (envValue(definition.env) !== undefined) {
          throw new CredentialStoreError(
            'env_locked',
            `${integration}.${name} is set by the environment variable ${definition.env}`,
          );
        }
      }
      const sealed = await Promise.all(
        names.map(async (name) => ({
          name,
          box: await sealCredential(kms, credentialContext(integration, name), values[name] ?? ''),
        })),
      );
      const target = dbOf(executor);
      for (const { name, box } of sealed) {
        await target
          .insert(integrationCredential)
          .values({
            integration,
            field: name,
            valueSealed: box.valueSealed,
            dekWrapped: box.dekWrapped,
            keyVersion: box.keyVersion,
            createdBy: actorId,
            updatedBy: actorId,
          })
          .onConflictDoUpdate({
            target: [integrationCredential.integration, integrationCredential.field],
            set: {
              valueSealed: box.valueSealed,
              dekWrapped: box.dekWrapped,
              keyVersion: box.keyVersion,
              updatedAt: sql`now()`,
              updatedBy: actorId,
            },
          });
      }
      return names;
    },

    async remove(integration, field, executor) {
      definitionOf(integration, field);
      const removed = await dbOf(executor)
        .delete(integrationCredential)
        .where(
          and(
            eq(integrationCredential.integration, integration),
            eq(integrationCredential.field, field),
          ),
        )
        .returning({ id: integrationCredential.id });
      return removed.length > 0;
    },

    async resolve(integration, resolveOptions = {}) {
      const rows = await rowsOf(dbOf(resolveOptions.executor), integration);
      const resolved: Record<string, ResolvedField> = {};
      for (const [field, definition] of Object.entries(integrationFields(integration))) {
        if (envValue(definition.env) !== undefined) {
          resolved[field] = {
            value: await readEnvField(definition.env, definition.envKind),
            source: 'env',
          };
          continue;
        }
        const supplied = resolveOptions.supplied?.[field];
        if (supplied !== undefined) {
          resolved[field] = { value: supplied, source: 'db' };
          continue;
        }
        const stored = rows.find((row) => row.field === field);
        if (stored === undefined) continue;
        try {
          resolved[field] = {
            value: await openCredential(kms, credentialContext(integration, field), stored),
            source: 'db',
          };
        } catch {
          throw new CredentialStoreError(
            'cannot_open',
            `the stored value of ${integration}.${field} cannot be opened (wrong key or changed)`,
          );
        }
      }
      return resolved;
    },

    async rotate(rotateOptions = {}) {
      const batchSize = rotateOptions.batchSize ?? 100;
      const db = options.database.db;
      const current = kms.currentKeyVersion;
      const failed: RotateFailure[] = [];
      const fromVersions = new Set<number>();
      let rewrapped = 0;
      let skipped = 0;
      const [alreadyOnCurrent] = await db
        .select({ rows: sql<number>`count(*)::int` })
        .from(integrationCredential)
        .where(eq(integrationCredential.keyVersion, current));
      // Rows that failed (or were changed by someone else) can stay at their old version, so each
      // pass looks past the ones already dealt with, and the loop always makes progress.
      const settled = new Set<string>();

      for (;;) {
        const batch = (
          await db
            .select({
              id: integrationCredential.id,
              integration: integrationCredential.integration,
              field: integrationCredential.field,
              dekWrapped: integrationCredential.dekWrapped,
              keyVersion: integrationCredential.keyVersion,
            })
            .from(integrationCredential)
            .where(ne(integrationCredential.keyVersion, current))
            .orderBy(asc(integrationCredential.id))
            .limit(batchSize + settled.size)
        ).filter((row) => !settled.has(row.id));
        if (batch.length === 0) break;

        for (const row of batch.slice(0, batchSize)) {
          if (!kms.canUnwrap(row.keyVersion)) {
            settled.add(row.id);
            failed.push({ integration: row.integration, field: row.field, reason: 'no_key' });
            continue;
          }
          let next;
          try {
            next = await rewrapCredential(kms, credentialContext(row.integration, row.field), row);
          } catch {
            settled.add(row.id);
            failed.push({ integration: row.integration, field: row.field, reason: 'cannot_open' });
            continue;
          }
          // Only if nobody rewrote the row meanwhile: a fresh write is already on the current version.
          const updated = await db
            .update(integrationCredential)
            .set({ dekWrapped: next.dekWrapped, keyVersion: next.keyVersion })
            .where(
              and(
                eq(integrationCredential.id, row.id),
                eq(integrationCredential.keyVersion, row.keyVersion),
                eq(integrationCredential.dekWrapped, row.dekWrapped),
              ),
            )
            .returning({ id: integrationCredential.id });
          if (updated.length === 0) {
            settled.add(row.id);
            skipped += 1;
          } else {
            rewrapped += 1;
            rotateOptions.onRow?.();
            fromVersions.add(row.keyVersion);
          }
        }
      }

      return {
        rewrapped,
        alreadyCurrent: alreadyOnCurrent?.rows ?? 0,
        skipped,
        failed,
        fromVersions: [...fromVersions].sort((a, b) => a - b),
        toVersion: current,
      };
    },

    async reseal(resealOptions = {}) {
      const batchSize = resealOptions.batchSize ?? 100;
      const db = options.database.db;
      const failed: RotateFailure[] = [];
      let resealed = 0;
      let skipped = 0;
      // Keyset by id: a row that failed stays as it is, and the walk moves past it.
      let after: string | undefined;
      for (;;) {
        const batch = await db
          .select()
          .from(integrationCredential)
          .where(after === undefined ? undefined : gt(integrationCredential.id, after))
          .orderBy(asc(integrationCredential.id))
          .limit(batchSize);
        if (batch.length === 0) break;
        for (const row of batch) {
          after = row.id;
          const failure = { integration: row.integration, field: row.field };
          if (!kms.canUnwrap(row.keyVersion)) {
            failed.push({ ...failure, reason: 'no_key' });
            continue;
          }
          const context = credentialContext(row.integration, row.field);
          let next;
          try {
            next = await sealCredential(kms, context, await openCredential(kms, context, row));
          } catch {
            failed.push({ ...failure, reason: 'cannot_open' });
            continue;
          }
          const updated = await db
            .update(integrationCredential)
            .set({
              valueSealed: next.valueSealed,
              dekWrapped: next.dekWrapped,
              keyVersion: next.keyVersion,
            })
            .where(
              and(
                eq(integrationCredential.id, row.id),
                eq(integrationCredential.valueSealed, row.valueSealed),
                eq(integrationCredential.dekWrapped, row.dekWrapped),
              ),
            )
            .returning({ id: integrationCredential.id });
          if (updated.length === 0) {
            skipped += 1;
          } else {
            resealed += 1;
            resealOptions.onRow?.();
          }
        }
      }
      return { resealed, skipped, failed, toVersion: kms.currentKeyVersion };
    },

    async versionCounts() {
      const rows = await options.database.db
        .select({
          keyVersion: integrationCredential.keyVersion,
          rows: sql<number>`count(*)::int`,
        })
        .from(integrationCredential)
        .groupBy(integrationCredential.keyVersion)
        .orderBy(asc(integrationCredential.keyVersion));
      return rows;
    },
  };
}
