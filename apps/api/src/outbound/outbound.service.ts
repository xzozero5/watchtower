import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@watchtower/db';
import { toDeliverySummary, type Actor } from '@watchtower/domain';
import type { CancelSendResult, OutboundSettings } from '@watchtower/shared';

import { DATABASE } from '../database/database.module.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import type { UnitOfWork } from '../realtime/unit-of-work.js';

/**
 * Outbound delivery from the api's side (T-122d, ADR-010): undo a send and the instance setting for
 * the undo window. Scheduling happens inside `tickets.reply`; sending is the worker's. The rules are
 * in `@watchtower/domain`; this is the Nest face of them.
 */
@Injectable()
export class OutboundService {
  constructor(
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(DATABASE) private readonly database: Database,
  ) {}

  /** Undo a send while the hold lasts; 409 once the message is going out. */
  async cancel(
    uow: UnitOfWork,
    input: { ref: string; deliveryId: string; canCancelAny: boolean },
    actor: Actor,
  ): Promise<CancelSendResult> {
    return translating(async () => {
      const delivery = settle(
        uow,
        await this.domain.outbound.cancel(uow.tx, domainContext(this.domain, actor), input),
      );
      return {
        delivery: toDeliverySummary(delivery, new Date()),
        messageId: delivery.messageId,
        deliveryStatus: 'cancelled' as const,
      };
    });
  }

  readSettings(): Promise<OutboundSettings> {
    return this.domain.outbound.readSettings(this.database.db);
  }

  async setUndoSendSeconds(
    uow: UnitOfWork,
    seconds: number,
    actor: Actor,
  ): Promise<OutboundSettings> {
    return translating(async () =>
      settle(
        uow,
        await this.domain.outbound.setUndoSendSeconds(
          uow.tx,
          domainContext(this.domain, actor),
          seconds,
        ),
      ),
    );
  }
}
