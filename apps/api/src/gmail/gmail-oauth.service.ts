import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ChannelError, gmail, type FetchLike } from '@watchtower/channels';
import {
  CredentialStoreError,
  enqueueOutbox,
  schema,
  type CredentialStore,
  type Database,
} from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  GMAIL_JOBS,
  GMAIL_NOT_CONNECTED_CODE,
  GMAIL_QUEUES,
  GMAIL_SYNC_OUTBOX_JOB_OPTIONS,
  chooseGmailMethod,
  type GmailConnectionStatus,
  type GmailOauthResult,
  type GmailOauthStart,
  type GmailOauthStartResult,
  type GmailSyncJob,
} from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { AuditScope } from '../audit/audit-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { conflict, credentialEnvLocked } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { CREDENTIAL_STORE } from '../credentials/credentials.service.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { REDIS } from '../redis/redis.module.js';

/** Replaces the global `fetch` for the calls to Google. Tests inject a script; production leaves it alone. */
export const GMAIL_OAUTH_FETCH = Symbol('GMAIL_OAUTH_FETCH');

/** How long a person has to finish at Google. */
const STATE_TTL_SECONDS = 600;
const START_RATE = { limit: 10, windowSeconds: 60 } as const;
const CALLBACK_RATE = { limit: 20, windowSeconds: 60 } as const;

/** What is remembered between `start` and the callback. Held in Redis for ten minutes, deleted on first use. */
interface PendingGrant {
  readonly userId: string;
  readonly sessionId: string;
  readonly verifier: string;
  readonly mailbox: string;
}

function isPendingGrant(value: unknown): value is PendingGrant {
  return (
    typeof value === 'object' &&
    value !== null &&
    'userId' in value &&
    typeof value.userId === 'string' &&
    'sessionId' in value &&
    typeof value.sessionId === 'string' &&
    'verifier' in value &&
    typeof value.verifier === 'string' &&
    'mailbox' in value &&
    typeof value.mailbox === 'string'
  );
}

export interface OauthCallbackInput {
  readonly code: string | undefined;
  readonly state: string | undefined;
  /** Google's `error` parameter (for example `access_denied`). Its value is never used or logged. */
  readonly error: string | undefined;
}

/**
 * OAuth of the single support mailbox (T-102e, PRD R-2.4): the web server flow for a `head`
 * (`integration.manage`). Authorization code + PKCE (S256), a random `state`, `access_type=offline`
 * and `prompt=consent` so Google issues a refresh token, and exactly the scopes `gmail.readonly`
 * + `gmail.send`.
 *
 * What makes the callback trustworthy:
 *  - `state` is looked up in Redis by its hash and deleted in the same step (`GETDEL`): a second use,
 *    an expired or an invented one is `state_invalid`. The record holds the signed-in user, the SESSION
 *    id and the PKCE verifier, so a callback from another session (or another person) is refused even
 *    with a valid state; the verifier never goes to the browser.
 *  - the granted scopes must be exactly the two asked for; a narrower or wider grant is refused;
 *  - the address that granted (`users.getProfile`) must be the mailbox asked for at `start`;
 *  - a grant that is refused after Google issued a token is revoked, best effort.
 * Only then is the refresh token written, encrypted, to the credential store (`oauthRefreshToken`,
 * `oauthMailbox`), in one transaction with its audit entry. It is never returned, logged or put in
 * an audit entry.
 */
@Injectable()
export class GmailOauthService {
  private readonly send: FetchLike;

  constructor(
    @Inject(CREDENTIAL_STORE) private readonly store: CredentialStore,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(GMAIL_OAUTH_FETCH) override: FetchLike | null,
  ) {
    this.send = override ?? ((url, init) => fetch(url, init));
  }

  get redirectUri(): string {
    return new URL('/v1/admin/integrations/gmail/oauth/callback', this.config.API_URL).toString();
  }

  /** Where the browser is sent when the callback is done. The query carries a result code only. */
  resultUrl(result: GmailOauthResult): string {
    const url = new URL('/admin/integrations', this.config.APP_URL);
    url.searchParams.set('gmail_oauth', result);
    return url.toString();
  }

  private stateKey(state: string): string {
    const digest = createHash('sha256').update(state).digest('hex');
    return `${this.config.RATE_LIMIT_NAMESPACE}:gmail-oauth:${digest}`;
  }

