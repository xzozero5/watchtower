import {
  alertAckResultSchema,
  dashboardOpsSchema,
  alertDetailSchema,
  alertEscalationListSchema,
  alertListSchema,
  alertSnoozeResultSchema,
  correlationGroupListSchema,
  escalationPolicyListSchema,
  escalationPolicySchema,
  heartbeatListSchema,
  heartbeatSchema,
  incidentChangesSchema,
  incidentCommListSchema,
  incidentCommPreviewSchema,
  incidentCommSchema,
  incidentDetailSchema,
  incidentListSchema,
  noiseReportSchema,
  orgHealthSchema,
  publishResultSchema,
  sendCommResultSchema,
  serviceListSchema,
  serviceSchema,
  statusComponentListSchema,
  statusComponentSchema,
  statusMaintenanceListSchema,
  statusMaintenanceStaffSchema,
  statusPostListSchema,
  statusPostStaffSchema,
  subscriberSummarySchema,
  type AlertListQuery,
  type CreateEscalationPolicy,
  type CreateHeartbeat,
  type CreateIncident,
  type CreateService,
  type CreateStatusComponent,
  type CreateStatusMaintenance,
  type CreateStatusPost,
  type DraftComm,
  type DraftFromIncident,
  type IncidentListQuery,
  type SendComm,
  type SnoozeAlert,
  type StatusPostListQuery,
  type UpdateEscalationPolicy,
  type UpdateHeartbeat,
  type UpdateIncident,
  type UpdateService,
  type UpdateStatusComponent,
  type UpdateStatusMaintenance,
  type UpdateStatusPost,
} from '@watchtower/shared';
import { z } from 'zod';

import type { ApiClient } from './client';

const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});
const changedSchema = z.object({ changed: z.boolean() });
const deletedSchema = z.object({ deleted: z.boolean() });
const noteResultSchema = z.object({ timelineId: z.uuid() });
const publishMaintenanceResultSchema = z.object({
  maintenance: statusMaintenanceStaffSchema,
  subscribers: z.number().int(),
});

/**
 * The alert, service catalog, incident, status page and Health Score endpoints (T-201, T-202, T-204,
 * T-205). One function per endpoint; the schemas are the shared ones the api answers with.
 */
