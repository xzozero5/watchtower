import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { hmacJson } from '@watchtower/ai';
import { ConnectorRateLimitedError, type MetricSeries } from '@watchtower/connectors';
import { schema, type Database } from '@watchtower/db';
import { createHumanToolLedger, type HumanToolLedger } from '@watchtower/domain';
import {
  RATE_TOOL_NAMES,
  SERVICE_STATUS_SPARK,
  type ServiceStatus,
  type ServiceStatusList,
} from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { and, asc, desc, inArray, ne, sql } from 'drizzle-orm';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { budgetProject } from './tool-runner.service.js';
import { clientIsMock, TOOL_CLIENTS, type ToolClients } from './tool-clients.js';

type Alerting = ServiceStatus['alerts']['worstSeverity'];
const SEVERITY_RANK: Readonly<Record<NonNullable<Alerting>, number>> = {
  critical: 4,
  error: 3,
  warning: 2,
  info: 1,
  unknown: 0,
};

/** How long a service's numbers are reused. Keeps a refreshing screen from spending the quota. `[ASSUMED]` */
export const STATUS_METRICS_TTL_MS = 60_000;

type MetricsPart = ServiceStatus['metrics'];

const points = (series: MetricSeries | undefined): MetricsPart['errorRate'] =>
  (series?.points ?? []).map((point) => ({ t: point.t, v: point.v }));

/**
 * The service status panel of the ops view (R-5.7): for each active service of the catalog, its alert
 * state, the last 24 hours of error rate and p95 latency (30-minute steps), its last deploy and its
 * open incidents. Alerts, deploys and incidents are read from our own tables. The numbers come
 * through the metrics client, one request a service, each one taking a unit from the shared rate
 * window and leaving a `tool_execution` row; a service the budget refuses shows
 * `rate_limited`, never a guess (N5).
 */