  /** The client credentials and whether the database may hold the grant (no environment variable sets it). */
  private async clientAndLocks(): Promise<{
    readonly client: { readonly clientId: string; readonly clientSecret: string } | null;
    readonly envLocked: boolean;
  }> {
    const [status] = await this.store.status('gmail');
    const source = (name: string) => status?.fields.find((entry) => entry.field === name)?.source;
    const envLocked = source('oauthRefreshToken') === 'env' || source('oauthMailbox') === 'env';
    if (source('oauthClientId') === 'none' || source('oauthClientSecret') === 'none') {
      return { client: null, envLocked };
    }
    const fields = await this.store.resolve('gmail');
    const clientId = fields.oauthClientId?.value;
    const clientSecret = fields.oauthClientSecret?.value;
    return {
      client:
        clientId === undefined || clientSecret === undefined ? null : { clientId, clientSecret },
      envLocked,
    };
  }

  async start(principal: Principal, input: GmailOauthStart): Promise<GmailOauthStartResult> {
    await this.limiter.enforce(
      'gmail-oauth-start',
      principal.userId,
      START_RATE.limit,
      START_RATE.windowSeconds,
    );
    const { client, envLocked } = await this.clientAndLocks();
    if (envLocked) {
      throw credentialEnvLocked(
        'The refresh token or the mailbox is set by an environment variable; it cannot be replaced here',
      );
    }
    if (client === null) {
      throw conflict('Save the OAuth client ID and client secret of the Gmail integration first');
    }
    const pkce = gmail.createPkcePair();
    const state = gmail.createOAuthState();
    const pending: PendingGrant = {
      userId: principal.userId,
      sessionId: principal.sessionId,
      verifier: pkce.verifier,
      mailbox: input.mailbox,
    };
    await this.redis.set(this.stateKey(state), JSON.stringify(pending), 'EX', STATE_TTL_SECONDS);
    AuditScope.set({ targetType: 'integration', targetId: 'gmail', metadata: {} });
    return {
      authorizationUrl: gmail.buildAuthorizationUrl({
        clientId: client.clientId,
        redirectUri: this.redirectUri,
        state,
        codeChallenge: pkce.challenge,
        // A hint only; the address that actually granted is checked against the profile.
        loginHint: input.mailbox,
      }),
      expiresAt: new Date(Date.now() + STATE_TTL_SECONDS * 1000).toISOString(),
      redirectUri: this.redirectUri,
    };
  }

  /** Finishes the flow. Always returns a result code (the controller redirects with it); never a token. */
  async finish(principal: Principal, input: OauthCallbackInput): Promise<GmailOauthResult> {
    const result = await this.complete(principal, input);
    if (result !== 'connected') {
      // A refused callback is on the log with its reason code and nothing else. A successful one was
      // written in the transaction that saved the token.
      AuditScope.set({
        action: AUDIT_ACTIONS.gmailOauthConnect,
        outcome: 'failure',
        targetType: 'integration',
        targetId: 'gmail',
        metadata: { reason: result },
      });
    }
    return result;
  }

  private async complete(
    principal: Principal,
    input: OauthCallbackInput,
  ): Promise<GmailOauthResult> {
    await this.limiter.enforce(
      'gmail-oauth-callback',
      principal.userId,
      CALLBACK_RATE.limit,
      CALLBACK_RATE.windowSeconds,
    );
    if (input.state === undefined || input.state === '') return 'state_invalid';
    // Atomic read-and-delete: the state works once.
    const raw = await this.redis.getdel(this.stateKey(input.state));
    if (raw === null) return 'state_invalid';
    let pending: unknown;
    try {
      pending = JSON.parse(raw);
    } catch {
      return 'state_invalid';
    }
    if (!isPendingGrant(pending)) return 'state_invalid';
    // Bound to the person AND the session that started it.
    if (pending.userId !== principal.userId || pending.sessionId !== principal.sessionId) {
      return 'state_invalid';
    }
    if (input.error !== undefined) return 'denied';
    if (input.code === undefined || input.code === '') return 'denied';

    const { client, envLocked } = await this.clientAndLocks();
    if (envLocked) return 'env_locked';
    if (client === null) return 'unavailable';

    let grant: gmail.TokenGrant;
    try {
      grant = await gmail.exchangeAuthorizationCode({
        ...client,
        fetch: this.send,
        code: input.code,
        codeVerifier: pending.verifier,
        redirectUri: this.redirectUri,
      });
    } catch (error) {
      this.logFailure('gmail oauth: code exchange failed', error);
      return error instanceof ChannelError && error.kind === 'auth' ? 'denied' : 'unavailable';
    }
    // From here on a token exists. Whatever is refused is revoked.
    const undo = async (): Promise<void> => {
      await gmail.revokeToken({ fetch: this.send, token: grant.refreshToken ?? grant.accessToken });
    };

    if (!gmail.grantedScopesAreExact(grant.scopes)) {
      await undo();
      return 'scope_mismatch';
    }
    if (grant.refreshToken === undefined) {
      await undo();
      return 'no_refresh_token';
    }
    let granted: string;
    try {
      granted = await gmail.fetchGrantedMailbox({
        fetch: this.send,
        accessToken: grant.accessToken,
      });
    } catch (error) {
      this.logFailure('gmail oauth: profile lookup failed', error);
      await undo();
      return 'unavailable';
    }
    if (granted !== pending.mailbox) {
      await undo();
      return 'mailbox_mismatch';
    }
    try {
      await this.save(principal, granted, grant.refreshToken);
    } catch (error) {
      await undo();
      if (error instanceof CredentialStoreError && error.code === 'env_locked') return 'env_locked';
      throw error;
    }
    return 'connected';
  }

