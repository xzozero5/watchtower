import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@watchtower/db';
import type { Actor } from '@watchtower/domain';
import type {
  AutonomyState,
  IntentAutonomyChange,
  SetAiSwitch,
  SetAiSwitchResult,
  SetIntentAutonomy,
} from '@watchtower/shared';

import { DATABASE } from '../database/database.module.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import type { UnitOfWork } from '../realtime/unit-of-work.js';

/**
 * Autonomy stage per intent and the two global switches (T-112a, ADR-011). The rules live in
 * `@watchtower/domain`; this is the Nest face of it: it builds the context, hands the audit mark to
 * the request, and answers the domain's refusals with the api's HTTP errors.
 */
@Injectable()
export class AutonomyService {
  constructor(
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(DATABASE) private readonly database: Database,
  ) {}

  read(): Promise<AutonomyState> {
    return this.domain.autonomy.read(this.database.db);
  }

  async setSwitch(uow: UnitOfWork, actor: Actor, input: SetAiSwitch): Promise<SetAiSwitchResult> {
    return translating(async () =>
      settle(
        uow,
        await this.domain.autonomy.setSwitch(uow.tx, domainContext(this.domain, actor), input),
      ),
    );
  }

  async setIntent(
    uow: UnitOfWork,
    actor: Actor,
    intentId: string,
    input: SetIntentAutonomy,
  ): Promise<IntentAutonomyChange> {
    return translating(async () =>
      settle(
        uow,
        await this.domain.autonomy.setIntentStage(uow.tx, domainContext(this.domain, actor), {
          intentId,
          stage: input.stage,
          pinned: input.pinned,
          reason: input.reason,
        }),
      ),
    );
  }
}
