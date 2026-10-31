import {
  auditLogPageSchema,
  contactPageSchema,
  contactSchema,
  forceLogoutResultSchema,
  intentAutonomyChangeSchema,
  intentSchema,
  organizationPageSchema,
  organizationSchema,
  slaPolicyListSchema,
  slaPolicySchema,
  teamQueueSchema,
  userListSchema,
  userSchema,
  type AuditLogQuery,
  type CreateBusinessCalendar,
  type CreateContact,
  type CreateOrganization,
  type CreateSlaPolicy,
  type CreateTeamQueue,
  type CreateUser,
  type OrganizationListQuery,
  type SetAiSwitch,
  type SetIntentAutonomy,
  type UpdateBusinessCalendar,
  type UpdateContact,
  type UpdateIntent,
  type UpdateOrganization,
  type UpdateSlaPolicy,
  type UpdateTeamQueue,
  type UpdateUser,
} from '@watchtower/shared';
import {
  autonomyHistorySchema,
  autonomyViewSchema,
  calendarViewListSchema,
  calendarViewSchema,
  readinessViewSchema,
  setSwitchResultViewSchema,
  ticketStatsSchema,
} from '@/lib/admin/contracts';

import type { ApiClient, QueryParams } from './client';

const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

/**
 * The endpoints of the head console: Home counts, users, organizations, contacts, SLA, calendars,
 * intents, queues, the AI controls and the audit log. Same rule as `createEndpoints`: one function
 * per endpoint, no component builds a URL.
 */
