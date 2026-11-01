import { ChannelError } from '@watchtower/channels';
import { schema, type Database } from '@watchtower/db';
import { recordAuditInTx, type Domain } from '@watchtower/domain';
import { AUDIT_ACTIONS, GMAIL_NOT_CONNECTED_CODE } from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';

/**
 * Google refused the mailbox's OAuth refresh token (`invalid_grant`, T-102e): the grant was revoked,
 * expired (a consent screen in "Testing" lasts 7 days), or invalidated by a password change. Nothing
 * a retry can fix; a head has to connect the mailbox again. This is what makes that visible:
 * `channel_account.health = 'unhealthy'`, `gmail_account_state.last_error_code = 'not_connected'` and
 * ONE audit entry per outage (not one per retry).
 */

const SYSTEM_ACTOR = { type: 'system', id: null } as const;

/** The failure of `oauth2.token` that means "connect this mailbox again". */
export function isInvalidGrant(error: unknown): boolean {
  return (
    error instanceof ChannelError &&
    error.operation === 'oauth2.token' &&
    error.kind === 'auth' &&
    error.code === 'invalid_grant'
  );
}

export interface NotConnectedDeps {
  readonly database: Database;
  readonly domain: Domain;
  readonly logger: WorkerLogger;
  readonly now?: () => Date;
}

export function createMarkNotConnected(
  deps: NotConnectedDeps,
): (accountId: string) => Promise<void> {
  const now = deps.now ?? ((): Date => new Date());
  return async (accountId) => {
    const ctx = deps.domain.context({ actor: SYSTEM_ACTOR });
    await deps.database.db.transaction(async (tx) => {
      const [state] = await tx
        .select({ lastErrorCode: schema.gmailAccountState.lastErrorCode })
        .from(schema.gmailAccountState)
        .where(eq(schema.gmailAccountState.channelAccountId, accountId))
        .for('update')
        .limit(1);
      // No mailbox row, or already recorded for this outage: nothing to add.
      if (state === undefined || state.lastErrorCode === GMAIL_NOT_CONNECTED_CODE) return;
      await tx
        .update(schema.gmailAccountState)
        .set({ lastErrorCode: GMAIL_NOT_CONNECTED_CODE, updatedAt: now() })
        .where(eq(schema.gmailAccountState.channelAccountId, accountId));
      await tx
        .update(schema.channelAccount)
        .set({ health: 'unhealthy', updatedAt: now() })
        .where(eq(schema.channelAccount.id, accountId));
      await recordAuditInTx(
        tx,
        ctx,
        { audited: false },
        {
          action: AUDIT_ACTIONS.gmailNotConnected,
          outcome: 'failure',
          targetType: 'channel_account',
          targetId: accountId,
          // A code only: no address, no token.
          metadata: { code: 'invalid_grant' },
        },
      );
    });
    deps.logger.warn(
      { accountId },
      'gmail mailbox marked not connected; a head must connect it again',
    );
  };
}
