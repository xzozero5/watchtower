import type { Database } from '@watchtower/db';
import { schema } from '@watchtower/db';
import type { Domain } from '@watchtower/domain';
import { eq } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';
import type { OutboundChannels } from '../outbound/channels.js';
import type { OutboundDispatcher } from '../outbound/dispatcher.js';
import type { RealtimeSink } from '../realtime.js';
import type { CommittedMessage } from './processor.js';

/**
 * The instant acknowledgment of a new LINE conversation (AC-2: within 5 seconds; R-2.10: the reply
 * token makes it free). It runs in the ingest job, right after the ticket is committed, and sends
 * through the same outbound pipeline as any other customer-bound message, so nothing here can
 * bypass the policy gate (N3):
 *
 *   `domain.outbound.scheduleTemplateAck`  -> the text is rendered on the server from a template
 *   key on the safe list (the caller supplies no words); the gate allows `system_template` only for
 *   keys on `SAFE_AUTO_ACK_TEMPLATES`, at every autonomy stage and with the kill switch on
 *   `dispatcher.dispatch`                   -> claim, gate again, reply token (never a push: an
 *   acknowledgment that arrives late is not worth quota), provider call, result
 *
 * An error never undoes the ingestion; the ack is simply not sent. The ack is for a new ticket only:
 * a customer who keeps writing on an open ticket is not acknowledged again.
 */

/** The only template this task sends. Both keys of the safe list render a text with the same facts. */
export const LINE_ACK_TEMPLATE = 'auto_ack.received';

export interface AutoAckDeps {
  readonly database: Database;
  readonly domain: Domain;
  readonly dispatcher: Pick<OutboundDispatcher, 'dispatch'>;
  /** Which accounts the process can answer through. An account with no sender gets no ack. */
  readonly channels: Pick<OutboundChannels, 'line'>;
  readonly realtime: RealtimeSink;
  readonly logger: WorkerLogger;
  /** For tests: another key, to prove the gate refuses what is not on the list. */
  readonly templateKey?: string;
}

const SYSTEM_ACTOR = { type: 'system', id: null } as const;

export function createLineAutoAck(deps: AutoAckDeps) {
  const templateKey = deps.templateKey ?? LINE_ACK_TEMPLATE;

  async function ack(committed: CommittedMessage): Promise<void> {
    const { outcome } = committed;
    if (committed.channel !== 'line' || outcome.disposition !== 'ticket') return;
    if (outcome.ticketId === null) return;
    const [account] = await deps.database.db
      .select({
        id: schema.channelAccount.id,
        type: schema.channelAccount.type,
        name: schema.channelAccount.name,
      })
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, committed.channelAccountId))
      .limit(1);
    if (account === undefined) return;
    // Nothing connected: an ack that can only fail is noise.
    if (deps.channels.line(account) === undefined) {
      deps.logger.debug({ channelAccountId: account.id }, 'no LINE sender; auto-ack skipped');
      return;
    }
    const startedAt = Date.now();
    const ctx = deps.domain.context({ actor: SYSTEM_ACTOR });
    const scheduled = await deps.database.db.transaction((tx) =>
      deps.domain.outbound.scheduleTemplateAck(tx, ctx, {
        ref: outcome.ticketId ?? '',
        templateKey,
      }),
    );
    for (const event of scheduled.events) {
      try {
        await deps.realtime.publish(event);
      } catch (error) {
        deps.logger.warn({ err: error, eventType: event.type }, 'realtime publish failed');
        break;
      }
    }
    const result = await deps.dispatcher.dispatch(scheduled.value.delivery.id);
    deps.logger.info(
      {
        deliveryId: scheduled.value.delivery.id,
        outcome: result.status,
        route: result.status === 'sent' ? result.route : undefined,
        ackMs: Date.now() - startedAt,
      },
      'line auto-ack',
    );
  }

  return async (committed: readonly CommittedMessage[]): Promise<void> => {
    for (const item of committed) {
      try {
        await ack(item);
      } catch (error) {
        // A refusal by the gate (a key that is not on the safe list) lands here too: nothing is sent.
        deps.logger.warn({ err: error, ticketId: item.outcome.ticketId }, 'line auto-ack not sent');
      }
    }
  };
}
