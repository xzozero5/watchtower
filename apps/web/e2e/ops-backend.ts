import type { Role } from '@watchtower/shared';
import type { Page } from '@playwright/test';

import { makeTicket, uuid } from '../src/test/fixtures';
import {
  alert,
  alertDetail,
  changes,
  comm,
  escalation,
  heartbeat,
  incidentDetail,
  policy,
  preview,
  publicStatus,
  service,
  statusComponent,
  statusPost,
} from '../src/test/ops-fixtures';

import { type BackendOptions, mockBackend } from './backend';

type Routes = NonNullable<BackendOptions['routes']>;

export interface OpsBackendOptions {
  role?: Role;
  /** `false`: the status page is switched off on this instance, so every public route answers 404. */
  statusPageOpen?: boolean;
  /** Customers an update would reach right now. */
  recipients?: number;
}

export const ALERT_CRITICAL = alert(1);
export const ALERT_UNMAPPED = alert(2, {
  serviceId: null,
  severity: 'unknown',
  title: 'Disk almost full on batch-7',
  source: 'alertmanager',
});
export const INCIDENT_ID = incidentDetail().id;
export const PUBLIC_TOKEN = 'abcdefghij-0123456789.signature';

const errorBody = (statusCode: number, code: string) => ({
  statusCode,
  error: 'Error',
  code,
  message: code,
});

/**
 * The ops screens' api, kept in memory so each write shows in the next read, as the api would:
 * acknowledging changes the alert, drafting adds a draft, and sending refuses with 409 unless the
 * confirmed count equals the audience now. Invented names and example.com only (N1).
 */
export async function mockOps(page: Page, options: OpsBackendOptions = {}) {
  const role = options.role ?? 'lead';
  const open = options.statusPageOpen ?? true;
  const state = {
    acked: new Set<string>(),
    recipients: options.recipients ?? 7,
    comms: [comm()],
    sent: null as null | { confirmed: number },
  };

  const current = (base: ReturnType<typeof alert>) =>
    state.acked.has(base.id)
      ? {
          ...base,
          state: 'acknowledged' as const,
          ackedAt: '2026-11-02T03:00:00.000Z',
          ackedVia: 'web' as const,
          nextEscalationAt: null,
        }
      : base;
  const all = () => [current(ALERT_CRITICAL), current(ALERT_UNMAPPED)];

  const routes: Routes = {
    'GET /v1/alerts': (request) => {
      const search = new URLSearchParams(request.search);
      let items = all();
      if (search.get('state') === 'open') items = items.filter((a) => a.state === 'open');
      if (search.get('unmapped') === 'true') items = items.filter((a) => a.serviceId === null);
      return { json: { items, nextCursor: null } };
    },
    'GET /v1/alerts/correlations': () => ({ json: { items: [] } }),
    'GET /v1/services': () => ({ json: { items: [service()] } }),
    'GET /v1/escalation-policies': () => ({ json: { items: [policy()] } }),
    'GET /v1/incidents': () => ({
      json: {
        items: [
          {
            ...incidentDetail(),
            timeline: undefined,
            ticketIds: undefined,
            alertIds: undefined,
          },
        ],
        nextCursor: null,
      },
    }),
    [`GET /v1/incidents/${INCIDENT_ID}`]: () => ({ json: incidentDetail() }),
    [`GET /v1/incidents/${INCIDENT_ID}/changes`]: () => ({ json: changes() }),
    [`GET /v1/incidents/${INCIDENT_ID}/comms`]: () => ({ json: { items: state.comms } }),
    [`GET /v1/incidents/${INCIDENT_ID}/comms/preview`]: () => ({
      json: preview({ recipients: state.recipients }),
    }),
    [`POST /v1/incidents/${INCIDENT_ID}/comms`]: (request) => {
      const created = comm({
        id: uuid(7801 + state.comms.length),
        body: (request.body as { body: string }).body,
      });
      state.comms = [created, ...state.comms];
      return { status: 201, json: created };
    },
    'GET /v1/heartbeats': () => ({ json: { items: [heartbeat()] } }),
    'GET /v1/assignees': () => ({ json: { assignees: [] } }),
    // Staff side of the status page.
    'GET /v1/status-page/components': () => ({
      json: { items: [statusComponent(1), statusComponent(2, { public: false })] },
    }),
    'GET /v1/status-page/posts': () => ({ json: { items: [statusPost(1)], nextCursor: null } }),
    'GET /v1/status-page/maintenance': () => ({ json: { items: [] } }),
    'GET /v1/status-page/subscribers': () => ({
      json: { pending: 1, confirmed: 12, unsubscribed: 3 },
    }),
  };

  for (const base of [ALERT_CRITICAL, ALERT_UNMAPPED]) {
    routes[`GET /v1/alerts/${base.id}`] = () => ({
      json: { ...alertDetail(0), ...current(base) },
    });
    routes[`GET /v1/alerts/${base.id}/escalations`] = () => ({
      json: { items: [escalation()] },
    });
    routes[`POST /v1/alerts/${base.id}/ack`] = () => {
      const changed = !state.acked.has(base.id);
      state.acked.add(base.id);
      return { json: { changed, alert: { ...alertDetail(0), ...current(base) } } };
    };
  }

  for (const item of [comm(), comm({ id: uuid(7801) }), comm({ id: uuid(7802) })]) {
    routes[`POST /v1/incidents/${INCIDENT_ID}/comms/${item.id}/send`] = (request) => {
      const confirmed = (request.body as { confirmRecipients: number }).confirmRecipients;
      if (confirmed !== state.recipients) {
        return { status: 409, json: errorBody(409, 'conflict') };
      }
      state.sent = { confirmed };
      state.comms = state.comms.map((c) =>
        c.id === item.id ? { ...c, status: 'sent' as const, confirmedRecipients: confirmed } : c,
      );
      return { json: { recipients: confirmed, sent: confirmed, failed: 0 } };
    };
  }

  // The public status page. Closed by default on a real instance: every route is 404 then.
  const closed = () => ({ status: 404, json: errorBody(404, 'not_found') });
  routes['GET /v1/status'] = () => (open ? { json: publicStatus() } : closed());
  routes['GET /v1/status/history'] = () =>
    open ? { json: { days: 90, posts: [], maintenance: [] } } : closed();
  routes['POST /v1/status/subscriptions'] = () =>
    open ? { status: 202, json: { status: 'check_your_email' } } : closed();
  routes['POST /v1/status/subscriptions/confirm'] = () =>
    open ? { json: { status: 'confirmed' } } : closed();
  routes['POST /v1/status/subscriptions/unsubscribe'] = () =>
    open ? { json: { status: 'unsubscribed' } } : closed();

  const backend = await mockBackend(page, {
    role,
    tickets: [
      makeTicket(1, { subject: 'Cannot check out', priority: 'P1' }),
      makeTicket(2, { subject: 'Payment page is slow', priority: 'P2' }),
    ],
    routes,
  });
  return { ...backend, state };
}
