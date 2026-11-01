import { Inject, Injectable } from '@nestjs/common';
import type { Actor } from '@watchtower/domain';
import type { AlertAckVia } from '@watchtower/shared';

import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import type { UnitOfWork } from '../realtime/unit-of-work.js';

/**
 * What a person does to an alert (T-201d): acknowledge it. The rules (one conditional update decides
 * the winner, the database clock stamps it, the audit row and the realtime event) live in
 * `@watchtower/domain`; this builds the context and answers the domain's refusals with HTTP errors.
 */
@Injectable()
export class AlertsActions {
  constructor(@Inject(DOMAIN) private readonly domain: Domain) {}

  /**
   * Acknowledges `alertId` as `actor`. `changed: false` means somebody was first (or the alert is
   * resolved): the alert is returned as it is, not an error, so a double click or a Discord press that
   * races the web is harmless.
   */
  async ack(
    uow: UnitOfWork,
    actor: Actor,
    alertId: string,
    via: AlertAckVia,
  ): Promise<{ changed: boolean }> {
    return translating(async () =>
      settle(
        uow,
        await this.domain.alerts.ack(uow.tx, domainContext(this.domain, actor), { alertId, via }),
      ),
    );
  }
}
