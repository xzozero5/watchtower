import { createHash } from 'node:crypto';

import { ChannelError, gmail, type FetchLike } from '@watchtower/channels';
import { schema, type Database } from '@watchtower/db';
import { eq } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';
import type { GmailSender, OutboundAccount } from '../outbound/channels.js';
import {
  createServiceAccountTokenProvider,
  type ServiceAccountCredentials,
} from './service-account.js';

/**
 * How the worker reaches a Gmail mailbox. One object for the three users of a transport: the sync
 * job (T-102c), the ingest fetch (T-122c) and the outbound dispatcher (T-102d), so they always agree
 * on mock or live.
 *
 *  - mock (no Gmail credential configured, ADR-004 order: environment, then the encrypted store),
 *    ONLY when `allowMock` (`GMAIL_MOCK_ENABLED=true`, never in production): one `FakeGmailTransport` per mailbox, in
 *    memory. Nothing leaves the machine and no live client is constructed. This is what every test
 *    and a developer's machine runs. Without the opt-in the same situation yields no transport and no
 *    sender (`channel_not_connected`), and an unreadable credential store is a retryable error.
 *  - live (the `gmail` integration is complete in the credential store): a `LiveGmailTransport`
 *    over `fetch` with a service-account token (domain-wide delegation, `service-account.ts`), for
 *    the ONE mailbox the credential names (ADR-012: credentials are not per mailbox yet, T-102e).
 *    A mailbox that is not that one gets no transport (`undefined`), so its jobs fail visibly.
 *
 * Sending as the mailbox: the `From` address is the address in `gmail_account_state` (R-2.4); the
 * display name is left to the mail client until send-as settings exist (T-102e) `[ASSUMED]`.
 */

export type GmailMode = 'mock' | 'live';

export interface GmailCredentialSource {
  /** Is the `gmail` integration complete? (status only; nothing is decrypted). */
  configured(): Promise<boolean>;
  /** The values in effect. Only called in live mode. */
  read(): Promise<ServiceAccountCredentials>;
}

export interface GmailRuntime {
  mode(): Promise<GmailMode>;
  /** The transport of one mailbox; `undefined` when this process cannot reach it. */
  transportFor(account: { readonly id: string }): Promise<gmail.GmailTransport | undefined>;
  /** What the outbound dispatcher sends through; `undefined` when the mailbox is not connected. */
  senderFor(account: OutboundAccount): Promise<GmailSender | undefined>;
}

export interface GmailRuntimeDeps {
  readonly database: Database;
  readonly logger: WorkerLogger;
  /** Absent: no credential is ever read (mock when `allowMock`, else nothing is reachable). */
  readonly credentials?: GmailCredentialSource;
  /**
   * The in-memory mailbox may stand in for Gmail (development and tests): the explicit opt-in
   * `GMAIL_MOCK_ENABLED`, refused at boot in production and on a non-loopback APP_URL. Off: a worker
   * that is not connected to Gmail must say so (`channel_not_connected`), never pretend to send.
   * Even when on, it is off for good once a complete credential has been seen. Default false.
   */
  readonly allowMock?: boolean;
  /** Live mode only. Default: the global `fetch`. */
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  /** How long a mode decision and a live transport are kept before the credentials are looked at again. */
  readonly refreshMs?: number;
}

const DEFAULT_REFRESH_MS = 60_000;

async function mailboxOf(database: Database, accountId: string): Promise<string | undefined> {
  const [row] = await database.db
    .select({ emailAddress: schema.gmailAccountState.emailAddress })
    .from(schema.gmailAccountState)
    .where(eq(schema.gmailAccountState.channelAccountId, accountId))
    .limit(1);
  return row?.emailAddress;
}

const SANDBOX_SUBJECT = '(sandbox thread)';

/**
 * The sandbox mailbox of mock mode only knows the threads it was given. A ticket that arrived through
 * the fake channel names a Gmail thread this process has never seen, and the fake (like Gmail) refuses
 * to send into an unknown thread. Create it first as a `SENT` placeholder: the sync job skips `SENT`,
 * so it never becomes an inbound message.
 */