@Injectable()
export class StatusPanel {
  private readonly ledger: HumanToolLedger;
  private readonly hashKey: string;
  private readonly cache = new Map<string, { at: number; metrics: MetricsPart }>();

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(TOOL_CLIENTS) private readonly clients: ToolClients,
    @Inject(APP_CONFIG) config: ApiConfig,
  ) {
    this.ledger = createHumanToolLedger({
      db: database.db,
      project: budgetProject(config.GCP_PROJECT_ID),
    });
    this.hashKey = deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.aiInputHash).toString('hex');
  }

  async list(now: Date = new Date()): Promise<ServiceStatusList> {
    const db = this.database.db;
    const services = await db
      .select({ id: schema.service.id, slug: schema.service.slug, name: schema.service.name })
      .from(schema.service)
      .where(sql`${schema.service.active}`)
      .orderBy(asc(schema.service.slug));
    const ids = services.map((service) => service.id);

    const alertRows =
      ids.length === 0
        ? []
        : await db
            .select({
              serviceId: schema.alert.serviceId,
              state: schema.alert.state,
              severity: schema.alert.severity,
            })
            .from(schema.alert)
            .where(and(inArray(schema.alert.serviceId, ids), ne(schema.alert.state, 'resolved')));
    const deployRows =
      ids.length === 0
        ? []
        : await db
            .selectDistinctOn([schema.deploy.serviceId], {
              serviceId: schema.deploy.serviceId,
              version: schema.deploy.version,
              env: schema.deploy.env,
              source: schema.deploy.source,
              at: schema.deploy.occurredAt,
            })
            .from(schema.deploy)
            .where(inArray(schema.deploy.serviceId, ids))
            .orderBy(schema.deploy.serviceId, desc(schema.deploy.occurredAt));
    const incidentRows =
      ids.length === 0
        ? []
        : await db
            .select({
              serviceId: schema.incidentService.serviceId,
              id: schema.incident.id,
              number: schema.incident.number,
              title: schema.incident.title,
              severity: schema.incident.severity,
              status: schema.incident.status,
            })
            .from(schema.incidentService)
            .innerJoin(schema.incident, sql`${schema.incident.id} = ${schema.incidentService.incidentId}`)
            .where(
              and(
                inArray(schema.incidentService.serviceId, ids),
                ne(schema.incident.status, 'resolved'),
              ),
            )
            .orderBy(asc(schema.incident.number));

    const items: ServiceStatus[] = [];
    for (const service of services) {
      const mine = alertRows.filter((row) => row.serviceId === service.id);
      const open = mine.filter((row) => row.state === 'open').length;
      const acknowledged = mine.filter((row) => row.state === 'acknowledged').length;
      let worst: Alerting = null;
      for (const row of mine) {
        const severity = row.severity as NonNullable<Alerting>;
        if (worst === null || SEVERITY_RANK[severity] > SEVERITY_RANK[worst]) worst = severity;
      }
      const deploy = deployRows.find((row) => row.serviceId === service.id);
      items.push({
        id: service.id,
        slug: service.slug,
        name: service.name,
        alerts: { open, acknowledged, worstSeverity: worst },
        state: open > 0 ? 'alerting' : acknowledged > 0 ? 'acknowledged' : 'ok',
        metrics: await this.metricsOf(service.slug, now),
        lastDeploy:
          deploy?.at == null
            ? null
            : {
                version: deploy.version,
                env: deploy.env,
                at: deploy.at.toISOString(),
                source: deploy.source,
              },
        openIncidents: incidentRows
          .filter((row) => row.serviceId === service.id)
          .map((row) => ({
            id: row.id,
            number: row.number,
            title: row.title,
            severity: row.severity,
            status: row.status,
          })),
      });
    }
    return {
      generatedAt: now.toISOString(),
      windowHours: SERVICE_STATUS_SPARK.windowHours,
      stepMinutes: SERVICE_STATUS_SPARK.stepMinutes,
      items,
    };
  }

  private async metricsOf(slug: string, now: Date): Promise<MetricsPart> {
    const empty = (status: MetricsPart['status'], mock: boolean): MetricsPart => ({
      status,
      mock,
      errorRate: [],
      latencyP95Ms: [],
    });
    const client = this.clients.metrics;
    if (client === undefined) return empty('not_connected', true);
    const mock = clientIsMock(client);
    const cached = this.cache.get(slug);
    if (cached !== undefined && now.getTime() - cached.at < STATUS_METRICS_TTL_MS) {
      return cached.metrics;
    }
    const from = new Date(now.getTime() - SERVICE_STATUS_SPARK.windowHours * 3_600_000);
    const decision = await this.ledger.begin({
      runKey: randomUUID(),
      ticketId: null,
      agent: 'status_panel',
      tool: RATE_TOOL_NAMES.metrics,
      inputHash: hmacJson(this.hashKey, { service: slug, windowHours: SERVICE_STATUS_SPARK.windowHours }),
      mock,
      actor: 'system',
    });
    if (!decision.allowed) return empty('rate_limited', mock);
    const started = Date.now();
    try {
      const { series } = await client.queryTimeSeries({
        service: slug,
        metrics: ['error_rate', 'latency_p95_ms'],
        from,
        to: now,
        stepSeconds: SERVICE_STATUS_SPARK.stepMinutes * 60,
      });
      await this.ledger.finish(decision.id, {
        status: 'ok',
        errorCode: null,
        latencyMs: Date.now() - started,
        resultCount: series.reduce((sum, one) => sum + one.points.length, 0),
      });
      const metrics: MetricsPart = {
        status: 'ok',
        mock,
        errorRate: points(series.find((one) => one.metric === 'error_rate')),
        latencyP95Ms: points(series.find((one) => one.metric === 'latency_p95_ms')),
      };
      this.cache.set(slug, { at: now.getTime(), metrics });
      return metrics;
    } catch (error) {
      await this.ledger.finish(decision.id, {
        status: 'error',
        errorCode: error instanceof Error ? error.name : 'UnknownError',
        latencyMs: Date.now() - started,
        resultCount: null,
      });
      return empty(error instanceof ConnectorRateLimitedError ? 'rate_limited' : 'error', mock);
    }
  }
}
