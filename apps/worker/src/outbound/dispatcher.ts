import { ChannelError, gmail, line } from '@watchtower/channels';
import { schema, type Database } from '@watchtower/db';
import {
  authorityNow,
  decideFailure,
  countRecentFailures,
  findReplyToken,
  lockQuota,
  loadDeliveryContext,
  moveQuota,
  retryKeyExpired,
  spendReplyToken,
  TicketKeys,
  type DbTransaction,
  type DeliveryContext,
  type Domain,
  type DomainContext,
  type DomainResult,
  type FailureDecision,
  type FailureFacts,
  type OutboundDeliveryRow,
} from '@watchtower/domain';
import {
  DELIVERY_RETRY_KEY_MAX_AGE_SECONDS,
  type DeliveryRoute,
  type RealtimeEvent,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';
import type { RealtimeSink } from '../realtime.js';
import type { GmailSender, OutboundChannels } from './channels.js';

/**
 * The dispatcher (ADR-010 section 3): takes one due `outbound_delivery`, re-checks that the send is
 * still legitimate, calls the provider outside any transaction, and records what happened. The
 * database half lives in `@watchtower/domain` (`claim`, `vet`, `recordSent`, ...); this file adds
 * what the domain must not import: the channel adapters and the LINE router.
 *
 *   claim (CAS) -> vet (hash, draft approval, policy gate) -> [LINE: route + quota + spend token]
 *   -> mark dispatched -> provider call -> record sent / retry / failed
 *
 * At-most-once: only the caller whose CAS wins gets to call the provider, and a call whose outcome
 * we do not know is never repeated by a machine unless the route has an idempotency key (a LINE
 * push carries `X-Line-Retry-Key = delivery id`).
 */

export type DispatchOutcome =
  /** Not claimable: undone, already sent, or somebody else has it. A duplicate trigger lands here. */
  | { readonly status: 'skipped' }
  /** Scheduled, not due yet by this process' clock: the job has to come back at `notBefore`. */
  | { readonly status: 'early'; readonly notBefore: Date }
  | { readonly status: 'sent'; readonly route: DeliveryRoute }
  | { readonly status: 'retry'; readonly errorCode: string }
  | { readonly status: 'failed'; readonly errorCode: string; readonly outcomeUnknown: boolean }
  /** The gate or a content check refused at claim time; nothing was sent. */
  | { readonly status: 'denied'; readonly reason: string }
  /** The row stopped being ours (the sweeper took it). */
  | { readonly status: 'lost' };

export interface DispatcherDeps {
  readonly database: Database;
  /** Built with the real policy gate (`createPolicyGate` on the worker's own database handle). */
  readonly domain: Domain;
  readonly channels: OutboundChannels;
  /** Host of `APP_URL`: the right-hand side of the Message-ID we stamp on mail. */
  readonly appHost: string;
  readonly realtime: RealtimeSink;
  readonly logger: WorkerLogger;
  /** Monthly LINE push allowance when no counter row exists yet (po #5: 300 `[VERIFY]`). */
  readonly lineQuotaLimit?: number | null;
  readonly lineRouter?: Partial<line.LineRouterConfig>;
}

const SYSTEM_ACTOR = { type: 'system', id: null } as const;
const FAILURE_ALERT_WINDOW_MS = 15 * 60 * 1000;
const FAILURE_ALERT_COUNT = 3;
const RECORD_RETRIES = 3;
/** A trigger this close ahead of its delivery is held until it is due; further ahead it is dropped. */
const EARLY_TOLERANCE_MS = 10_000;

/** The row is no longer ours; thrown inside a transaction to roll the transaction back. */
class ClaimLost extends Error {
  constructor() {
    super('delivery claim lost');
    this.name = 'ClaimLost';
  }
}

function factsOf(error: unknown, dispatched: boolean): FailureFacts {
  if (error instanceof ChannelError) {
    return {
      kind: error.kind,
      retryable: error.retryable,
      // An answer we cannot read may follow a send that worked. The token comes before any send, so
      // a failure to get one is a certain non-delivery, however it failed.
      outcomeUnknown:
        error.operation !== 'oauth2.token' &&
        (error.outcomeUnknown || error.kind === 'invalid_response'),
      retryAfterMs: error.retryAfterMs,
    };
  }
  if (error instanceof gmail.ReplyBuildError) {
    return { kind: 'invalid_request', retryable: false, outcomeUnknown: false };
  }
  // Something unexpected: if the provider call had started, we cannot say it did not go out.
  return { kind: 'internal', retryable: false, outcomeUnknown: dispatched };
}

/** LINE text messages are at most 5,000 UTF-16 units and a request takes five: split on characters, not units. */
export function splitLineText(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (const char of text) {
    if (current.length + char.length > line.LINE_MAX_TEXT_LENGTH) {
      parts.push(current);
      current = '';
    }
    current += char;
  }
  if (current !== '') parts.push(current);
  return parts;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createOutboundDispatcher(deps: DispatcherDeps) {
  const { database, domain, logger } = deps;
  const lineLimit =
    deps.lineQuotaLimit === undefined ? line.FALLBACK_QUOTA_LIMIT : deps.lineQuotaLimit;

  const newContext = (): DomainContext => domain.context({ actor: SYSTEM_ACTOR });
  // The ticket key as the customer sees it (`OPS-12`).
  const ticketKeys = new TicketKeys(domain.config.ticketKeyPrefix);

  async function publish(events: readonly RealtimeEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await deps.realtime.publish(event);
      } catch (error) {
        logger.warn({ err: error, eventType: event.type }, 'realtime publish failed');
        return;
      }
    }
  }

  /** One transaction of domain work; the realtime events go out after the commit. */
  async function transact<T>(
    work: (tx: DbTransaction, ctx: DomainContext) => Promise<DomainResult<T>>,
  ): Promise<T> {
    const ctx = newContext();
    const result = await database.db.transaction((tx) => work(tx, ctx));
    await publish(result.events);
    return result.value;
  }

  async function alertIfNeeded(
    delivery: OutboundDeliveryRow,
    decision: Extract<FailureDecision, { action: 'fail' }>,
  ): Promise<void> {
    const since = new Date(newContext().now().getTime() - FAILURE_ALERT_WINDOW_MS);
    const recent = await countRecentFailures(database.db, delivery.channelAccountId, since);
    if (decision.outcomeUnknown || recent >= FAILURE_ALERT_COUNT) {
      // In-app and Discord notices arrive with T-104/T-105; until then the log line is the alert.
      // It carries ids, codes and counts, never a body or a token.
      logger.error(
        {
          alert: 'outbound_delivery_failures',
          deliveryId: delivery.id,
          channelAccountId: delivery.channelAccountId,
          channel: delivery.channel,
          errorCode: decision.errorCode,
          outcomeUnknown: decision.outcomeUnknown,
          failedInWindow: recent,
        },
        'outbound delivery failed',
      );
    }
  }

  /** Records a retry or a final failure; `release` gives a LINE reservation back when nothing was sent. */
  async function conclude(
    delivery: OutboundDeliveryRow,
    decision: FailureDecision,
    options: { release?: { accountId: string; period: string }; reason?: string } = {},
  ): Promise<DispatchOutcome> {
    const giveBack = decision.action === 'retry' || !decision.outcomeUnknown;
    const recorded = await transact(async (tx, ctx) => {
      if (options.release !== undefined && giveBack) {
        await moveQuota(tx, options.release.accountId, options.release.period, -1, ctx.now());
      }
      return domain.outbound.recordFailure(
        tx,
        ctx,
        delivery,
        decision,
        options.reason === undefined ? {} : { reason: options.reason },
      );
    });
    if (!recorded) return { status: 'lost' };
    if (decision.action === 'retry') {
      return { status: 'retry', errorCode: `retry_in_${String(decision.delaySeconds)}s` };
    }
    await alertIfNeeded(delivery, decision);
    return {
      status: 'failed',
      errorCode: decision.errorCode,
      outcomeUnknown: decision.outcomeUnknown,
    };
  }

  /**
   * Ends the delivery without calling the provider in this attempt. It is a certain non-delivery
   * unless an earlier attempt already pushed (the row is pinned to `line_push`): that one may have
   * reached the customer although we never heard back, so the person who retries must be told (N-5).
   */
  const failNow = (
    delivery: OutboundDeliveryRow,
    errorCode: string,
    reason?: string,
  ): Promise<DispatchOutcome> =>
    conclude(
      delivery,
      { action: 'fail', errorCode, outcomeUnknown: delivery.route === 'line_push' },
      reason === undefined ? {} : { reason },
    );

  /** A provider call ended in an error: retry, or fail with the right code. */
  function afterProviderError(
    delivery: OutboundDeliveryRow,
    error: unknown,
    route: DeliveryRoute | null,
    release?: { accountId: string; period: string },
  ): Promise<DispatchOutcome> {
    const facts = factsOf(error, route !== null);
    const options = release === undefined ? {} : { release };
    // LINE answers 429 with `monthly_limit` when the plan's allowance is spent: not a delay, a wall.
    if (error instanceof ChannelError && error.code === 'monthly_limit') {
      return conclude(
        delivery,
        { action: 'fail', errorCode: 'quota_exhausted', outcomeUnknown: false },
        { ...options, reason: 'suggest_email' },
      );
    }
    const decision = decideFailure(facts, { route, attempts: delivery.attempts });
    return conclude(delivery, decision, options);
  }

  async function recordSentWithRetries(
    delivery: OutboundDeliveryRow,
    result: Parameters<Domain['outbound']['recordSent']>[3],
  ): Promise<DispatchOutcome> {
    // The provider has the message: a database hiccup now must not turn into a "failed" that a
    // person retries into a duplicate. Try a few times before leaving it to the sweeper.
    for (let attempt = 1; ; attempt += 1) {
      try {
        const recorded = await transact((tx, ctx) =>
          domain.outbound.recordSent(tx, ctx, delivery, result),
        );
        if (!recorded) {
          logger.error(
            { deliveryId: delivery.id },
            'delivery was sent but the row is no longer ours',
          );
          return { status: 'lost' };
        }
        return { status: 'sent', route: result.route };
      } catch (error) {
        if (attempt >= RECORD_RETRIES) {
          logger.error({ err: error, deliveryId: delivery.id }, 'could not record a sent delivery');
          throw error;
        }
        await wait(200 * attempt);
      }
    }
  }

  // -- Gmail --------------------------------------------------------------------------------------

  async function sendGmail(
    delivery: OutboundDeliveryRow,
    context: DeliveryContext,
  ): Promise<DispatchOutcome> {
    let sender: GmailSender | undefined;
    try {
      sender = await deps.channels.gmail(context.account);
    } catch (error) {
      // The credentials could not be read (store down). Nothing was dispatched, so this is a
      // certain non-delivery: back off and try again, and after DELIVERY_MAX_ATTEMPTS fail it where
      // the agent sees it (`channel_credentials_unavailable`) instead of leaving it in "sending".
      logger.warn({ err: error, deliveryId: delivery.id }, 'gmail sender unavailable');
      return conclude(
        delivery,
        decideFailure(
          {
            kind: 'credentials_unavailable',
            retryable: error instanceof ChannelError ? error.retryable : true,
            outcomeUnknown: false,
          },
          { route: null, attempts: delivery.attempts },
        ),
      );
    }
    if (sender === undefined) return failNow(delivery, 'channel_not_connected');
    const { ticket, message, parent, requester } = context;
    const recipient = parent?.fromAddress ?? requester?.emails[0] ?? null;
    if (recipient === null) return failNow(delivery, 'no_recipient');
    const threadId = context.gmailThreadId ?? undefined;
    // The route is written once (T-122f F-3): a retry keeps the label of the attempt that set it.
    const route: DeliveryRoute =
      delivery.route === 'gmail_thread' || delivery.route === 'gmail_new'
        ? delivery.route
        : parent !== null && threadId !== undefined
          ? 'gmail_thread'
          : 'gmail_new';
    const messageId = gmail.makeMessageId(delivery.id, deps.appHost);
    const input: gmail.GmailSendInput = {
      from: sender.from,
      inReplyTo: {
        messageId: parent?.rfc822MessageId ?? null,
        references: [...(parent?.references ?? [])],
        subject: parent?.subject ?? ticket.subject,
        from:
          parent?.fromAddress == null
            ? null
            : { address: parent.fromAddress, name: parent.fromName },
        replyTo: [],
      },
      to: [{ address: recipient, name: requester?.name ?? parent?.fromName ?? null }],
      textBody: message.bodyText,
      messageId,
      ...(threadId === undefined ? {} : { threadId }),
      ticketKey: ticketKeys.format(ticket.number),
      subjectMode: parent === null ? 'reuse' : 'prefix_re',
      automatic: delivery.origin === 'system_template',
    };

    const marked = await transact(async (tx, ctx) => {
      const ok = await domain.outbound.markDispatched(tx, ctx, delivery, route);
      return { value: ok, events: [], audited: false };
    });
    if (!marked) return { status: 'lost' };

    let sent: gmail.GmailSendResult;
    try {
      sent = await sender.send(input);
    } catch (error) {
      // No automatic repeat after an unknown outcome: Gmail has no idempotency key (ADR-010 section 6).
      return afterProviderError({ ...delivery, route }, error, route);
    }
    return recordSentWithRetries(
      { ...delivery, route },
      {
        route,
        providerMessageId: sent.providerMessageId,
        rfc822MessageId: gmail.normalizeMessageId(sent.messageId),
        providerThreadId: sent.gmailThreadId,
        threadKey: `gmail:${sent.gmailThreadId}`,
        alreadyAccepted: false,
      },
    );
  }

  // -- LINE ---------------------------------------------------------------------------------------

  type LinePlan =
    | {
        readonly kind: 'go';
        readonly route: 'line_reply' | 'line_push';
        readonly replyToken: string | null;
        readonly period: string;
      }
    | { readonly kind: 'none'; readonly reason: 'quota_exhausted' | 'push_not_allowed' };

  /**
   * Decides the route and moves the numbers in ONE transaction: take the reply token (or reserve a
   * push) and mark the delivery dispatched. If the row is no longer ours the transaction rolls back
   * and the token is still there.
   */
  async function planLine(
    delivery: OutboundDeliveryRow,
    allowReply: boolean,
  ): Promise<LinePlan | 'lost'> {
    try {
      return await database.db.transaction(async (tx) => {
        const ctx = newContext();
        const now = ctx.now();
        const period = line.quotaPeriod(now);
        const quota = await lockQuota(tx, delivery.channelAccountId, period, lineLimit);
        const stored = allowReply ? await findReplyToken(tx, delivery.ticketId) : null;
        const decide = (token: { receivedAt: Date; used: boolean } | null) =>
          line.decideLineRoute({
            now,
            replyToken: token,
            quota,
            pushFallback: delivery.origin === 'system_template' ? 'deny' : 'allow',
            ...(deps.lineRouter === undefined ? {} : { config: deps.lineRouter }),
          });
        let decision = decide(
          stored === null ? null : { receivedAt: stored.receivedAt, used: false },
        );
        let replyToken: string | null = null;
        if (decision.route === 'reply' && stored !== null) {
          replyToken = await spendReplyToken(tx, ctx, stored.inboundMessageId);
          if (replyToken === null) decision = decide(null);
        }
        if (decision.route === 'none') return { kind: 'none', reason: decision.reason } as const;
        if (decision.route === 'push') {
          await moveQuota(tx, delivery.channelAccountId, period, 1, now);
        }
        const route = decision.route === 'reply' ? 'line_reply' : 'line_push';
        if (!(await domain.outbound.markDispatched(tx, ctx, delivery, route))) {
          throw new ClaimLost();
        }
        return { kind: 'go', route, replyToken, period } as const;
      });
    } catch (error) {
      if (error instanceof ClaimLost) return 'lost';
      throw error;
    }
  }

  async function sendLine(
    delivery: OutboundDeliveryRow,
    context: DeliveryContext,
  ): Promise<DispatchOutcome> {
    const sender = deps.channels.line(context.account);
    if (sender === undefined) return failNow(delivery, 'channel_not_connected');
    const to = context.lineConversationId ?? context.requester?.lineUserId ?? null;
    if (to === null) return failNow(delivery, 'no_recipient');
    const texts = splitLineText(context.message.bodyText);
    if (texts.length === 0 || texts.length > line.LINE_MAX_MESSAGES_PER_REQUEST) {
      return failNow(delivery, 'message_too_long');
    }

    // N-2: LINE remembers a retry key for a day only. Past our bound a repeat could be sent twice.
    if (
      delivery.route === 'line_push' &&
      retryKeyExpired(
        delivery.createdAt,
        await authorityNow(database.db, newContext()),
        domain.config.retryKeyMaxAgeSeconds ?? DELIVERY_RETRY_KEY_MAX_AGE_SECONDS,
      )
    ) {
      return failNow(delivery, 'retry_key_expired', 'retry_key_expired');
    }

    // Review O-2: once a push was attempted (its outcome may be unknown) every later attempt of this
    // delivery pushes with the same retry key. A fresh reply token must not turn it into a second,
    // different message. `route` survives a retry or a sweep; only a new delivery starts clean.
    let allowReply = delivery.route !== 'line_push';
    for (;;) {
      const plan = await planLine(delivery, allowReply);
      if (plan === 'lost') return { status: 'lost' };
      if (plan.kind === 'none') {
        // The reply token is gone or spent. A person's reply could be pushed but the quota is used up
        // (suggest email, PRD 8.3); an instant acknowledgment is never pushed (ADR-010).
        return failNow(
          delivery,
          plan.reason === 'quota_exhausted' ? 'quota_exhausted' : 'reply_token_unavailable',
          plan.reason === 'quota_exhausted' ? 'suggest_email' : plan.reason,
        );
      }
      const dispatched = { ...delivery, route: plan.route };
      const release = { accountId: delivery.channelAccountId, period: plan.period };
      try {
        const result =
          plan.route === 'line_reply' && plan.replyToken !== null
            ? await sender.send({ route: 'reply', replyToken: plan.replyToken, texts })
            : await sender.send({ route: 'push', to, texts, retryKey: delivery.id });
        return await recordSentWithRetries(dispatched, {
          route: plan.route,
          providerMessageId: result.sentMessageIds[0] ?? null,
          rfc822MessageId: null,
          providerThreadId: null,
          threadKey: `line:${to}`,
          alreadyAccepted: result.alreadyAccepted,
        });
      } catch (error) {
        if (error instanceof ChannelError && error.code === 'invalid_reply_token') {
          // Spent or expired: nothing was sent. A person's reply falls back to a push in this same
          // attempt; an automatic acknowledgment does not.
          if (delivery.origin === 'system_template') {
            return failNow(dispatched, 'reply_token_invalid');
          }
          allowReply = false;
          continue;
        }
        return afterProviderError(
          dispatched,
          error,
          plan.route,
          plan.route === 'line_push' ? release : undefined,
        );
      }
    }
  }

  // -- entry points -------------------------------------------------------------------------------

  /** Sends one delivery if it is due. Safe to call any number of times, from any number of workers. */
  async function dispatch(deliveryId: string): Promise<DispatchOutcome> {
    const claimed = await transact(async (tx, ctx) => {
      const row = await domain.outbound.claim(tx, ctx, deliveryId);
      return { value: row, events: [], audited: false };
    });
    if (claimed === null) {
      // The outbox relay releases this job by the database clock and the claim reads this process'
      // clock. A few milliseconds between them must not park a reply until the sweeper's next look.
      const [row] = await database.db
        .select({
          state: schema.outboundDelivery.state,
          nextAttemptAt: schema.outboundDelivery.nextAttemptAt,
        })
        .from(schema.outboundDelivery)
        .where(eq(schema.outboundDelivery.id, deliveryId));
      if (row?.state === 'scheduled') {
        // Only a trigger that is a moment ahead of the delivery's time is parked until then. A trigger
        // that is far ahead (a stale one for a retry minutes away, a duplicate) is dropped: the
        // delivery has its own trigger at its own time, and the sweeper covers a lost one (T-122f P3).
        const remainingMs =
          row.nextAttemptAt.getTime() - (await authorityNow(database.db, newContext())).getTime();
        // Due by now: it came due between the failed claim and this read, so it goes round again at once.
        if (remainingMs <= 0) return { status: 'early', notBefore: new Date(Date.now() + 50) };
        if (remainingMs <= EARLY_TOLERANCE_MS) {
          return { status: 'early', notBefore: row.nextAttemptAt };
        }
      }
      return { status: 'skipped' };
    }

    let vetting: Awaited<ReturnType<Domain['outbound']['vet']>>;
    try {
      vetting = await domain.outbound.vet(database.db, newContext(), claimed);
    } catch (error) {
      // The gate could not answer (fail closed): nothing is sent; try again later.
      logger.warn({ err: error, deliveryId }, 'policy gate unavailable; the delivery will retry');
      const decision = decideFailure(
        { kind: 'gate_unavailable', retryable: true, outcomeUnknown: false },
        { route: claimed.route, attempts: claimed.attempts },
      );
      // T-122f F-2: nothing was called in this attempt, but a push from an earlier one may have reached
      // the customer. Giving up now must say so (as `failNow` does), not "nothing was sent".
      return conclude(
        claimed,
        decision.action === 'fail' && claimed.route === 'line_push'
          ? { ...decision, outcomeUnknown: true }
          : decision,
      );
    }
    if (!vetting.ok) {
      const denied = await transact((tx, ctx) =>
        domain.outbound.deny(tx, ctx, claimed, vetting.reason),
      );
      logger.warn({ deliveryId, reason: vetting.reason }, 'delivery refused at claim time');
      return denied ? { status: 'denied', reason: vetting.reason } : { status: 'lost' };
    }

    const context = await loadDeliveryContext(database.db, claimed);
    if (context === null) return failNow(claimed, 'message_missing');
    try {
      return context.account.type === 'gmail'
        ? await sendGmail(claimed, context)
        : context.account.type === 'line'
          ? await sendLine(claimed, context)
          : await failNow(claimed, 'channel_not_supported');
    } catch (error) {
      // A bug or a database error between the claim and a result. The row stays `sending`; the
      // sweeper decides from `dispatched_at`: never reached the provider -> back to scheduled.
      logger.error({ err: error, deliveryId }, 'dispatch crashed; the sweeper will settle it');
      throw error;
    }
  }

  /** Stuck `sending`, late `scheduled` rows and stale reply tokens. */
  async function sweep() {
    const ctx = newContext();
    const result = await database.db.transaction((tx) =>
      domain.outbound.sweep(tx, ctx, { quotaPeriodOf: (date) => line.quotaPeriod(date) }),
    );
    await publish(result.events);
    if (result.unknownOutcome > 0 || result.retryLimited > 0 || result.retriggered.length > 0) {
      logger.error(
        {
          alert: 'outbound_sweep',
          released: result.released,
          unknownOutcome: result.unknownOutcome,
          retriedPush: result.retriedPush,
          retryLimited: result.retryLimited,
          retriggered: result.retriggered.length,
        },
        'outbound sweeper found stuck deliveries',
      );
    }
    return result;
  }

  return { dispatch, sweep };
}

export type OutboundDispatcher = ReturnType<typeof createOutboundDispatcher>;
