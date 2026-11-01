import { Inject, Injectable } from '@nestjs/common';
import type { CredentialStore, Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  type ChannelAccount,
  type ChannelAccountList,
  type CreateChannelAccount,
  type IntegrationStatus,
  type ManagedChannelType,
} from '@watchtower/shared';

import { AuditService } from '../audit/audit.service.js';
import { badRequest, conflict, notFound } from '../auth/http-errors.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { CREDENTIAL_STORE } from '../credentials/credentials.service.js';
import { DATABASE } from '../database/database.module.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import {
  ChannelAccountError,
  createChannelAccount,
  disableAccount,
  listAccounts,
  toView,
} from './channel-accounts.core.js';

function translate(error: unknown): never {
  if (error instanceof ChannelAccountError) {
    if (error.code === 'not_found') throw notFound(error.message);
    if (error.code === 'not_managed') throw badRequest(error.message);
    throw conflict(error.message);
  }
  throw error;
}

/**
 * Registers LINE Official Accounts and Gmail mailboxes (T-131). Credentials stay in the credential
 * store (ADR-012); this is the row they connect to, and the URL to paste into the LINE console.
 * Audit rows carry the type and the id, never a mailbox address.
 */
@Injectable()
export class ChannelAccountsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CREDENTIAL_STORE) private readonly store: CredentialStore,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async credentialStatus(): Promise<ReadonlyMap<ManagedChannelType, IntegrationStatus>> {
    const map = new Map<ManagedChannelType, IntegrationStatus>();
    for (const type of ['line', 'gmail'] as const) {
      const [status] = await this.store.status(type);
      if (status !== undefined) map.set(type, status);
    }
    return map;
  }

  async list(): Promise<ChannelAccountList> {
    const [rows, status] = await Promise.all([
      listAccounts(this.database.db),
      this.credentialStatus(),
    ]);
    return { items: rows.map((row) => toView(row, this.config.API_URL, status)) };
  }

  async create(input: CreateChannelAccount, actorId: string): Promise<ChannelAccount> {
    let row;
    try {
      row = await this.uow.run(async ({ tx }) => {
        const created = await createChannelAccount(tx, input);
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'user', id: actorId },
          action: AUDIT_ACTIONS.channelAccountCreate,
          targetType: 'channel_account',
          targetId: created.id,
          metadata: { type: created.type },
        });
        return created;
      });
    } catch (error) {
      translate(error);
    }
    return toView(row, this.config.API_URL, await this.credentialStatus());
  }

  async disable(id: string, actorId: string): Promise<ChannelAccount> {
    let result;
    try {
      result = await this.uow.run(async ({ tx }) => {
        const outcome = await disableAccount(tx, id, new Date());
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'user', id: actorId },
          action: AUDIT_ACTIONS.channelAccountDisable,
          targetType: 'channel_account',
          targetId: id,
          metadata: { type: outcome.account.type, changed: outcome.changed },
        });
        return outcome;
      });
    } catch (error) {
      translate(error);
    }
    return toView(result.account, this.config.API_URL, await this.credentialStatus());
  }
}
