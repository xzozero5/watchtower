import { Inject, Injectable } from '@nestjs/common';
import { orgScopeCondition, schema, type Database } from '@watchtower/db';
import type { Actor } from '@watchtower/domain';
import {
  HEALTH_COMPONENT_KEYS,
  HEALTH_FORMULA_VERSION,
  healthComponentSchema,
  type CreateMetric,
  type HealthSnapshot,
  type Metric,
  type OrgScope,
  type PointsQuery,
  type UpdateMetric,
} from '@watchtower/shared';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';

import { notFound } from '../auth/http-errors.js';
import { DATABASE } from '../database/database.module.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';

type MetricRow = typeof schema.usageMetricDef.$inferSelect;
const iso = (date: Date): string => date.toISOString();

/**
 * Usage metrics, anomalies and the Client Health Score for staff (T-205). Reads shape rows into DTOs; every
 * read that can touch an organization's rows passes the caller's scope through `orgScopeCondition`, so a
 * client-scoped principal (who holds none of these permissions anyway) could never see another's. Writes go
 * through `@watchtower/domain`, which allows only a signed-in person and writes the audit row.
 */
@Injectable()
export class UsageService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

  async listMetrics(includeTemplate: boolean): Promise<Metric[]> {
    const rows = await this.database.db
      .select()
      .from(schema.usageMetricDef)
      .orderBy(asc(schema.usageMetricDef.key));
    return rows.map((row) => this.toMetric(row, includeTemplate));
  }

  async getMetric(id: string, includeTemplate: boolean): Promise<Metric> {
    const [row] = await this.database.db
      .select()
      .from(schema.usageMetricDef)
      .where(eq(schema.usageMetricDef.id, id))
      .limit(1);
    if (row === undefined) throw notFound('No such metric');
    return this.toMetric(row, includeTemplate);
  }

  async createMetric(actor: Actor, input: CreateMetric): Promise<Metric> {
    const { id } = await translating(() =>
      this.uow.run(async (uow) =>
        settle(uow, await this.domain.usage.createMetric(uow.tx, domainContext(this.domain, actor), input)),
      ),
    );
    return this.getMetric(id, true);
  }

  async updateMetric(actor: Actor, id: string, input: UpdateMetric): Promise<Metric> {
    await translating(() =>
      this.uow.run(async (uow) =>
        settle(
          uow,
          await this.domain.usage.updateMetric(uow.tx, domainContext(this.domain, actor), id, input),
        ),
      ),
    );
    return this.getMetric(id, true);
  }

  async points(id: string, query: PointsQuery, scope: OrgScope) {
    await this.getMetric(id, false);
    const rows = await this.database.db
      .select({
        ts: schema.usageMetricPoint.ts,
        orgId: schema.usageMetricPoint.orgId,
        dims: schema.usageMetricPoint.dims,
        value: schema.usageMetricPoint.value,
      })
      .from(schema.usageMetricPoint)
      .where(
        and(
          eq(schema.usageMetricPoint.metricId, id),
          orgScopeCondition(schema.usageMetricPoint.orgId, scope),
          query.orgId === undefined ? undefined : eq(schema.usageMetricPoint.orgId, query.orgId),
          query.from === undefined ? undefined : gte(schema.usageMetricPoint.ts, new Date(query.from)),
          query.to === undefined ? undefined : lte(schema.usageMetricPoint.ts, new Date(query.to)),
        ),
      )
      .orderBy(desc(schema.usageMetricPoint.ts))
      .limit(query.limit);
    return rows.map((row) => ({
      ts: iso(row.ts),
      orgId: row.orgId,
      dims: row.dims as Record<string, string>,
      value: row.value,
    }));
  }

  async anomalies(limit: number, scope: OrgScope) {
    const rows = await this.database.db
      .select({ anomaly: schema.usageAnomaly, key: schema.usageMetricDef.key })
      .from(schema.usageAnomaly)
      .innerJoin(schema.usageMetricDef, eq(schema.usageMetricDef.id, schema.usageAnomaly.metricId))
      .where(orgScopeCondition(schema.usageAnomaly.orgId, scope))
      .orderBy(desc(schema.usageAnomaly.createdAt), desc(schema.usageAnomaly.id))
      .limit(limit);
    return rows.map(({ anomaly, key }) => ({
      id: anomaly.id,
      metricId: anomaly.metricId,
      metricKey: key,
      orgId: anomaly.orgId,
      dims: anomaly.dims as Record<string, string>,
      bucketTs: iso(anomaly.bucketTs),
      observed: anomaly.observed,
      baseline: anomaly.baseline,
      baselineSamples: anomaly.baselineSamples,
      alertId: anomaly.alertId,
      ticketId: anomaly.ticketId,
      createdAt: iso(anomaly.createdAt),
    }));
  }

  /** The latest stored snapshot of one organization under the current formula, or null when none was computed. */
  async orgHealth(orgId: string, scope: OrgScope): Promise<HealthSnapshot | null> {
    const [row] = await this.database.db
      .select()
      .from(schema.orgHealthSnapshot)
      .where(
        and(
          eq(schema.orgHealthSnapshot.orgId, orgId),
          eq(schema.orgHealthSnapshot.formulaVersion, HEALTH_FORMULA_VERSION),
          orgScopeCondition(schema.orgHealthSnapshot.orgId, scope),
        ),
      )
      .orderBy(desc(schema.orgHealthSnapshot.day))
      .limit(1);
    if (row === undefined) return null;
    const stored = row.components as Record<string, unknown>;
    return {
      orgId: row.orgId,
      day: row.day,
      formulaVersion: row.formulaVersion,
      status: row.status as HealthSnapshot['status'],
      score: row.score,
      components: HEALTH_COMPONENT_KEYS.map((key) => healthComponentSchema.parse(stored[key])),
    };
  }

  /**
   * The latest snapshot of each organization, lowest score first (the ones to look at), organizations with
   * no score last. Each row says only about its own organization: there is no rank, share or average in it.
   */
  async healthList(limit: number, scope: OrgScope) {
    const latest = this.database.db
      .selectDistinctOn([schema.orgHealthSnapshot.orgId], {
        orgId: schema.orgHealthSnapshot.orgId,
        day: schema.orgHealthSnapshot.day,
        status: schema.orgHealthSnapshot.status,
        score: schema.orgHealthSnapshot.score,
      })
      .from(schema.orgHealthSnapshot)
      .where(
        and(
          eq(schema.orgHealthSnapshot.formulaVersion, HEALTH_FORMULA_VERSION),
          orgScopeCondition(schema.orgHealthSnapshot.orgId, scope),
        ),
      )
      .orderBy(schema.orgHealthSnapshot.orgId, desc(schema.orgHealthSnapshot.day))
      .as('latest');
    const rows = await this.database.db
      .select()
      .from(latest)
      .orderBy(sql`${latest.score} ASC NULLS LAST`, asc(latest.orgId))
      .limit(limit);
    return rows.map((row) => ({
      orgId: row.orgId,
      day: row.day,
      status: row.status as HealthSnapshot['status'],
      score: row.score,
    }));
  }

  private toMetric(row: MetricRow, includeTemplate: boolean): Metric {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      sqlTemplate: includeTemplate ? row.sqlTemplate : null,
      templateVersion: row.templateVersion,
      dims: row.dims,
      unit: row.unit,
      refreshIntervalSeconds: row.refreshIntervalSeconds,
      direction: row.direction as Metric['direction'],
      anomalyRatio: Number(row.anomalyRatio),
      anomalyMinAbs: Number(row.anomalyMinAbs),
      active: row.active,
      lastRunAt: row.lastRunAt === null ? null : iso(row.lastRunAt),
      lastRunState: row.lastRunState as Metric['lastRunState'],
      lastRunError: row.lastRunError,
      lastRunPoints: row.lastRunPoints,
    };
  }
}
