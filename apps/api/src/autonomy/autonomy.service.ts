import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  generateGateReport,
  readAutosendDisclosure,
  readGateReports,
  setAutosendDisclosure,
  type Actor,
} from '@watchtower/domain';
import {
  AUTOSEND_DISCLOSURE_DEFAULT,
  PROMOTION_REAUTH_SECONDS,
  parseAutosendPolicy,
  type AutonomyPromotionState,
  type AutosendDisclosure,
  type DecidePromotion,
  type GateReport,
  type IntentAutosend,
  type Promotion,
  type RequestPromotion,
  type SetAutosendDisclosure,
  type SetIntentAutosend,
} from '@watchtower/shared';
import type {
  AutonomyHistoryEntry,
  AutonomyHistoryPage,
  AutonomyHistoryQuery,
  AutonomyState,
  IntentAutonomyChange,
  SetAiSwitch,
  SetAiSwitchResult,
  SetIntentAutonomy,
} from '@watchtower/shared';

import { and, desc, eq } from 'drizzle-orm';

import { ApiHttpError, notFound } from '../auth/http-errors.js';
import { beforeCursor, decodeCursor, preciseTimestamp, toPage } from '../common/keyset.js';
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

  /** `AI_AUTOSEND_ENABLED` of this process, read once at boot. Never from the database. */
  get autosendFlag(): boolean {
    return this.domain.config.autosendEnabled === true;
  }

  read(): Promise<AutonomyState> {
    return this.domain.autonomy.read(this.database.db, this.autosendFlag);
  }

  private requireFlag(): void {
    if (!this.autosendFlag) {
      throw new ApiHttpError(
        409,
        'autosend_flag_off',
        'Auto-send is not enabled on this instance (AI_AUTOSEND_ENABLED is not true); a promotion cannot go ahead',
      );
    }
  }

  private async intentExists(intentId: string): Promise<{ id: string; key: string }> {
    const [found] = await this.database.db
      .select({ id: schema.intent.id, key: schema.intent.key })
      .from(schema.intent)
      .where(eq(schema.intent.id, intentId))
      .limit(1);
    if (found === undefined) throw notFound('No such intent');
    return found;
  }

  private async toPromotions(
    rows: (typeof schema.intentAutonomyPromotion.$inferSelect)[],
  ): Promise<Promotion[]> {
    const ids = [
      ...new Set(rows.flatMap((row) => [row.requestedBy, row.decidedBy ?? row.requestedBy])),
    ];
    const names = new Map<string, string>();
    for (const id of ids) {
      const [user] = await this.database.db
        .select({ name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, id))
        .limit(1);
      if (user !== undefined) names.set(id, user.name.trim().split(/\s+/)[0] ?? '');
    }
    return rows.map((row) => ({
      id: row.id,
      intentId: row.intentId,
      gateReportId: row.gateReportId,
      status: row.status as Promotion['status'],
      requestedBy: row.requestedBy,
      requestedByName: names.get(row.requestedBy) ?? null,
      requestedAt: row.requestedAt.toISOString(),
      requestReason: row.requestReason,
      decidedBy: row.decidedBy,
      decidedByName: row.decidedBy === null ? null : (names.get(row.decidedBy) ?? null),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionReason: row.decisionReason,
      selfApproved: row.selfApproved,
      appliedAt: row.appliedAt?.toISOString() ?? null,
    }));
  }

  async promotions(intentId: string): Promise<Promotion[]> {
    await this.intentExists(intentId);
    const rows = await this.database.db
      .select()
      .from(schema.intentAutonomyPromotion)
      .where(eq(schema.intentAutonomyPromotion.intentId, intentId))
      .orderBy(desc(schema.intentAutonomyPromotion.requestedAt))
      .limit(20);
    return this.toPromotions(rows);
  }

  async promotionState(intentId: string): Promise<AutonomyPromotionState> {
    await this.intentExists(intentId);
    const [report] = await readGateReports(this.database.db, intentId, 1);
    const open = (await this.promotions(intentId)).find(
      (promotion) => promotion.status === 'requested' || promotion.status === 'approved',
    );
    return {
      intentId,
      autosendFlag: this.autosendFlag,
      latestReport: report ?? null,
      openPromotion: open ?? null,
    };
  }

  async reports(intentId: string, limit: number): Promise<GateReport[]> {
    await this.intentExists(intentId);
    return readGateReports(this.database.db, intentId, limit);
  }

  /** A report on demand. It writes its own row and audit entry (the domain does), so the route has no `@Audited`. */
  async createReport(actor: Actor, intentId: string): Promise<GateReport> {
    await this.intentExists(intentId);
    const ctx = domainContext(this.domain, actor);
    const made = await translating(() =>
      generateGateReport(this.database.db, ctx, {
        intentId,
        trigger: 'on_demand',
        generatedBy: actor.id,
      }),
    );
    const [report] = await readGateReports(this.database.db, intentId, 1);
    if (report === undefined || report.id !== made.id) throw notFound('The report was not found');
    return report;
  }

  async requestPromotion(
    uow: UnitOfWork,
    actor: Actor,
    intentId: string,
    input: RequestPromotion,
  ): Promise<Promotion> {
    this.requireFlag();
    const created = await translating(async () =>
      settle(
        uow,
        await this.domain.autonomy.requestPromotion(uow.tx, domainContext(this.domain, actor), {
          intentId,
          gateReportId: input.gateReportId,
          reason: input.reason,
        }),
      ),
    );
    const [row] = await uow.tx
      .select()
      .from(schema.intentAutonomyPromotion)
      .where(eq(schema.intentAutonomyPromotion.id, created.promotionId))
      .limit(1);
    const [promotion] = row === undefined ? [] : await this.toPromotions([row]);
    if (promotion === undefined) throw notFound('The promotion was not found');
    return promotion;
  }

  /**
   * When the person last signed in (ADR-025 section 6): the creation time of the session behind this request.
   * A refresh does not move it, so it is a sign-in and not an activity time. Anything older than five minutes
   * is refused with `reauth_required`: the person signs in again (Google or whatever they use) and tries once more.
   */
  private async reauthAt(sessionId: string): Promise<Date> {
    const [session] = await this.database.db
      .select({ createdAt: schema.sessions.createdAt, revokedAt: schema.sessions.revokedAt })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .limit(1);
    if (session === undefined || session.revokedAt !== null) {
      throw new ApiHttpError(403, 'reauth_required', 'Sign in again to approve a promotion');
    }
    if (Date.now() - session.createdAt.getTime() > PROMOTION_REAUTH_SECONDS * 1000) {
      throw new ApiHttpError(
        403,
        'reauth_required',
        'Approving a promotion needs a sign-in within the last 5 minutes: sign in again, then approve',
      );
    }
    return session.createdAt;
  }

  async decidePromotion(
    uow: UnitOfWork,
    actor: Actor,
    sessionId: string,
    isOwner: boolean,
    promotionId: string,
    input: DecidePromotion,
  ): Promise<{ status: 'approved' | 'rejected' | 'cancelled' | 'expired'; selfApproved: boolean }> {
    if (input.approve) {
      if (!isOwner)
        throw new ApiHttpError(403, 'owner_only', 'Only the owner can approve a promotion');
      this.requireFlag();
    }
    const reauthAt = input.approve ? await this.reauthAt(sessionId) : undefined;
    return translating(async () =>
      settle(
        uow,
        await this.domain.autonomy.decidePromotion(uow.tx, domainContext(this.domain, actor), {
          promotionId,
          approve: input.approve,
          reason: input.reason,
          ...(input.approve ? { reauthAt, confirmKey: input.confirmKey } : {}),
        }),
      ),
    );
  }

  async applyPromotion(
    uow: UnitOfWork,
    actor: Actor,
    promotionId: string,
  ): Promise<{ status: 'applied' | 'expired' }> {
    this.requireFlag();
    return translating(async () =>
      settle(
        uow,
        await this.domain.autonomy.applyPromotion(uow.tx, domainContext(this.domain, actor), {
          promotionId,
        }),
      ),
    );
  }

  async setAutosend(
    uow: UnitOfWork,
    actor: Actor,
    intentId: string,
    input: SetIntentAutosend,
  ): Promise<{ changed: boolean; autosend: IntentAutosend }> {
    const result = await translating(async () =>
      settle(
        uow,
        await this.domain.autonomy.setAutosend(uow.tx, domainContext(this.domain, actor), {
          intentId,
          shadow: input.shadow,
          minScore: input.minScore,
          dailyCap: input.dailyCap,
          policy: input.policy,
          reason: input.reason,
        }),
      ),
    );
    const [row] = await uow.tx
      .select()
      .from(schema.intent)
      .where(eq(schema.intent.id, intentId))
      .limit(1);
    if (row === undefined) throw notFound('No such intent');
    return {
      changed: result.changed,
      autosend: {
        shadow: row.autosendShadow,
        minScore: Number(row.autosendMinScore),
        dailyCap: row.autosendDailyCap,
        policy: parseAutosendPolicy(row.autosendPolicy) ?? {
          channels: [],
          action: 'reply',
          maxChars: 1200,
        },
      },
    };
  }

  async disclosure(): Promise<AutosendDisclosure> {
    return (
      (await readAutosendDisclosure(this.database.db)) ?? {
        enabled: AUTOSEND_DISCLOSURE_DEFAULT.enabled,
        text: { ...AUTOSEND_DISCLOSURE_DEFAULT.text },
      }
    );
  }

  async setDisclosure(
    uow: UnitOfWork,
    actor: Actor,
    input: SetAutosendDisclosure,
  ): Promise<AutosendDisclosure> {
    await translating(async () =>
      settle(uow, await setAutosendDisclosure(uow.tx, domainContext(this.domain, actor), input)),
    );
    return {
      enabled: input.enabled,
      text: { th: input.text.th.trim(), en: input.text.en.trim() },
    };
  }

  /**
   * Every stage and pin change of one intent, newest first, with who made it (T-127 H6). A read for
   * display, so it stays in the api (ADR-009); the rows are written only by `set_intent_autonomy()`.
   */
  async history(intentId: string, query: AutonomyHistoryQuery): Promise<AutonomyHistoryPage> {
    const { intent, intentAutonomyHistory: history, users } = schema;
    const [found] = await this.database.db
      .select({ id: intent.id })
      .from(intent)
      .where(eq(intent.id, intentId))
      .limit(1);
    if (found === undefined) throw notFound('No such intent');

    const rows = await this.database.db
      .select({
        row: history,
        userName: users.name,
        sortKey: preciseTimestamp(history.changedAt),
      })
      .from(history)
      .leftJoin(users, eq(users.id, history.changedBy))
      .where(
        and(
          eq(history.intentId, intentId),
          query.cursor === undefined
            ? undefined
            : beforeCursor(history.changedAt, history.id, decodeCursor(query.cursor)),
        ),
      )
      .orderBy(desc(history.changedAt), desc(history.id))
      .limit(query.limit + 1);
    const page = toPage(
      rows.map((entry) => ({ ...entry, id: entry.row.id })),
      query.limit,
    );
    return {
      items: page.rows.map(({ row, userName }): AutonomyHistoryEntry => ({
        id: row.id,
        intentId: row.intentId,
        change: row.change as AutonomyHistoryEntry['change'],
        fromStage: row.fromStage,
        toStage: row.toStage,
        pinned: row.pinned,
        reason: row.reason,
        changedBy: row.changedBy,
        changedByName: userName,
        changedAt: row.changedAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
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
