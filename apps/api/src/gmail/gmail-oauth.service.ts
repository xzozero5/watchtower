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
  GMAIL_OAUTH_GRANT_FIELDS,
  GMAIL_QUEUES,
  GMAIL_SYNC_OUTBOX_JOB_OPTIONS,
  INTEGRATION_CATALOG,
  chooseGmailMethod,
  type GmailConnectionStatus,
  type GmailOauthDisconnectResult,
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

/** What happened to a token Google issued for a connection that was refused. */
type RevokeOutcome = 'revoked' | 'failed' | 'skipped_working_grant';

/** The grant already stored, as far as a refused or replacing connection needs to know it. */
interface ExistingGrant {
  readonly refreshToken: string;
  readonly mailbox: string | undefined;
}

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

  /**
   * The client credentials, and what stands in the way of storing a grant: `envLocked` when an
   * environment variable sets the token or the mailbox, or when a way set entirely by the environment
   * (a service account) would be used instead of OAuth even after a successful connection.
   * `grant` is the grant already stored, if any (its token and mailbox are only read from the store).
   */
  private async clientAndLocks(): Promise<{
    readonly client: { readonly clientId: string; readonly clientSecret: string } | null;
    readonly envLocked: boolean;
    readonly grant: { readonly refreshToken: string; readonly mailbox: string | undefined } | null;
  }> {
    const [status] = await this.store.status('gmail');
    const fields = status?.fields ?? [];
    const source = (name: string) => fields.find((entry) => entry.field === name)?.source;
    // Would OAuth be the way in use if it were complete? (The client being saved is checked separately.)
    const oauthWays: readonly string[] = INTEGRATION_CATALOG.gmail.alternatives.oauth;
    const wouldBeEffective =
      chooseGmailMethod(
        fields.map((entry) =>
          oauthWays.includes(entry.field)
            ? {
                field: entry.field,
                configured: true,
                source: entry.source === 'env' ? 'env' : 'db',
              }
            : entry,
        ),
      ) === 'oauth';
    const envLocked =
      source('oauthRefreshToken') === 'env' ||
      source('oauthMailbox') === 'env' ||
      !wouldBeEffective;
    // Nothing below is read when the environment decides: the files it names need not even exist.
    if (envLocked) return { client: null, envLocked, grant: null };
    const stored = source('oauthRefreshToken') === 'db';
    const needClient = source('oauthClientId') !== 'none' && source('oauthClientSecret') !== 'none';
    if (!needClient && !stored) return { client: null, envLocked, grant: null };
    const resolved = await this.store.resolve('gmail');
    const clientId = resolved.oauthClientId?.value;
    const clientSecret = resolved.oauthClientSecret?.value;
    const refreshToken = resolved.oauthRefreshToken?.value;
    return {
      client:
        !needClient || clientId === undefined || clientSecret === undefined
          ? null
          : { clientId, clientSecret },
      envLocked,
      grant:
        stored && refreshToken !== undefined
          ? { refreshToken, mailbox: resolved.oauthMailbox?.value }
          : null,
    };
  }

  /**
   * Revokes a token Google just issued for a connection we refuse. Not when a working grant for this
   * client may be the same grant: whether Google ends the whole grant of an account when one of its
   * refresh tokens is revoked is `[UNVERIFIED 50%]`, so a rejected reconnect must not risk the one in
   * use. It is safe to revoke when the account that granted is known to be another one.
   */
  private async revokeIssued(
    grant: gmail.TokenGrant,
    existing: { readonly mailbox: string | undefined } | null,
    grantedBy?: string,
  ): Promise<RevokeOutcome> {
    if (existing !== null && (grantedBy === undefined || grantedBy === existing.mailbox)) {
      return 'skipped_working_grant';
    }
    const done = await gmail.revokeToken({
      fetch: this.send,
      token: grant.refreshToken ?? grant.accessToken,
    });
    return done ? 'revoked' : 'failed';
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
        'The refresh token or the mailbox is set by an environment variable, or a service account set by the environment is in use; OAuth cannot take over here',
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
    const { result, revoke } = await this.complete(principal, input);
    if (result !== 'connected') {
      // A refused callback is on the log with its reason code, and what happened to the grant Google
      // issued (revoked, failed to revoke, or kept because a working grant may share it). A successful
      // one was written in the transaction that saved the token.
      AuditScope.set({
        action: AUDIT_ACTIONS.gmailOauthConnect,
        outcome: 'failure',
        targetType: 'integration',
        targetId: 'gmail',
        metadata: { reason: result, ...(revoke === undefined ? {} : { revoke }) },
      });
    }
    return result;
  }

  private async complete(
    principal: Principal,
    input: OauthCallbackInput,
  ): Promise<{ readonly result: GmailOauthResult; readonly revoke?: RevokeOutcome }> {
    await this.limiter.enforce(
      'gmail-oauth-callback',
      principal.userId,
      CALLBACK_RATE.limit,
      CALLBACK_RATE.windowSeconds,
    );
    if (input.state === undefined || input.state === '') return { result: 'state_invalid' };
    // Atomic read-and-delete: the state works once.
    const raw = await this.redis.getdel(this.stateKey(input.state));
    if (raw === null) return { result: 'state_invalid' };
    let pending: unknown;
    try {
      pending = JSON.parse(raw);
    } catch {
      return { result: 'state_invalid' };
    }
    if (!isPendingGrant(pending)) return { result: 'state_invalid' };
    // Bound to the person AND the session that started it.
    if (pending.userId !== principal.userId || pending.sessionId !== principal.sessionId) {
      return { result: 'state_invalid' };
    }
    if (input.error !== undefined) return { result: 'denied' };
    if (input.code === undefined || input.code === '') return { result: 'denied' };

    const { client, envLocked, grant: existing } = await this.clientAndLocks();
    if (envLocked) return { result: 'env_locked' };
    if (client === null) return { result: 'unavailable' };

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
      return {
        result: error instanceof ChannelError && error.kind === 'auth' ? 'denied' : 'unavailable',
      };
    }
    // From here on a token exists. Whatever is refused is revoked, unless that could end a grant in use.
    if (!gmail.grantedScopesAreExact(grant.scopes)) {
      return { result: 'scope_mismatch', revoke: await this.revokeIssued(grant, existing) };
    }
    if (grant.refreshToken === undefined) {
      return { result: 'no_refresh_token', revoke: await this.revokeIssued(grant, existing) };
    }
    let granted: string;
    try {
      granted = await gmail.fetchGrantedMailbox({
        fetch: this.send,
        accessToken: grant.accessToken,
      });
    } catch (error) {
      this.logFailure('gmail oauth: profile lookup failed', error);
      return { result: 'unavailable', revoke: await this.revokeIssued(grant, existing) };
    }
    if (granted !== pending.mailbox) {
      return {
        result: 'mailbox_mismatch',
        revoke: await this.revokeIssued(grant, existing, granted),
      };
    }
    try {
      await this.save(principal, granted, grant.refreshToken, existing);
    } catch (error) {
      const revoke = await this.revokeIssued(grant, existing, granted);
      if (error instanceof CredentialStoreError && error.code === 'env_locked') {
        return { result: 'env_locked', revoke };
      }
      throw error;
    }
    return { result: 'connected' };
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
  private async save(
    principal: Principal,
    mailbox: string,
    refreshToken: string,
    previous: ExistingGrant | null,
  ): Promise<void> {
    await this.persist(principal, mailbox, refreshToken);
    // The mailbox changed: the grant of the old one is no longer used by anything, so end it at Google.
    // (Same mailbox: the old token is left alone; whether revoking it would end the new one is
    // `[UNVERIFIED]`, and Google keeps up to 100 per account and client.)
    if (previous !== null && previous.mailbox !== undefined && previous.mailbox !== mailbox) {
      const revoke = await this.revokeStored(previous.refreshToken);
      await this.audit.record({
        actor: { type: 'user', id: principal.userId },
        action: AUDIT_ACTIONS.gmailOauthDisconnect,
        outcome: revoke === 'revoked' ? 'success' : 'failure',
        targetType: 'integration',
        targetId: 'gmail',
        ip: AuditScope.current()?.meta.ip ?? null,
        requestId: AuditScope.current()?.meta.requestId ?? null,
        metadata: { reason: 'mailbox_changed', revoke },
      });
    }
  }

  private async revokeStored(token: string): Promise<'revoked' | 'failed'> {
    return (await gmail.revokeToken({ fetch: this.send, token })) ? 'revoked' : 'failed';
  }

  /**
   * Disconnects the OAuth mailbox: revokes the refresh token at Google (best effort, the result is
   * audited), then deletes it and the mailbox from the credential store. The generic credential
   * routes refuse those fields, so this is the only way to remove a grant.
   */
  async disconnect(principal: Principal): Promise<GmailOauthDisconnectResult> {
    const [status] = await this.store.status('gmail');
    const source = (name: string) =>
      status?.fields.find((entry) => entry.field === name)?.source ?? 'none';
    if (source('oauthRefreshToken') === 'env' || source('oauthMailbox') === 'env') {
      throw credentialEnvLocked('The grant is set by an environment variable; unset it there');
    }
    if (source('oauthRefreshToken') === 'none' && source('oauthMailbox') === 'none') {
      return { revoke: 'none' };
    }
    const stored = await this.store.resolve('gmail');
    const token = stored.oauthRefreshToken?.value;
    const grant = token === undefined ? null : { refreshToken: token };
    const revoke = grant === null ? 'none' : await this.revokeStored(grant.refreshToken);
    await this.uow.run(async ({ tx }) => {
      for (const field of GMAIL_OAUTH_GRANT_FIELDS) await this.store.remove('gmail', field, tx);
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: principal.userId },
        action: AUDIT_ACTIONS.gmailOauthDisconnect,
        outcome: revoke === 'failed' ? 'failure' : 'success',
        targetType: 'integration',
        targetId: 'gmail',
        metadata: { reason: 'disconnect', revoke },
      });
    });
    return { revoke };
  }

  private async persist(
    principal: Principal,
    mailbox: string,
    refreshToken: string,
  ): Promise<void> {
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
