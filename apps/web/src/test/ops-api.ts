import type { Role } from '@watchtower/shared';

import { makeSession } from './fixtures';
import { type MockHandler, mockApi } from './mock-api';
import {
  alert,
  alertDetail,
  comm,
  escalation,
  heartbeat,
  incidentDetail,
  policy,
  preview,
  service,
  statusComponent,
  changes,
} from './ops-fixtures';

export interface OpsApiOptions {
  role?: Role;
  overrides?: Record<string, MockHandler>;
}

/**
 * Every read the ops screens make, answered with the fixtures. A test overrides only what it is
 * about; `overrides` win. Stubs `fetch`.
 */
export function opsApi({ role = 'lead', overrides = {} }: OpsApiOptions = {}) {
  const detail = incidentDetail();
  const defaults: Record<string, MockHandler> = {
    'GET /health': { json: { status: 'ok' } },
    'GET /v1/auth/session': { json: makeSession(role) },
    'GET /v1/alerts': {
      json: { items: [alert(1), alert(2, { severity: 'warning' })], nextCursor: null },
    },
    'GET /v1/alerts/correlations': { json: { items: [] } },
    'GET /v1/alerts/noise': { json: { windowDays: 7, items: [] } },
    'GET /v1/alerts/:id': ({ params }) => ({
      json: alertDetail(Number(params.id.slice(-4)) - 7000),
    }),
    'GET /v1/alerts/:id/escalations': { json: { items: [escalation()] } },
    'GET /v1/services': { json: { items: [service()] } },
    'GET /v1/escalation-policies': { json: { items: [policy()] } },
    'GET /v1/heartbeats': { json: { items: [heartbeat()] } },
    'GET /v1/incidents': {
      json: {
        items: [
          {
            id: detail.id,
            number: detail.number,
            key: detail.key,
            title: detail.title,
            severity: detail.severity,
            status: detail.status,
            commanderId: null,
            rootCause: null,
            discordThreadState: 'mock',
            startedAt: detail.startedAt,
            resolvedAt: null,
            serviceIds: detail.serviceIds,
            orgIds: [],
            tickets: 2,
            alerts: 1,
          },
        ],
        nextCursor: null,
      },
    },
    'GET /v1/incidents/:id': { json: detail },
    'GET /v1/incidents/:id/changes': { json: changes() },
    'GET /v1/incidents/:id/comms': { json: { items: [comm()] } },
    'GET /v1/incidents/:id/comms/preview': { json: preview() },
    'GET /v1/status-page/components': { json: { items: [statusComponent(1), statusComponent(2)] } },
    'GET /v1/status-page/posts': { json: { items: [], nextCursor: null } },
    'GET /v1/status-page/maintenance': { json: { items: [] } },
    'GET /v1/status-page/subscribers': { json: { pending: 1, confirmed: 12, unsubscribed: 3 } },
    'GET /v1/assignees': { json: { assignees: [] } },
  };
  return mockApi({
    ...overrides,
    ...Object.fromEntries(Object.entries(defaults).filter(([key]) => !(key in overrides))),
  });
}
