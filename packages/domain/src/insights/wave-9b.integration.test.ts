import { randomUUID } from 'node:crypto';

import { createDatabase, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { insightFactsResultSchema } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildAdminAiFacts,
  buildAdminIntegrationsFacts,
  buildAdminIntentGateFacts,
  buildAdminIntentsFacts,
  buildAdminOutboxFacts,
  buildAdminQueuesFacts,
  buildAlertsServicesFacts,
  buildDashboardAiFacts,
  buildDashboardGradesFacts,
  buildDashboardOpsNowFacts,
  buildDashboardQualityFacts,
  buildDashboardReliabilityFacts,
  buildDashboardServicesFacts,
  buildDashboardTeamFacts,
  buildDashboardUsageFacts,
  buildHomeStatusFacts,
  buildIncidentDetailFacts,
  buildOrgHealthFacts,
  buildQueueListFacts,
  buildReportsAiCostFacts,
  buildReportsCeoFiguresFacts,
  buildStatuspageAdminFacts,
} from './index.js';

const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase | undefined;
let database: Database | undefined;

beforeAll(async () => {
  testDb = await createTestDatabase(ADMIN_URL);
  database = createDatabase({ url: testDb.appUrl, max: 6, applicationName: 'wt-domain-9b-test' });
}, 30_000);

afterAll(async () => {
  if (database) await database.pool.end().catch(() => undefined);
  if (testDb) await testDb.cleanup().catch(() => undefined);
}, 30_000);

