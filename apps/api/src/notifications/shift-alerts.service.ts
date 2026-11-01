import { Inject, Injectable } from '@nestjs/common';
import { Effects, type ShiftAlertInput } from '@watchtower/domain';

import { domainContext, settle } from '../domain/domain-context.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';

/**
 * Raises the lead notifications T-111 needs (R-7.3 no-show, AC-7 handoff items nobody acknowledged
 * in time). It is a hook: whoever holds the shift overview (`GET /v1/shifts/overview`, T-111) calls
 * `raise(overview)` after building it, on whatever schedule T-111 chooses. The overview already
 * satisfies `ShiftAlertInput`, so it is passed as is. Safe to call as often as you like: one
 * notification per no-show entry and per handoff, once per lead.
 */
@Injectable()
export class ShiftAlertsService {
  constructor(
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

  /** Returns how many notifications were made. */
  raise(overview: ShiftAlertInput): Promise<number> {
    return this.uow.run(async (uow) => {
      const effects = new Effects();
      const ctx = domainContext(this.domain, { type: 'system', id: null });
      const made = await this.domain.notifications.shiftAlerts(uow.tx, ctx, effects, overview);
      return settle(uow, effects.result(made));
    });
  }
}
