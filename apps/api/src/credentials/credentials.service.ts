import { Inject, Injectable } from '@nestjs/common';
import { CredentialStoreError, type CredentialStore } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  integrationFields,
  type IntegrationKey,
  type IntegrationList,
  type IntegrationStatus,
  type PutCredentials,
  type TestConnection,
  type TestConnectionResult,
  type TestMode,
} from '@watchtower/shared';

import { AuditScope } from '../audit/audit-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { badRequest, credentialEnvLocked, notFound } from '../auth/http-errors.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { ConnectionTesterRegistry, type TestOutcome } from './connection-tester.js';

/** DI token of the credential store (`createCredentialStore` from @watchtower/db). */
export const CREDENTIAL_STORE = Symbol('CREDENTIAL_STORE');

/** "Test connection" calls allowed per person per minute. `[ASSUMED]` */
const TEST_RATE_LIMIT = 10;
const TEST_RATE_WINDOW_SECONDS = 60;

/** Drops the keys a schema left undefined (a partial record) so the store gets plain strings. */
function definedFields(
  fields: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/** How long a live check may run. */
const LIVE_TEST_TIMEOUT_MS = 10_000;

/** What an HTTP caller learns from a store error: its message names fields and variables, never values. */
function translate(error: unknown): never {
  if (error instanceof CredentialStoreError) {
    if (error.code === 'unknown_field') throw badRequest('Unknown integration or field');
    if (error.code === 'env_locked') throw credentialEnvLocked(error.message);
  }
  throw error;
}

/**
 * The admin side of the credential store (T-116a, ADR-012). Secrets go in and never come back:
 * every method returns statuses, not values. The audit rows carry field names only.
 */
@Injectable()
export class CredentialsService {
  constructor(
    @Inject(CREDENTIAL_STORE) private readonly store: CredentialStore,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ConnectionTesterRegistry) private readonly testers: ConnectionTesterRegistry,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  private get testMode(): TestMode {
    return this.config.CREDENTIAL_LIVE_TEST_ENABLED ? 'live' : 'mock';
  }

  async list(): Promise<IntegrationList> {
    return { testMode: this.testMode, items: await this.store.status() };
  }

  private async statusOf(integration: IntegrationKey): Promise<IntegrationStatus> {
    const [status] = await this.store.status(integration);
    if (status === undefined) throw notFound('No such integration');
    return status;
  }

  async put(
    integration: IntegrationKey,
    body: PutCredentials,
    actorId: string,
  ): Promise<IntegrationStatus> {
    try {
      await this.uow.run(async ({ tx }) => {
        const written = await this.store.put(integration, definedFields(body.fields), actorId, tx);
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'user', id: actorId },
          action: AUDIT_ACTIONS.integrationCredentialSet,
          targetType: 'integration',
          targetId: integration,
          // Field names only: never a value, a hash or a length.
          metadata: { fields: written.sort() },
        });
      });
    } catch (error) {
      translate(error);
    }
    return this.statusOf(integration);
  }

  async remove(integration: IntegrationKey, field: string, actorId: string): Promise<void> {
    try {
      await this.uow.run(async ({ tx }) => {
        const removed = await this.store.remove(integration, field, tx);
        if (!removed) throw notFound('No stored value for that field');
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'user', id: actorId },
          action: AUDIT_ACTIONS.integrationCredentialDelete,
          targetType: 'integration',
          targetId: integration,
          metadata: { fields: [field] },
        });
      });
    } catch (error) {
      translate(error);
    }
  }

  /**
   * Runs the integration's check on the values in effect (environment, then the unsaved ones in
   * the request, then the saved ones). A failed check is an answer (`ok: false`), not an HTTP error.
   */
  async test(
    integration: IntegrationKey,
    body: TestConnection,
    actorId: string,
  ): Promise<TestConnectionResult> {
    const supplied = definedFields(body.fields ?? {});
    const known = integrationFields(integration);
    for (const name of Object.keys(supplied)) {
      if (!Object.hasOwn(known, name)) throw badRequest('Unknown integration or field');
    }
    // After validation, so a malformed request does not use up the allowance. A live check can cost
    // money and reaches another service (ADR-012 §6), so this is metered per person.
    await this.limiter.enforce(
      'credential-test',
      actorId,
      TEST_RATE_LIMIT,
      TEST_RATE_WINDOW_SECONDS,
    );
    const mode = this.testMode;
    const outcome = await this.run(integration, supplied, mode);
    AuditScope.set({
      targetType: 'integration',
      targetId: integration,
      metadata: { ok: outcome.ok, mode, suppliedFields: Object.keys(supplied).sort() },
    });
    return {
      ok: outcome.ok,
      mode,
      identity: outcome.identity,
      message: outcome.message,
      checkedAt: new Date().toISOString(),
    };
  }

  private async run(
    integration: IntegrationKey,
    supplied: Readonly<Record<string, string>>,
    mode: TestMode,
  ): Promise<TestOutcome> {
    let config: Record<string, string>;
    try {
      const resolved = await this.store.resolve(integration, { supplied });
      config = Object.fromEntries(
        Object.entries(resolved).map(([name, entry]) => [name, entry.value]),
      );
    } catch (error) {
      if (error instanceof CredentialStoreError && error.code === 'cannot_open') {
        return {
          ok: false,
          identity: null,
          message:
            'A saved value cannot be opened with the current encryption key. Enter it again.',
        };
      }
      if (error instanceof CredentialStoreError && error.code === 'env_file_unreadable') {
        return { ok: false, identity: null, message: error.message };
      }
      throw error;
    }

    const tester = this.testers.get(integration);
    if (mode === 'mock') return tester.fake(config);
    if (tester.live === undefined) {
      return {
        ok: false,
        identity: null,
        message: 'There is no live check for this integration yet.',
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, LIVE_TEST_TIMEOUT_MS);
    try {
      return await tester.live(config, controller.signal);
    } catch {
      // The reason may quote what the service said, which may quote the request. Say nothing of it.
      return { ok: false, identity: null, message: 'The check could not be completed.' };
    } finally {
      clearTimeout(timer);
    }
  }
}