export function createOpsEndpoints(client: ApiClient) {
  const id = (value: string) => encodeURIComponent(value);

  return {
    // --- ops dashboard (T-206b) ---
    dashboardOps: (days: number, signal?: AbortSignal) =>
      client.request({
        path: '/v1/dashboard/ops',
        query: { days },
        schema: dashboardOpsSchema,
        ...withSignal(signal),
      }),

    // --- alerts ---
    alerts: (query: Partial<AlertListQuery> = {}, signal?: AbortSignal) =>
      client.request({
        path: '/v1/alerts',
        query: {
          state: query.state,
          source: query.source,
          serviceId: query.serviceId,
          unmapped: query.unmapped,
          snoozed: query.snoozed,
          limit: query.limit,
          cursor: query.cursor,
        },
        schema: alertListSchema,
        ...withSignal(signal),
      }),

    alert: (alertId: string, signal?: AbortSignal) =>
      client.request({
        path: `/v1/alerts/${id(alertId)}`,
        schema: alertDetailSchema,
        ...withSignal(signal),
      }),

    alertEscalations: (alertId: string, signal?: AbortSignal) =>
      client.request({
        path: `/v1/alerts/${id(alertId)}/escalations`,
        schema: alertEscalationListSchema,
        ...withSignal(signal),
      }),

    alertCorrelations: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/alerts/correlations',
        schema: correlationGroupListSchema,
        ...withSignal(signal),
      }),

    alertNoise: (days: number, signal?: AbortSignal) =>
      client.request({
        path: '/v1/alerts/noise',
        query: { days },
        schema: noiseReportSchema,
        ...withSignal(signal),
      }),

    ackAlert: (alertId: string) =>
      client.request({
        method: 'POST',
        path: `/v1/alerts/${id(alertId)}/ack`,
        schema: alertAckResultSchema,
      }),

    snoozeAlert: (alertId: string, body: SnoozeAlert) =>
      client.request({
        method: 'POST',
        path: `/v1/alerts/${id(alertId)}/snooze`,
        body,
        schema: alertSnoozeResultSchema,
      }),

    unsnoozeAlert: (alertId: string) =>
      client.request({
        method: 'POST',
        path: `/v1/alerts/${id(alertId)}/unsnooze`,
        schema: alertSnoozeResultSchema,
      }),

    // --- service catalog ---
    services: (signal?: AbortSignal) =>
      client.request({ path: '/v1/services', schema: serviceListSchema, ...withSignal(signal) }),

    createService: (body: CreateService) =>
      client.request({ method: 'POST', path: '/v1/services', body, schema: serviceSchema }),

    updateService: (serviceId: string, body: UpdateService) =>
      client.request({
        method: 'PATCH',
        path: `/v1/services/${id(serviceId)}`,
        body,
        schema: serviceSchema,
      }),

    deleteService: (serviceId: string) =>
      client.request({
        method: 'DELETE',
        path: `/v1/services/${id(serviceId)}`,
        schema: null,
      }),

    // --- escalation policies ---
    escalationPolicies: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/escalation-policies',
        schema: escalationPolicyListSchema,
        ...withSignal(signal),
      }),

    createEscalationPolicy: (body: CreateEscalationPolicy) =>
      client.request({
        method: 'POST',
        path: '/v1/escalation-policies',
        body,
        schema: escalationPolicySchema,
      }),

    updateEscalationPolicy: (policyId: string, body: UpdateEscalationPolicy) =>
      client.request({
        method: 'PATCH',
        path: `/v1/escalation-policies/${id(policyId)}`,
        body,
        schema: escalationPolicySchema,
      }),

    deleteEscalationPolicy: (policyId: string) =>
      client.request({
        method: 'DELETE',
        path: `/v1/escalation-policies/${id(policyId)}`,
        schema: null,
      }),

    // --- heartbeats ---
    heartbeats: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/heartbeats',
        schema: heartbeatListSchema,
        ...withSignal(signal),
      }),

    createHeartbeat: (body: CreateHeartbeat) =>
      client.request({ method: 'POST', path: '/v1/heartbeats', body, schema: heartbeatSchema }),

    updateHeartbeat: (heartbeatId: string, body: UpdateHeartbeat) =>
      client.request({
        method: 'PATCH',
        path: `/v1/heartbeats/${id(heartbeatId)}`,
        body,
        schema: heartbeatSchema,
      }),

    deleteHeartbeat: (heartbeatId: string) =>
      client.request({
        method: 'DELETE',
        path: `/v1/heartbeats/${id(heartbeatId)}`,
        schema: null,
      }),

    // --- incidents ---
    incidents: (query: Partial<IncidentListQuery> = {}, signal?: AbortSignal) =>
      client.request({
        path: '/v1/incidents',
        query: {
          status: query.status,
          open: query.open,
          limit: query.limit,
          cursor: query.cursor,
        },
        schema: incidentListSchema,
        ...withSignal(signal),
      }),

    incident: (incidentId: string, signal?: AbortSignal) =>
      client.request({
        path: `/v1/incidents/${id(incidentId)}`,
        schema: incidentDetailSchema,
        ...withSignal(signal),
      }),

    createIncident: (body: CreateIncident) =>
      client.request({
        method: 'POST',
        path: '/v1/incidents',
        body,
        schema: incidentDetailSchema,
      }),

    updateIncident: (incidentId: string, body: UpdateIncident) =>
      client.request({
        method: 'PATCH',
        path: `/v1/incidents/${id(incidentId)}`,
        body,
        schema: incidentDetailSchema,
      }),

    linkIncidentTicket: (incidentId: string, ticketId: string) =>
      client.request({
        method: 'POST',
        path: `/v1/incidents/${id(incidentId)}/tickets`,
        body: { ticketId },
        schema: changedSchema,
      }),

    unlinkIncidentTicket: (incidentId: string, ticketId: string) =>
      client.request({
        method: 'DELETE',
        path: `/v1/incidents/${id(incidentId)}/tickets/${id(ticketId)}`,
        schema: changedSchema,
      }),

    linkIncidentAlert: (incidentId: string, alertId: string) =>
      client.request({
        method: 'POST',
        path: `/v1/incidents/${id(incidentId)}/alerts`,
        body: { alertId },
        schema: changedSchema,
      }),

    addIncidentNote: (incidentId: string, text: string, attachmentIds?: readonly string[]) =>
      client.request({
        method: 'POST',
        path: `/v1/incidents/${id(incidentId)}/notes`,
        body: attachmentIds && attachmentIds.length > 0 ? { text, attachmentIds } : { text },
        schema: noteResultSchema,
      }),

    incidentChanges: (incidentId: string, windowMinutes?: number, signal?: AbortSignal) =>
      client.request({
        path: `/v1/incidents/${id(incidentId)}/changes`,
        query: { windowMinutes },
        schema: incidentChangesSchema,
        ...withSignal(signal),
      }),

    incidentComms: (incidentId: string, signal?: AbortSignal) =>
      client.request({
        path: `/v1/incidents/${id(incidentId)}/comms`,
        schema: incidentCommListSchema,
        ...withSignal(signal),
      }),

    incidentCommPreview: (incidentId: string, signal?: AbortSignal) =>
      client.request({
        path: `/v1/incidents/${id(incidentId)}/comms/preview`,
        schema: incidentCommPreviewSchema,
        ...withSignal(signal),
      }),

    draftIncidentComm: (incidentId: string, body: DraftComm) =>
      client.request({
        method: 'POST',
        path: `/v1/incidents/${id(incidentId)}/comms`,
        body,
        schema: incidentCommSchema,
      }),

    /** A 409 means the audience changed since the preview, or the update was already sent: nothing went out. */
    sendIncidentComm: (incidentId: string, commId: string, body: SendComm) =>
      client.request({
        method: 'POST',
        path: `/v1/incidents/${id(incidentId)}/comms/${id(commId)}/send`,
        body,
        schema: sendCommResultSchema,
      }),

    // --- status page (staff) ---
    statusComponents: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/status-page/components',
        schema: statusComponentListSchema,
        ...withSignal(signal),
      }),

    createStatusComponent: (
      body: Partial<CreateStatusComponent> & { slug: string; name: string },
    ) =>
      client.request({
        method: 'POST',
        path: '/v1/status-page/components',
        body,
        schema: statusComponentSchema,
      }),

    updateStatusComponent: (componentId: string, body: UpdateStatusComponent) =>
      client.request({
        method: 'PATCH',
        path: `/v1/status-page/components/${id(componentId)}`,
        body,
        schema: statusComponentSchema,
      }),

    deleteStatusComponent: (componentId: string) =>
      client.request({
        method: 'DELETE',
        path: `/v1/status-page/components/${id(componentId)}`,
        schema: deletedSchema,
      }),

    statusPosts: (query: Partial<StatusPostListQuery> = {}, signal?: AbortSignal) =>
      client.request({
        path: '/v1/status-page/posts',
        query: { state: query.state, cursor: query.cursor, limit: query.limit },
        schema: statusPostListSchema,
        ...withSignal(signal),
      }),

    createStatusPost: (body: Partial<CreateStatusPost> & { title: string; body: string }) =>
      client.request({
        method: 'POST',
        path: '/v1/status-page/posts',
        body,
        schema: statusPostStaffSchema,
      }),

    draftStatusPostFromIncident: (
      body: Partial<DraftFromIncident> & { incidentId: string; componentIds: string[] },
    ) =>
      client.request({
        method: 'POST',
        path: '/v1/status-page/posts/from-incident',
        body,
        schema: statusPostStaffSchema,
      }),

    updateStatusPost: (postId: string, body: UpdateStatusPost) =>
      client.request({
        method: 'PATCH',
        path: `/v1/status-page/posts/${id(postId)}`,
        body,
        schema: statusPostStaffSchema,
      }),

    /** Needs a person with `incident.manage` (N3): the first time this is called is when it goes public. */
    publishStatusPost: (postId: string) =>
      client.request({
        method: 'POST',
        path: `/v1/status-page/posts/${id(postId)}/publish`,
        schema: publishResultSchema,
      }),

    deleteStatusPost: (postId: string) =>
      client.request({
        method: 'DELETE',
        path: `/v1/status-page/posts/${id(postId)}`,
        schema: deletedSchema,
      }),

    statusMaintenance: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/status-page/maintenance',
        schema: statusMaintenanceListSchema,
        ...withSignal(signal),
      }),

    createStatusMaintenance: (
      body: Partial<CreateStatusMaintenance> & {
        title: string;
        body: string;
        startsAt: string;
        endsAt: string;
      },
    ) =>
      client.request({
        method: 'POST',
        path: '/v1/status-page/maintenance',
        body,
        schema: statusMaintenanceStaffSchema,
      }),

    updateStatusMaintenance: (maintenanceId: string, body: UpdateStatusMaintenance) =>
      client.request({
        method: 'PATCH',
        path: `/v1/status-page/maintenance/${id(maintenanceId)}`,
        body,
        schema: statusMaintenanceStaffSchema,
      }),

    publishStatusMaintenance: (maintenanceId: string) =>
      client.request({
        method: 'POST',
        path: `/v1/status-page/maintenance/${id(maintenanceId)}/publish`,
        schema: publishMaintenanceResultSchema,
      }),

    cancelStatusMaintenance: (maintenanceId: string) =>
      client.request({
        method: 'POST',
        path: `/v1/status-page/maintenance/${id(maintenanceId)}/cancel`,
        schema: statusMaintenanceStaffSchema,
      }),

    statusSubscribers: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/status-page/subscribers',
        schema: subscriberSummarySchema,
        ...withSignal(signal),
      }),

    // --- Client Health Score (needs org.health.read) ---
    orgHealth: (orgId: string, signal?: AbortSignal) =>
      client.request({
        path: `/v1/orgs/${id(orgId)}/health`,
        schema: orgHealthSchema,
        ...withSignal(signal),
      }),
  };
}