function sandboxSender(
  fake: gmail.FakeGmailTransport,
  from: GmailSender['from'],
): GmailSender['send'] {
  const adapter = new gmail.GmailAdapter({ transport: fake });
  return async (input) => {
    try {
      return await adapter.send(input);
    } catch (error) {
      const unknownThread =
        input.threadId !== undefined &&
        error instanceof ChannelError &&
        error.kind === 'not_found' &&
        error.operation === 'users.messages.send';
      if (!unknownThread) throw error;
      fake.deliver(
        gmail.buildFakeMime({ from: from.address, subject: SANDBOX_SUBJECT, body: '-' }).raw,
        { threadId: input.threadId, labelIds: ['SENT'] },
      );
      return adapter.send(input);
    }
  };
}

export interface MockGmailRuntime extends GmailRuntime {
  /** The in-memory mailbox of one account, created on first use. Tests deliver mail into it. */
  fakeFor(accountId: string): gmail.FakeGmailTransport;
}

/** The mock runtime on its own: used by `createGmailRuntime` and directly by tests. */
export function createMockGmailRuntime(
  deps: Pick<GmailRuntimeDeps, 'database'> & { readonly now?: () => Date },
): MockGmailRuntime {
  const fakes = new Map<string, gmail.FakeGmailTransport>();
  const fakeFor = (accountId: string): gmail.FakeGmailTransport => {
    let fake = fakes.get(accountId);
    if (fake === undefined) {
      fake = new gmail.FakeGmailTransport(deps.now === undefined ? {} : { now: deps.now });
      fakes.set(accountId, fake);
    }
    return fake;
  };
  return {
    fakeFor,
    mode: () => Promise.resolve('mock'),
    transportFor: (account) => Promise.resolve(fakeFor(account.id)),
    async senderFor(account) {
      const address = await mailboxOf(deps.database, account.id);
      if (address === undefined) return undefined;
      const from = { address };
      return { from, send: sandboxSender(fakeFor(account.id), from) };
    },
  };
}

/** Sha-256 of what the credential says; kept in memory to tell "the same key" from "a rotated key". Never logged. */
function fingerprintOf(
  credentials: ServiceAccountCredentials,
  address: string | undefined,
): string {
  return (
    createHash('sha256')
      .update(credentials.serviceAccountJson)
      .update('\0')
      .update(credentials.impersonateUser.trim().toLowerCase())
      .update('\0')
      // The mailbox of the account is part of the key: a changed address, or one that was missing or
      // wrong when the transport was decided, is looked at again instead of being remembered.
      .update(address ?? '')
      .digest('hex')
  );
}

const unavailable = (operation: string): ChannelError =>
  // Retryable on purpose (kind `server`): a credential store that cannot be read is a glitch, not a verdict.
  new ChannelError({
    provider: 'gmail',
    operation,
    kind: 'server',
    code: 'credentials_unavailable',
  });

/**
 * Without a Gmail credential, and with fakes not allowed: nothing is reachable. Sync records
 * `transport_unavailable`, the dispatcher fails the delivery as `channel_not_connected`. A fake must never
 * stand in for Gmail in production: it would accept a customer's reply and send nothing.
 */
const NOT_CONNECTED: GmailRuntime = {
  mode: () => Promise.resolve('mock'),
  transportFor: () => Promise.resolve(undefined),
  senderFor: () => Promise.resolve(undefined),
};

