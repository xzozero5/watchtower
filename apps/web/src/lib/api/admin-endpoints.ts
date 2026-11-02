import {
  autonomyHistoryPageSchema,
  channelAccountListSchema,
  channelAccountSchema,
  gmailConnectionStatusSchema,
  gmailOauthDisconnectResultSchema,
  gmailOauthStartResultSchema,
  integrationListSchema,
  integrationStatusSchema,
  testConnectionResultSchema,
  autonomyStateSchema,
  auditLogPageSchema,
  businessCalendarListSchema,
  businessCalendarSchema,
  contactPageSchema,
  contactSchema,
  forceLogoutResultSchema,
  intentAutonomyChangeSchema,
  orgTierListSchema,
  orgTierRecordSchema,
  deadOutboxPageSchema,
  outboxHealthSchema,
  resendOutboxResultSchema,
  setAiSwitchResultSchema,
  ticketStatsSchema,
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
  type CreateChannelAccount,
  type CreateContact,
  type CreateOrganization,
  type CreateOrgTier,
  type UpdateOrgTier,
  type CreateIntent,
  type CreateSlaPolicy,
  type CreateTeamQueue,
  type CreateUser,
  type OrganizationListQuery,
  type PutCredentials,
  type SetAiSwitch,
  type SetIntentAutonomy,
  type TestConnection,
  type UpdateBusinessCalendar,
  type UpdateContact,
  type UpdateIntent,
  type UpdateOrganization,
  type UpdateSlaPolicy,
  type UpdateTeamQueue,
  type UpdateUser,
} from '@watchtower/shared';
import { readinessViewSchema } from '@/lib/admin/contracts';

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
    /** Counts for the head home (same filters as the list; heads and leads only). */
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
      client.request({ path: '/v1/autonomy', schema: autonomyStateSchema, ...withSignal(signal) }),

    setAiSwitch: (body: SetAiSwitch) =>
      client.request({
        method: 'POST',
        path: '/v1/autonomy/switches',
        body,
        schema: setAiSwitchResultSchema,
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
        query: { limit: 50 },
        schema: autonomyHistoryPageSchema,
        ...withSignal(signal),
      }),

    // --- the outbox, as the head sees it (T-121a) ---
    outboxHealth: (signal?: AbortSignal) =>
      client.request({ path: '/v1/ops/outbox', schema: outboxHealthSchema, ...withSignal(signal) }),
    deadOutbox: (cursor?: string, signal?: AbortSignal) =>
      client.request({
        path: '/v1/ops/outbox/dead',
        query: { limit: 50, cursor },
        schema: deadOutboxPageSchema,
        ...withSignal(signal),
      }),
    resendOutbox: (rowId: string) =>
      client.request({
        method: 'POST',
        path: `/v1/ops/outbox/${id(rowId)}/resend`,
        body: {},
        schema: resendOutboxResultSchema,
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
    orgTiers: (signal?: AbortSignal) =>
      client.request({ path: '/v1/org-tiers', schema: orgTierListSchema, ...withSignal(signal) }),
    createOrgTier: (body: CreateOrgTier) =>
      client.request({
        method: 'POST',
        path: '/v1/org-tiers',
        body,
        schema: orgTierRecordSchema,
      }),
    updateOrgTier: (slug: string, body: UpdateOrgTier) =>
      client.request({
        method: 'PATCH',
        path: `/v1/org-tiers/${id(slug)}`,
        body,
        schema: orgTierRecordSchema,
      }),
    deleteOrgTier: (slug: string) =>
      client.request({ method: 'DELETE', path: `/v1/org-tiers/${id(slug)}`, schema: null }),
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
        schema: businessCalendarListSchema,
        ...withSignal(signal),
      }),
    calendar: (calendarId: string, signal?: AbortSignal) =>
      client.request({
        path: `/v1/business-calendars/${id(calendarId)}`,
        schema: businessCalendarSchema,
        ...withSignal(signal),
      }),
    createCalendar: (body: Partial<CreateBusinessCalendar> & { name: string }) =>
      client.request({
        method: 'POST',
        path: '/v1/business-calendars',
        body,
        schema: businessCalendarSchema,
      }),
    updateCalendar: (calendarId: string, body: UpdateBusinessCalendar) =>
      client.request({
        method: 'PATCH',
        path: `/v1/business-calendars/${id(calendarId)}`,
        body,
        schema: businessCalendarSchema,
      }),
    /** Ticks or unticks "checked against the official announcement" (head). */
    checkHoliday: (calendarId: string, date: string, checked: boolean) =>
      client.request({
        method: 'PATCH',
        path: `/v1/business-calendars/${id(calendarId)}/holidays/${id(date)}`,
        body: { checked },
        schema: businessCalendarSchema,
      }),

    // --- intents and queues (the list reads are in createEndpoints) ---
    updateIntent: (intentId: string, body: UpdateIntent) =>
      client.request({
        method: 'PATCH',
        path: `/v1/intents/${id(intentId)}`,
        body,
        schema: intentSchema,
      }),
    createIntent: (body: Partial<CreateIntent> & Pick<CreateIntent, 'key' | 'name'>) =>
      client.request({ method: 'POST', path: '/v1/intents', body, schema: intentSchema }),
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

    // --- integrations (head, ADR-012): write-only, no response carries a stored value ---
    integrations: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/admin/integrations',
        schema: integrationListSchema,
        ...withSignal(signal),
      }),
    putIntegration: (integration: string, body: PutCredentials) =>
      client.request({
        method: 'PUT',
        path: `/v1/admin/integrations/${id(integration)}`,
        body,
        schema: integrationStatusSchema,
      }),
    deleteIntegrationField: (integration: string, field: string) =>
      client.request({
        method: 'DELETE',
        path: `/v1/admin/integrations/${id(integration)}/fields/${id(field)}`,
        schema: null,
      }),
    testIntegration: (integration: string, body: TestConnection) =>
      client.request({
        method: 'POST',
        path: `/v1/admin/integrations/${id(integration)}/test`,
        body,
        schema: testConnectionResultSchema,
      }),

    // --- Gmail OAuth (head, T-102e) ---
    gmailStatus: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/admin/integrations/gmail/oauth/status',
        schema: gmailConnectionStatusSchema,
        ...withSignal(signal),
      }),
    gmailOauthStart: (mailbox: string) =>
      client.request({
        method: 'POST',
        path: '/v1/admin/integrations/gmail/oauth/start',
        body: { mailbox },
        schema: gmailOauthStartResultSchema,
      }),
    gmailOauthDisconnect: () =>
      client.request({
        method: 'POST',
        path: '/v1/admin/integrations/gmail/oauth/disconnect',
        schema: gmailOauthDisconnectResultSchema,
      }),

    // --- channel accounts (head, T-131) ---
    channelAccounts: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/admin/channel-accounts',
        schema: channelAccountListSchema,
        ...withSignal(signal),
      }),
    createChannelAccount: (body: CreateChannelAccount) =>
      client.request({
        method: 'POST',
        path: '/v1/admin/channel-accounts',
        body,
        schema: channelAccountSchema,
      }),
    disableChannelAccount: (accountId: string) =>
      client.request({
        method: 'POST',
        path: `/v1/admin/channel-accounts/${id(accountId)}/disable`,
        schema: channelAccountSchema,
      }),

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