describe('Wave 9b Facts Builders Integration (T-420)', () => {
  it('buildHomeStatusFacts produces valid facts reflecting intent stages and kill switch', async () => {
    if (!database) throw new Error('database not initialized');
    const executor = database.db;
    const res = await buildHomeStatusFacts({ executor });
    expect(insightFactsResultSchema.safeParse(res).success).toBe(true);
    expect(res.facts.map((f) => f.id)).toEqual([
      'active_intents',
      'stage_2_intents',
      'stage_3_intents',
      'kill_switch',
      'autonomy_state',
    ]);
  });

  it('buildQueueListFacts reflects viewer assigned vs unassigned open tickets', async () => {
    if (!database || !testDb) throw new Error('database not initialized');
    const executor = database.db;
    const userId = randomUUID();

    // Insert user, org, and tickets
    await testDb.owner.pool.query(
      `INSERT INTO users (id, email, name, role) VALUES ($1, 'staff@test.com', 'Staff', 'agent')`,
      [userId],
    );
    const [org] = await testDb.owner.pool
      .query<{ id: string }>(`INSERT INTO organization (name) VALUES ('Test Org') RETURNING id`)
      .then((r) => r.rows);
    if (!org) throw new Error('org insert failed');

    await testDb.owner.pool.query(
      `INSERT INTO ticket (org_id, assignee_id, subject, status, channel, priority)
       VALUES ($1, $2, 'Test 1', 'open', 'portal', 'P3'),
              ($1, NULL, 'Test 2', 'open', 'portal', 'P3')`,
      [org.id, userId],
    );

    const res = await buildQueueListFacts({
      executor,
      subjectUserId: userId,
    });
    expect(insightFactsResultSchema.safeParse(res).success).toBe(true);
    const myOpen = res.facts.find((f) => f.id === 'my_open');
    const unassignedOpen = res.facts.find((f) => f.id === 'unassigned_open');
    expect(myOpen?.value).toBeGreaterThanOrEqual(1);
    expect(unassignedOpen?.value).toBeGreaterThanOrEqual(1);

    // Masked view removes customer refs
    const masked = await buildQueueListFacts({
      executor,
      subjectUserId: userId,
      view: 'masked',
    });
    expect(masked.facts.some((f) => f.ref?.kind === 'org' || f.ref?.kind === 'contact')).toBe(
      false,
    );
  });

  it('buildDashboardOpsNowFacts produces current operational snapshot', async () => {
    if (!database) throw new Error('database not initialized');
    const executor = database.db;
    const res = await buildDashboardOpsNowFacts({ executor });
    expect(insightFactsResultSchema.safeParse(res).success).toBe(true);
    expect(res.facts.map((f) => f.id)).toContain('open_tickets');
    expect(res.facts.map((f) => f.id)).toContain('open_incidents');
    expect(res.facts.map((f) => f.id)).toContain('firing_alerts');
    expect(res.facts.map((f) => f.id)).toContain('ops_now_state');
  });

  it('buildDashboardReliabilityFacts and buildDashboardServicesFacts summarize incidents and services', async () => {
    if (!database) throw new Error('database not initialized');
    const executor = database.db;
    const rel = await buildDashboardReliabilityFacts({ executor, days: 30 });
    expect(insightFactsResultSchema.safeParse(rel).success).toBe(true);
    expect(rel.facts.map((f) => f.id)).toContain('total_incidents');

    const srv = await buildDashboardServicesFacts({ executor, days: 30 });
    expect(insightFactsResultSchema.safeParse(srv).success).toBe(true);
    expect(srv.facts.map((f) => f.id)).toContain('total_services');
    expect(srv.facts.map((f) => f.id)).toContain('catalog_state');
  });

  it('buildDashboardQualityFacts reads CSAT surveys excluding seeds', async () => {
    if (!database) throw new Error('database not initialized');
    const executor = database.db;
    const quality = await buildDashboardQualityFacts({ executor, days: 30 });
    expect(insightFactsResultSchema.safeParse(quality).success).toBe(true);
    expect(quality.facts.map((f) => f.id)).toEqual([
      'window_days',
      'csat_answered',
      'csat_avg',
      'csat_good_pct',
    ]);
  });

  it('buildDashboardAiFacts and buildDashboardGradesFacts summarize AI telemetry', async () => {
    if (!database) throw new Error('database not initialized');
    const executor = database.db;
    const aiFacts = await buildDashboardAiFacts({ executor, days: 30 });
    expect(insightFactsResultSchema.safeParse(aiFacts).success).toBe(true);
    expect(aiFacts.facts.map((f) => f.id)).toContain('total_runs');
    expect(aiFacts.facts.map((f) => f.id)).toContain('cost_usd');

    const grades = await buildDashboardGradesFacts({ executor, days: 30 });
    expect(insightFactsResultSchema.safeParse(grades).success).toBe(true);
    expect(grades.facts.map((f) => f.id)).toContain('total_graded');
    expect(grades.facts.map((f) => f.id)).toContain('verified_pct');
  });

  it('buildDashboardTeamFacts limits staff and adheres to factual PII rules', async () => {
    if (!database) throw new Error('database not initialized');
    const executor = database.db;
    const team = await buildDashboardTeamFacts({ executor, days: 30 });
    expect(insightFactsResultSchema.safeParse(team).success).toBe(true);
    expect(team.facts.map((f) => f.id)).toContain('team_members_count');
    // Ensure no ranking or comparative facts
    expect(team.facts.some((f) => f.id.includes('rank') || f.id.includes('top'))).toBe(false);
  });

  it('buildDashboardUsageFacts reads telemetry points and anomalies', async () => {
    if (!database) throw new Error('database not initialized');
    const executor = database.db;
    const usage = await buildDashboardUsageFacts({ executor, days: 30 });
    expect(insightFactsResultSchema.safeParse(usage).success).toBe(true);
    expect(usage.facts.map((f) => f.id)).toEqual([
      'window_days',
      'active_metrics',
      'total_points',
      'anomalies_count',
      'proactive_tickets',
    ]);
  });

  it('buildReportsAiCostFacts and buildReportsCeoFiguresFacts produce reports facts', async () => {
    if (!database) throw new Error('database not initialized');
    const executor = database.db;
    const aiCost = await buildReportsAiCostFacts({ executor, days: 30 });
    expect(insightFactsResultSchema.safeParse(aiCost).success).toBe(true);
    expect(aiCost.facts.map((f) => f.id)).toContain('total_runs');
    expect(aiCost.facts.map((f) => f.id)).toContain('cost_usd');

    const ceo = await buildReportsCeoFiguresFacts({ executor, isoWeek: '2026-W45' });
    expect(insightFactsResultSchema.safeParse(ceo).success).toBe(true);
    expect(ceo.facts.map((f) => f.id)).toEqual([
      'week_number',
      'total_tickets',
      'resolved_tickets',
      'verified_ai_share',
      'incidents_count',
    ]);
  });

  it('buildIncidentDetailFacts, buildAlertsServicesFacts, and buildStatuspageAdminFacts summarize ops', async () => {
    if (!database || !testDb) throw new Error('database not initialized');
    const executor = database.db;

    // Create a test incident
    const [inc] = await testDb.owner.pool
      .query<{ id: string }>(
        `INSERT INTO incident (title, severity, status) VALUES ('Test Outage', 'SEV2', 'investigating') RETURNING id`,
      )
      .then((r) => r.rows);
    if (!inc) throw new Error('incident insert failed');

    const detail = await buildIncidentDetailFacts({ executor, incidentId: inc.id });
    expect(insightFactsResultSchema.safeParse(detail).success).toBe(true);
    expect(detail.facts.map((f) => f.id)).toContain('severity');
    expect(detail.facts.map((f) => f.id)).toContain('duration_minutes');
    expect(detail.facts.find((f) => f.id === 'severity')?.value).toBe('SEV2');

    const alertsServices = await buildAlertsServicesFacts({ executor });
    expect(insightFactsResultSchema.safeParse(alertsServices).success).toBe(true);
    expect(alertsServices.facts.map((f) => f.id)).toContain('total_services');

    const statuspage = await buildStatuspageAdminFacts({ executor });
    expect(insightFactsResultSchema.safeParse(statuspage).success).toBe(true);
    expect(statuspage.facts.map((f) => f.id)).toContain('total_components');
  });

  it('buildOrgHealthFacts summarizes organization profile and drops refs when masked', async () => {
    if (!database || !testDb) throw new Error('database not initialized');
    const executor = database.db;
    const [org] = await testDb.owner.pool
      .query<{ id: string }>(`INSERT INTO organization (name) VALUES ('Health Org') RETURNING id`)
      .then((r) => r.rows);
    if (!org) throw new Error('org insert failed');

    const full = await buildOrgHealthFacts({ executor, orgId: org.id, days: 30 });
    expect(insightFactsResultSchema.safeParse(full).success).toBe(true);
    expect(full.facts.map((f) => f.id)).toContain('open_tickets');
    expect(full.facts.find((f) => f.id === 'open_tickets')?.ref?.kind).toBe('org');

    const masked = await buildOrgHealthFacts({ executor, orgId: org.id, days: 30, view: 'masked' });
    expect(masked.facts.find((f) => f.id === 'open_tickets')?.ref).toBeUndefined();
  });

  it('admin facts builders produce factual numbers and avoid advising promotion', async () => {
    if (!database || !testDb) throw new Error('database not initialized');
    const executor = database.db;
    const [intent] = await testDb.owner.pool
      .query<{ id: string }>(
        `INSERT INTO intent (key, name, autonomy_stage) VALUES ('intent_adm', 'Admin Intent', 2) RETURNING id`,
      )
      .then((r) => r.rows);
    if (!intent) throw new Error('intent insert failed');

    const adminIntent = await buildAdminIntentsFacts({ executor, intentId: intent.id });
    expect(insightFactsResultSchema.safeParse(adminIntent).success).toBe(true);
    expect(adminIntent.facts.map((f) => f.id)).toContain('autonomy_stage');
    expect(adminIntent.facts.map((f) => f.id)).toContain('tickets_28d');

    const gate = await buildAdminIntentGateFacts({ executor, intentId: intent.id });
    expect(insightFactsResultSchema.safeParse(gate).success).toBe(true);
    expect(gate.facts.map((f) => f.id)).toContain('gate_status');
    expect(gate.facts.find((f) => f.id === 'gate_status')?.value).toBe('none');

    const adminAi = await buildAdminAiFacts({ executor });
    expect(insightFactsResultSchema.safeParse(adminAi).success).toBe(true);
    expect(adminAi.facts.map((f) => f.id)).toContain('kill_switch');

    const integrations = await buildAdminIntegrationsFacts({ executor });
    expect(insightFactsResultSchema.safeParse(integrations).success).toBe(true);
    expect(integrations.facts.map((f) => f.id)).toContain('total_accounts');

    const outbox = await buildAdminOutboxFacts({ executor });
    expect(insightFactsResultSchema.safeParse(outbox).success).toBe(true);
    expect(outbox.facts.map((f) => f.id)).toContain('pending_jobs');

    const queues = await buildAdminQueuesFacts({ executor });
    expect(insightFactsResultSchema.safeParse(queues).success).toBe(true);
    expect(queues.facts.map((f) => f.id)).toContain('outbox_pending');
  });
});