  /** The error's kind and code only: never its message chain, which could quote a request. */
  private logFailure(message: string, error: unknown): void {
    this.logger.warn(
      error instanceof ChannelError
        ? { operation: error.operation, kind: error.kind, code: error.code, status: error.status }
        : {},
      message,
    );
  }

  /**
   * One transaction: the encrypted refresh token and mailbox, the mailbox row (created if this is the
   * first connection, cleared of `not_connected` if it is a reconnection), a catch-up sync job, and
   * the audit entry (field names only).
   */
  private async save(principal: Principal, mailbox: string, refreshToken: string): Promise<void> {
    await this.uow.run(async ({ tx }) => {
      const written = await this.store.put(
        'gmail',
        { oauthRefreshToken: refreshToken, oauthMailbox: mailbox },
        principal.userId,
        tx,
      );
      // Two callbacks for a new mailbox at once must not both insert it.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('gmail-oauth-mailbox'))`);
      const [existing] = await tx
        .select({ id: schema.gmailAccountState.channelAccountId })
        .from(schema.gmailAccountState)
        .where(eq(schema.gmailAccountState.emailAddress, mailbox))
        .limit(1);
      let accountId = existing?.id;
      if (accountId === undefined) {
        const [account] = await tx
          .insert(schema.channelAccount)
          .values({ type: 'gmail', name: mailbox })
          .returning({ id: schema.channelAccount.id });
        if (account === undefined) throw new Error('channel account was not created');
        accountId = account.id;
        await tx
          .insert(schema.gmailAccountState)
          .values({ channelAccountId: accountId, emailAddress: mailbox });
      } else {
        await tx
          .update(schema.gmailAccountState)
          .set({ lastErrorCode: null, updatedAt: new Date() })
          .where(
            sql`${schema.gmailAccountState.channelAccountId} = ${accountId} AND ${schema.gmailAccountState.lastErrorCode} = ${GMAIL_NOT_CONNECTED_CODE}`,
          );
      }
      const job: GmailSyncJob = { channelAccountId: accountId, reason: 'manual' };
      await enqueueOutbox(tx, {
        queue: GMAIL_QUEUES.gmail,
        jobName: GMAIL_JOBS.sync,
        jobId: `manual-${accountId}-${String(Date.now())}`,
        payload: job,
        options: { ...GMAIL_SYNC_OUTBOX_JOB_OPTIONS },
      });
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: principal.userId },
        action: AUDIT_ACTIONS.gmailOauthConnect,
        targetType: 'integration',
        targetId: 'gmail',
        // Field names and the account id: no address, no token.
        metadata: { fields: written.sort(), channelAccountId: accountId },
      });
    });
  }

  async status(): Promise<GmailConnectionStatus> {
    const [status] = await this.store.status('gmail');
    const fields = status?.fields ?? [];
    const configured = (name: string): boolean =>
      fields.find((entry) => entry.field === name)?.configured === true;
    const oauthConnected = configured('oauthRefreshToken') && configured('oauthMailbox');
    let oauthMailbox: string | null = null;
    if (oauthConnected) {
      // The mailbox address is an identity, not a secret; the refresh token is decrypted by this call
      // as well but never leaves it.
      try {
        const resolved = await this.store.resolve('gmail');
        oauthMailbox = resolved.oauthMailbox?.value ?? null;
      } catch {
        // A value that cannot be opened (rotated key) or a file that cannot be read: show no address.
        oauthMailbox = null;
      }
    }
    const [broken] = await this.database.db
      .select({ id: schema.gmailAccountState.channelAccountId })
      .from(schema.gmailAccountState)
      .where(eq(schema.gmailAccountState.lastErrorCode, GMAIL_NOT_CONNECTED_CODE))
      .limit(1);
    return {
      oauthClientConfigured: configured('oauthClientId') && configured('oauthClientSecret'),
      oauthConnected,
      oauthMailbox,
      serviceAccountConfigured: configured('serviceAccountJson') && configured('impersonateUser'),
      effectiveMethod: chooseGmailMethod(fields),
      needsReconnect: broken !== undefined,
      redirectUri: this.redirectUri,
    };
  }
}
