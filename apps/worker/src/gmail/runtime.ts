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
 *  - mock (no Gmail credential configured, ADR-004 order: environment, then the encrypted store):
 *    one `FakeGmailTransport` per mailbox, in memory. Nothing leaves the machine and no live client
 *    is constructed. This is what every test and a developer's machine runs.
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
  /** Absent: always mock. */
  readonly credentials?: GmailCredentialSource;
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

export function createGmailRuntime(deps: GmailRuntimeDeps): GmailRuntime {
  const now = deps.now ?? Date.now;
  const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS;
  const mock = createMockGmailRuntime({ database: deps.database });
  if (deps.credentials === undefined) return mock;
  const source: GmailCredentialSource = deps.credentials;

  let decided: { mode: GmailMode; at: number } | null = null;
  const live = new Map<string, { transport: gmail.GmailTransport | undefined; at: number }>();

  async function mode(): Promise<GmailMode> {
    if (decided !== null && now() - decided.at < refreshMs) return decided.mode;
    let next: GmailMode;
    try {
      next = (await source.configured()) ? 'live' : 'mock';
    } catch (error) {
      // The store could not be read (database, key): stay on what was decided, else mock. Never live by accident.
      deps.logger.error({ err: error }, 'gmail credential status unavailable');
      next = decided?.mode ?? 'mock';
    }
    if (next !== decided?.mode) deps.logger.info({ mode: next }, 'gmail mode');
    decided = { mode: next, at: now() };
    return next;
  }

  async function liveTransport(accountId: string): Promise<gmail.GmailTransport | undefined> {
    const cached = live.get(accountId);
    if (cached !== undefined && now() - cached.at < refreshMs) return cached.transport;
    let transport: gmail.GmailTransport | undefined;
    try {
      const [address, credentials] = await Promise.all([
        mailboxOf(deps.database, accountId),
        source.read(),
      ]);
      const delegated = credentials.impersonateUser.trim().toLowerCase();
      if (address !== undefined && address === delegated) {
        transport = new gmail.LiveGmailTransport({
          fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
          getAccessToken: createServiceAccountTokenProvider({
            readCredentials: () => source.read(),
            fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
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
    }
    live.set(accountId, { transport, at: now() });
    return transport;
  }

  return {
    mode,
    async transportFor(account) {
      return (await mode()) === 'live' ? liveTransport(account.id) : mock.transportFor(account);
    },
    async senderFor(account) {
      if ((await mode()) !== 'live') return mock.senderFor(account);
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
