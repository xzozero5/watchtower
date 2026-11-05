import type { AssistantFact } from '@watchtower/ai';
import {
  alertListQuerySchema,
  alertSeveritySchema,
  alertSourceSchema,
  alertStateSchema,
} from '@watchtower/shared';
import { z } from 'zod';

import type { AlertsReader } from '../../alerts/alerts-reader.service.js';
import { cut, cutNullable, limitSchema, makeFact, type OpsToolKit } from './ops-tool-kit.js';

/**
 * `alert_search` and `alert_get` (T-402, ADR-029 section 2). They read through `AlertsReader`, which `GET /v1/alerts` and
 * `GET /v1/alerts/:id` call, and need `alert.read`. The title and the summary of an alert come from a monitoring system
 * (a webhook): they are untrusted content (C-14). The raw `payload` of an alert is never returned.
 */

export interface AlertToolDeps {
  readonly alerts: AlertsReader;
}

const alertRow = z.object({
  id: z.uuid(),
  source: alertSourceSchema,
  severity: alertSeveritySchema,
  state: alertStateSchema,
  title: z.string().max(300),
  count: z.number().int().min(1),
  firstSeenAt: z.string().max(40),
  lastSeenAt: z.string().max(40),
  serviceId: z.uuid().nullable(),
  incidentId: z.uuid().nullable(),
  snoozedUntil: z.string().max(40).nullable(),
});
type AlertRowShape = z.infer<typeof alertRow>;

export const alertSearchInput = z.strictObject({
  state: alertStateSchema.optional(),
  source: alertSourceSchema.optional(),
  serviceId: z.uuid().optional(),
  unmapped: z.boolean().optional(),
  snoozed: z.boolean().optional(),
  limit: limitSchema,
});
export const alertSearchOutput = z.object({ items: z.array(alertRow).max(20) });

export const alertGetInput = z.strictObject({ alert: z.uuid() });
export const alertGetOutput = z.object({
  alert: alertRow.extend({
    summary: z.string().max(600).nullable(),
    ackedAt: z.string().max(40).nullable(),
    resolvedAt: z.string().max(40).nullable(),
    escalationLevel: z.number().int().min(0),
  }),
  events: z
    .array(
      z.object({
        type: z.string().max(40),
        occurredAt: z.string().max(40).nullable(),
        createdAt: z.string().max(40),
      }),
    )
    .max(15),
  eventTotal: z.number().int().min(0),
});

const rowOf = (alert: {
  id: string;
  source: AlertRowShape['source'];
  severity: AlertRowShape['severity'];
  state: AlertRowShape['state'];
  title: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  serviceId: string | null;
  incidentId: string | null;
  snoozedUntil: string | null;
}): AlertRowShape => ({
  id: alert.id,
  source: alert.source,
  severity: alert.severity,
  state: alert.state,
  title: cut(alert.title, 300),
  count: alert.count,
  firstSeenAt: alert.firstSeenAt,
  lastSeenAt: alert.lastSeenAt,
  serviceId: alert.serviceId,
  incidentId: alert.incidentId,
  snoozedUntil: alert.snoozedUntil,
});

const line = (alert: AlertRowShape): string =>
  `Alert ${alert.id.slice(0, 8)} ${alert.severity} ${alert.state} from ${alert.source}, seen ${String(
    alert.count,
  )}x, first ${alert.firstSeenAt}, last ${alert.lastSeenAt}${
    alert.snoozedUntil === null ? '' : `, snoozed until ${alert.snoozedUntil}`
  }${alert.incidentId === null ? '' : `, incident ${alert.incidentId}`}. Title:`;

const factOf = (alert: AlertRowShape, summary?: string | null): AssistantFact =>
  makeFact({
    kind: 'alert',
    id: alert.id,
    label: `${alert.severity} ${cut(alert.title, 60)}`,
    system: line(alert),
    free: [alert.title, summary === null || summary === undefined ? null : `Summary: ${summary}`],
    trust: 'staff',
  });

export function registerAlertTools(deps: AlertToolDeps, kit: OpsToolKit): void {
  kit.add(
    'alert_search',
    {
      description:
        'List alerts, newest activity first: by state, source, service, only the unmapped ones or only the snoozed ones.',
      input: alertSearchInput,
      output: alertSearchOutput,
      async execute(input) {
        const page = await deps.alerts.list(
          alertListQuerySchema.parse({
            state: input.state,
            source: input.source,
            serviceId: input.serviceId,
            unmapped: input.unmapped === undefined ? undefined : String(input.unmapped),
            snoozed: input.snoozed === undefined ? undefined : String(input.snoozed),
            limit: input.limit,
          }),
        );
        return { items: page.items.map(rowOf) };
      },
    },
    '{"state"?: "open"|"acknowledged"|"resolved", "source"?: "gcp"|"alertmanager"|..., "unmapped"?: true, "snoozed"?: true, "limit"?: 10}',
    (output) => output.items.map((alert) => factOf(alert)),
  );

  kit.add(
    'alert_get',
    {
      description:
        'Read one alert by its id: state, how often it fired, escalation level, and the last events.',
      input: alertGetInput,
      output: alertGetOutput,
      async execute(input) {
        const detail = await deps.alerts.get(input.alert);
        return {
          alert: {
            ...rowOf(detail),
            summary: cutNullable(detail.summary, 600),
            ackedAt: detail.ackedAt,
            resolvedAt: detail.resolvedAt,
            escalationLevel: detail.escalationLevel,
          },
          events: detail.events.slice(-15).map((event) => ({
            type: event.type,
            occurredAt: event.occurredAt,
            createdAt: event.createdAt,
          })),
          eventTotal: detail.events.length,
        };
      },
    },
    '{"alert": "<alert id>"}',
    (output) => {
      const facts = [factOf(output.alert, output.alert.summary)];
      if (output.events.length > 0) {
        facts.push(
          makeFact({
            kind: 'alert',
            id: output.alert.id,
            label: `alert ${output.alert.id.slice(0, 8)} events`,
            system: `Alert ${output.alert.id.slice(0, 8)} events (${String(output.eventTotal)}, last ${String(
              output.events.length,
            )}): ${output.events
              .map((event) => `${event.occurredAt ?? event.createdAt} ${event.type}`)
              .join('; ')}.`,
          }),
        );
      }
      return facts;
    },
  );
}
