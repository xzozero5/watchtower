import { Inject, Injectable } from '@nestjs/common';
import { type Database } from '@watchtower/db';
import { AUDIT_ACTIONS, type CsatResponseInput, type CsatSurveyView } from '@watchtower/shared';

import { AuditScope } from '../audit/audit-scope.js';
import { conflict, invalidTrackingLink } from '../auth/http-errors.js';
import { DATABASE } from '../database/database.module.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { CsatLimits } from './csat-limits.js';

/** Looked up when a link is forged, so a forged link and a real one cost the database the same work. */
const NIL_SURVEY_ID = '00000000-0000-0000-0000-000000000000';

/**
 * What a customer can do with a survey link: see which request it is about, and answer once. The
 * link arrives in the `X-Csat-Token` header (never a URL, never a cookie, never a log line).
 *
 * No enumeration: a malformed, forged, expired, voided or never-sent link, and a survey that does
 * not exist, all answer the same 401 and do the same lookups. The one thing a holder of a *valid*
 * link may learn is that it was already used (409): they hold the secret, so nothing leaks.
 */
@Injectable()
export class CsatPublicService {
  constructor(
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(CsatLimits) private readonly limits: CsatLimits,
  ) {}

  async view(token: string | undefined, ip: string | null): Promise<CsatSurveyView> {
    await this.limits.enforce('read-ip', ip ?? 'unknown');
    const lookup = await this.lookup(token);
    if (lookup === null) throw this.denied();
    if (lookup.state === 'answered') throw conflict('This survey has already been answered');
    return {
      ticketKey: lookup.ticketKey,
      locale: lookup.locale,
      expiresAt: lookup.expiresAt.toISOString(),
    };
  }

  async answer(token: string | undefined, input: CsatResponseInput, ip: string | null) {
    await this.limits.enforce('answer-ip', ip ?? 'unknown');
    const claims = this.claims(token);
    if (claims === null) {
      // Same work as a real link, so the answer does not depend on the signature.
      await this.domain.csat.findForLink(this.database.db, this.context(), NIL_SURVEY_ID);
      throw this.denied();
    }
    await this.limits.enforce('answer-survey', claims.surveyId);
    const outcome = await translating(() =>
      this.uow.run(async (uow) =>
        settle(
          uow,
          await this.domain.csat.answer(uow.tx, this.context(), {
            surveyId: claims.surveyId,
            score: input.score,
            resolved: input.resolved,
            comment: input.comment,
          }),
        ),
      ),
    );
    if (outcome.kind === 'already_answered') {
      throw conflict('This survey has already been answered');
    }
    if (outcome.kind === 'unavailable') throw this.denied();
    AuditScope.set({ targetType: 'csat_survey', targetId: claims.surveyId });
    return { recorded: true } as const;
  }

  /** The signed claims of a link, or null for any reason it does not verify (malformed, forged, expired). */
  private claims(token: string | undefined) {
    const csat = this.domain.config.csat;
    if (csat === undefined) return null;
    return this.domain.csat.verifyToken(csat.signingKey, token ?? '', new Date());
  }

  private async lookup(token: string | undefined) {
    const claims = this.claims(token);
    return this.domain.csat.findForLink(
      this.database.db,
      this.context(),
      claims?.surveyId ?? NIL_SURVEY_ID,
    );
  }

  private context() {
    return domainContext(this.domain, { type: 'anonymous', id: null });
  }

  private denied() {
    AuditScope.set({ action: AUDIT_ACTIONS.csatAccessDenied, outcome: 'denied' });
    return invalidTrackingLink();
  }
}