export function createGmailRuntime(deps: GmailRuntimeDeps): GmailRuntime {
  const now = deps.now ?? Date.now;
  const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS;
  const allowMock = deps.allowMock === true;
  const mock = createMockGmailRuntime({ database: deps.database });
  if (deps.credentials === undefined) return allowMock ? mock : NOT_CONNECTED;
  const source: GmailCredentialSource = deps.credentials;

  let decided: { mode: GmailMode; at: number } | null = null;
  // Once a complete credential has been seen the fake is off for good: a credential that is revoked
  // or half-edited later must read as "not connected", never as a mailbox that accepts replies.
  let sawLive = false;
  const mockAllowed = (): boolean => allowMock && !sawLive;
  const live = new Map<
    string,
    { transport: gmail.GmailTransport | undefined; fingerprint: string; at: number }
  >();

  /**
   * `live` or `mock`. When the store cannot be read: keep the earlier decision; with none, a mock
   * runtime (development) falls back to mock and anything else throws a retryable error, so a
   * production worker never takes a fake for Gmail while the store is down. Never live by accident.
   */
  async function mode(): Promise<GmailMode> {
    if (decided !== null && now() - decided.at < refreshMs) return decided.mode;
    let next: GmailMode;
    try {
      next = (await source.configured()) ? 'live' : 'mock';
    } catch (error) {
      deps.logger.error({ err: error }, 'gmail credential status unavailable');
      if (decided !== null) next = decided.mode;
      else if (mockAllowed()) next = 'mock';
      else throw unavailable('credentials.status');
    }
    if (next === 'live') sawLive = true;
    if (next === 'mock' && sawLive) {
      deps.logger.error('gmail credential is gone or incomplete after it was live; not connected');
    }
    if (next !== decided?.mode) deps.logger.info({ mode: next }, 'gmail mode');
    decided = { mode: next, at: now() };
    return next;
  }

  /**
   * One transport per mailbox, kept while the credential is the same: the token it minted stays valid
   * for its hour instead of being minted again every refresh. A rotated key (different fingerprint)
   * builds a new transport.
   */
  async function liveTransport(accountId: string): Promise<gmail.GmailTransport | undefined> {
    const cached = live.get(accountId);
    if (cached !== undefined && now() - cached.at < refreshMs) return cached.transport;
    let transport: gmail.GmailTransport | undefined;
    let fingerprint: string;
    try {
      const [address, credentials] = await Promise.all([
        mailboxOf(deps.database, accountId),
        source.read(),
      ]);
      fingerprint = fingerprintOf(credentials, address);
      if (cached !== undefined && cached.fingerprint === fingerprint) {
        live.set(accountId, { ...cached, at: now() });
        return cached.transport;
      }
      const delegated = credentials.impersonateUser.trim().toLowerCase();
      if (address !== undefined && address === delegated) {
        const send = deps.fetch ?? ((input, init) => fetch(input, init));
        transport = new gmail.LiveGmailTransport({
          fetch: send,
          getAccessToken: createServiceAccountTokenProvider({
            readCredentials: () => source.read(),
            fetch: send,
            now,
          }),
        });
      } else {
        deps.logger.warn(
          { accountId, hasState: address !== undefined },
          'gmail credential does not belong to this mailbox; no transport',
        );
      }
    } catch (error) {
      deps.logger.error({ err: error, accountId }, 'gmail credentials unavailable');
      // Keep what worked, and look again at the next refresh.
      if (cached !== undefined) {
        live.set(accountId, { ...cached, at: now() });
        return cached.transport;
      }
      throw unavailable('credentials.read');
    }
    live.set(accountId, { transport, fingerprint, at: now() });
    return transport;
  }

  return {
    mode,
    async transportFor(account) {
      if ((await mode()) === 'live') return liveTransport(account.id);
      return mockAllowed() ? mock.transportFor(account) : undefined;
    },
    async senderFor(account) {
      if ((await mode()) !== 'live') return mockAllowed() ? mock.senderFor(account) : undefined;
      const [transport, address] = await Promise.all([
        liveTransport(account.id),
        mailboxOf(deps.database, account.id),
      ]);
      if (transport === undefined || address === undefined) return undefined;
      const adapter = new gmail.GmailAdapter({ transport });
      return { from: { address }, send: (input) => adapter.send(input) };
    },
  };
}