export function createAdminEndpoints(client: ApiClient) {
  const id = (value: string) => encodeURIComponent(value);

  return {
    // --- Home ---
    /** Counts for the head home. `[ASSUMED]` contract H2 in docs/06-UI-SPEC.md section 18.9. */
    ticketStats: (params: QueryParams, signal?: AbortSignal) =>
      client.request({
        path: '/v1/tickets/stats',
        query: params,
        schema: ticketStatsSchema,
        ...withSignal(signal),
      }),

    /** Postgres and Redis readiness. A 503 rejects, which the UI shows as "not responding". */
    ready: (signal?: AbortSignal) =>
      client.request({
        path: '/health/ready',
        schema: readinessViewSchema,
        retryOnUnauthenticated: false,
        ...withSignal(signal),
      }),

    // --- AI controls ---
    autonomy: (signal?: AbortSignal) =>
      client.request({ path: '/v1/autonomy', schema: autonomyViewSchema, ...withSignal(signal) }),

    setAiSwitch: (body: SetAiSwitch) =>
      client.request({
        method: 'POST',
        path: '/v1/autonomy/switches',
        body,
        schema: setSwitchResultViewSchema,
      }),

    setIntentAutonomy: (intentId: string, body: SetIntentAutonomy) =>
      client.request({
        method: 'POST',
        path: `/v1/intents/${id(intentId)}/autonomy`,
        body,
        schema: intentAutonomyChangeSchema,
      }),

    intentAutonomyHistory: (intentId: string, signal?: AbortSignal) =>
      client.request({
        path: `/v1/intents/${id(intentId)}/autonomy/history`,
        schema: autonomyHistorySchema,
        ...withSignal(signal),
      }),

    // --- users ---
    users: (signal?: AbortSignal) =>
      client.request({ path: '/v1/users', schema: userListSchema, ...withSignal(signal) }),
    createUser: (body: CreateUser) =>
      client.request({ method: 'POST', path: '/v1/users', body, schema: userSchema }),
    updateUser: (userId: string, body: UpdateUser) =>
      client.request({
        method: 'PATCH',
        path: `/v1/users/${id(userId)}`,
        body,
        schema: userSchema,
      }),
    forceLogout: (userId: string) =>
      client.request({
        method: 'POST',
        path: `/v1/users/${id(userId)}/force-logout`,
        schema: forceLogoutResultSchema,
      }),

    // --- organizations and contacts ---
    orgs: (query: Partial<OrganizationListQuery>, signal?: AbortSignal) =>
      client.request({
        path: '/v1/orgs',
        query,
        schema: organizationPageSchema,
        ...withSignal(signal),
      }),
    org: (orgId: string, signal?: AbortSignal) =>
      client.request({
        path: `/v1/orgs/${id(orgId)}`,
        schema: organizationSchema,
        ...withSignal(signal),
      }),
    createOrg: (body: Partial<CreateOrganization> & { name: string }) =>
      client.request({ method: 'POST', path: '/v1/orgs', body, schema: organizationSchema }),
    updateOrg: (orgId: string, body: UpdateOrganization) =>
      client.request({
        method: 'PATCH',
        path: `/v1/orgs/${id(orgId)}`,
        body,
        schema: organizationSchema,
      }),
    deleteOrg: (orgId: string) =>
      client.request({ method: 'DELETE', path: `/v1/orgs/${id(orgId)}`, schema: null }),

    contacts: (orgId: string, signal?: AbortSignal) =>
      client.request({
        path: '/v1/contacts',
        query: { orgId, limit: 200 },
        schema: contactPageSchema,
        ...withSignal(signal),
      }),
    createContact: (body: Omit<CreateContact, 'notificationPrefs'>) =>
      client.request({ method: 'POST', path: '/v1/contacts', body, schema: contactSchema }),
    updateContact: (contactId: string, body: UpdateContact) =>
      client.request({
        method: 'PATCH',
        path: `/v1/contacts/${id(contactId)}`,
        body,
        schema: contactSchema,
      }),
    deleteContact: (contactId: string) =>
      client.request({ method: 'DELETE', path: `/v1/contacts/${id(contactId)}`, schema: null }),

    // --- SLA policies and business calendars ---
    slaPolicies: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/sla-policies',
        schema: slaPolicyListSchema,
        ...withSignal(signal),
      }),
    createSlaPolicy: (body: CreateSlaPolicy) =>
      client.request({ method: 'POST', path: '/v1/sla-policies', body, schema: slaPolicySchema }),
    updateSlaPolicy: (policyId: string, body: UpdateSlaPolicy) =>
      client.request({
        method: 'PATCH',
        path: `/v1/sla-policies/${id(policyId)}`,
        body,
        schema: slaPolicySchema,
      }),
    deleteSlaPolicy: (policyId: string) =>
      client.request({ method: 'DELETE', path: `/v1/sla-policies/${id(policyId)}`, schema: null }),

    calendars: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/business-calendars',
        schema: calendarViewListSchema,
        ...withSignal(signal),
      }),
    calendar: (calendarId: string, signal?: AbortSignal) =>
      client.request({
        path: `/v1/business-calendars/${id(calendarId)}`,
        schema: calendarViewSchema,
        ...withSignal(signal),
      }),
    createCalendar: (body: Partial<CreateBusinessCalendar> & { name: string }) =>
      client.request({
        method: 'POST',
        path: '/v1/business-calendars',
        body,
        schema: calendarViewSchema,
      }),
    updateCalendar: (calendarId: string, body: UpdateBusinessCalendar) =>
      client.request({
        method: 'PATCH',
        path: `/v1/business-calendars/${id(calendarId)}`,
        body,
        schema: calendarViewSchema,
      }),
    /** Ticks or unticks "checked against the official announcement". `[ASSUMED]` contract H4. */
    checkHoliday: (calendarId: string, date: string, checked: boolean) =>
      client.request({
        method: 'PATCH',
        path: `/v1/business-calendars/${id(calendarId)}/holidays/${id(date)}`,
        body: { checked },
        schema: calendarViewSchema,
      }),

    // --- intents and queues (the list reads are in createEndpoints) ---
    updateIntent: (intentId: string, body: UpdateIntent) =>
      client.request({
        method: 'PATCH',
        path: `/v1/intents/${id(intentId)}`,
        body,
        schema: intentSchema,
      }),
    createQueue: (body: Partial<CreateTeamQueue> & { name: string }) =>
      client.request({ method: 'POST', path: '/v1/queues', body, schema: teamQueueSchema }),
    updateQueue: (queueId: string, body: UpdateTeamQueue) =>
      client.request({
        method: 'PATCH',
        path: `/v1/queues/${id(queueId)}`,
        body,
        schema: teamQueueSchema,
      }),
    deleteQueue: (queueId: string) =>
      client.request({ method: 'DELETE', path: `/v1/queues/${id(queueId)}`, schema: null }),

    // --- audit log (head) ---
    auditLogs: (query: Partial<AuditLogQuery>, signal?: AbortSignal) =>
      client.request({
        path: '/v1/audit-logs',
        query,
        schema: auditLogPageSchema,
        ...withSignal(signal),
      }),
  };
}
