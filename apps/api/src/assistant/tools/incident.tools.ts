import type { AssistantFact } from '@watchtower/ai';
import {
  incidentListQuerySchema,
  incidentSeveritySchema,
  incidentStatusSchema,
  parseIncidentKey,
  type IncidentDetail,
} from '@watchtower/shared';
import { z } from 'zod';

import type { Principal } from '../../auth/principal.js';
import type { IncidentsService } from '../../incidents/incidents.service.js';
import type { TicketKeys } from '../../tickets/ticket-keys.js';
import type { TicketReader } from '../../tickets/ticket-reader.js';
import { cut, cutNullable, limitSchema, makeFact, type OpsToolKit } from './ops-tool-kit.js';

/**
 * `incident_search` and `incident_get` (T-402, ADR-029 section 2). Both read through `IncidentsService`, which is what
 * `GET /v1/incidents` and `GET /v1/incidents/:id` call, and both need `ticket.read` whole (the masked developer is not
 * let in: T-400 C-1). Text a person wrote (a title, a root cause, a timeline note) is untrusted content (C-14).
 */

export interface IncidentToolDeps {
  readonly incidents: IncidentsService;
  readonly reader: TicketReader;
  readonly keys: TicketKeys;
}

const uuid = z.uuid();

const incidentRow = z.object({
  id: z.uuid(),
  key: z.string().max(20),
  title: z.string().max(200),
  severity: incidentSeveritySchema,
  status: incidentStatusSchema,
  startedAt: z.string().max(40),
  resolvedAt: z.string().max(40).nullable(),
  tickets: z.number().int().min(0),
  alerts: z.number().int().min(0),
});
type IncidentRowShape = z.infer<typeof incidentRow>;

export const incidentSearchInput = z.strictObject({
  status: incidentStatusSchema.optional(),
  open: z.boolean().optional(),
  limit: limitSchema,
});
export const incidentSearchOutput = z.object({ items: z.array(incidentRow).max(20) });

export const incidentGetInput = z.strictObject({
  /** The id, or the key (`INC-12`). */
  incident: z.string().trim().min(1).max(64),
});

const timelineEntry = z.object({
  id: z.uuid(),
  type: z.string().max(40),
  at: z.string().max(40),
  actorType: z.enum(['user', 'system', 'ai', 'anonymous']),
  /** Only a note has text. */
  text: z.string().max(600).nullable(),
});

export const incidentGetOutput = z.object({
  incident: incidentRow.extend({
    rootCause: z.string().max(1000).nullable(),
    ticketIds: z.array(z.uuid()).max(20),
    alertIds: z.array(z.uuid()).max(20),
  }),
  /** The last entries, oldest first. */
  timeline: z.array(timelineEntry).max(15),
  timelineTotal: z.number().int().min(0),
  linkedTickets: z.array(z.object({ key: z.string().max(40), status: z.string().max(40) })).max(10),
  deploys: z
    .array(
      z.object({
        id: z.uuid(),
        serviceSlug: z.string().max(100),
        version: z.string().max(100),
        env: z.string().max(40),
        at: z.string().max(40),
      }),
    )
    .max(5),
});

const rowOf = (incident: {
  id: string;
  key: string;
  title: string;
  severity: IncidentRowShape['severity'];
  status: IncidentRowShape['status'];
  startedAt: string;
  resolvedAt: string | null;
  tickets: number;
  alerts: number;
}): IncidentRowShape => ({
  id: incident.id,
  key: incident.key,
  title: cut(incident.title, 200),
  severity: incident.severity,
  status: incident.status,
  startedAt: incident.startedAt,
  resolvedAt: incident.resolvedAt,
  tickets: incident.tickets,
  alerts: incident.alerts,
});

const incidentFact = (row: IncidentRowShape): AssistantFact =>
  makeFact({
    kind: 'incident',
    id: row.id,
    label: row.key,
    system: `${row.key} ${row.severity} ${row.status}, started ${row.startedAt}${
      row.resolvedAt === null ? '' : `, resolved ${row.resolvedAt}`
    }, ${String(row.tickets)} tickets, ${String(row.alerts)} alerts. Title:`,
    free: [row.title],
  });

export function registerIncidentTools(
  deps: IncidentToolDeps,
  kit: OpsToolKit,
  principal: Principal,
): void {
  kit.add(
    'incident_search',
    {
      description:
        'List incidents, newest first: by status or only the ones not resolved. Key, severity, status, start time, linked ticket and alert counts.',
      input: incidentSearchInput,
      output: incidentSearchOutput,
      async execute(input) {
        const page = await deps.incidents.list(
          incidentListQuerySchema.parse({
            status: input.status,
            open: input.open === undefined ? undefined : String(input.open),
            limit: input.limit,
          }),
        );
        return { items: page.items.map(rowOf) };
      },
    },
    '{"status"?: "investigating"|"identified"|"monitoring"|"resolved", "open"?: true, "limit"?: 10}',
    (output) => output.items.map((row) => incidentFact(row)),
  );

  kit.add(
    'incident_get',
    {
      description:
        'Read one incident: its timeline (last entries, notes as untrusted text), the tickets linked to it and the deploys just before it began.',
      input: incidentGetInput,
      output: incidentGetOutput,
      async execute(input) {
        const key = parseIncidentKey(input.incident);
        let id: string;
        if (uuid.safeParse(input.incident).success) id = input.incident;
        else if (key !== null) id = await deps.incidents.idOfNumber(key);
        else throw new Error('give the incident as INC-12 or its id');
        const detail: IncidentDetail = await deps.incidents.get(id);
        await kit.remember(detail.orgIds);

        // The linked tickets are read with the reader of tickets, under the person's own scope: one they may not read is left out.
        const linked = await Promise.all(
          detail.ticketIds.slice(0, 10).map(async (ticketId) => {
            try {
              const view = await deps.reader.viewRow(ticketId, principal);
              const key = deps.keys.format(view.t.number);
              kit.onRead?.({ id: view.t.id, key });
              return { key, status: view.t.status };
            } catch {
              return null;
            }
          }),
        );
        // What changed shortly before it began. A repository that cannot be read leaves the deploys (the route says so too).
        const changes = await deps.incidents
          .changes(id, { windowMinutes: 60 })
          .catch(() => ({ deploys: [] }));

        const timeline = detail.timeline.slice(-15).map((entry) => {
          const text = entry.type === 'note' ? entry.payload.text : undefined;
          return {
            id: entry.id,
            type: entry.type,
            at: entry.createdAt,
            actorType: entry.actorType,
            text: typeof text === 'string' ? cut(text, 600) : null,
          };
        });
        return {
          incident: {
            ...rowOf(detail),
            rootCause: cutNullable(detail.rootCause, 1000),
            ticketIds: detail.ticketIds.slice(0, 20),
            alertIds: detail.alertIds.slice(0, 20),
          },
          timeline,
          timelineTotal: detail.timeline.length,
          linkedTickets: linked.filter((entry) => entry !== null),
          deploys: changes.deploys.slice(0, 5).map((deploy) => ({
            id: deploy.id,
            serviceSlug: cut(deploy.serviceSlug, 100),
            version: cut(deploy.version, 100),
            env: cut(deploy.env, 40),
            at: deploy.occurredAt,
          })),
        };
      },
    },
    '{"incident": "INC-12"}',
    (output) => {
      const { incident } = output;
      const facts: AssistantFact[] = [
        makeFact({
          kind: 'incident',
          id: incident.id,
          label: incident.key,
          system: `${incident.key} ${incident.severity} ${incident.status}, started ${incident.startedAt}${
            incident.resolvedAt === null ? '' : `, resolved ${incident.resolvedAt}`
          }. Title:`,
          free: [
            incident.title,
            incident.rootCause === null ? null : `Root cause: ${incident.rootCause}`,
          ],
        }),
      ];
      if (output.linkedTickets.length > 0) {
        facts.push(
          makeFact({
            kind: 'incident',
            id: incident.id,
            label: incident.key,
            system: `${incident.key} tickets linked: ${output.linkedTickets
              .map((ticket) => `${ticket.key} (${ticket.status})`)
              .join(', ')}.`,
          }),
        );
      }
      const kinds = output.timeline
        .filter((entry) => entry.text === null)
        .map((entry) => `${entry.at} ${entry.type}`);
      if (kinds.length > 0) {
        facts.push(
          makeFact({
            kind: 'incident',
            id: incident.id,
            label: incident.key,
            system: `${incident.key} timeline (${String(output.timelineTotal)} entries, last ${String(
              output.timeline.length,
            )}): ${kinds.join('; ')}.`,
          }),
        );
      }
      for (const entry of output.timeline.filter((item) => item.text !== null).slice(-5)) {
        facts.push(
          makeFact({
            kind: 'note',
            id: entry.id,
            label: `${incident.key} note`,
            system: `${incident.key} note at ${entry.at} by ${entry.actorType}:`,
            free: [entry.text],
          }),
        );
      }
      for (const deploy of output.deploys) {
        facts.push(
          makeFact({
            kind: 'deploy',
            id: deploy.id,
            label: `${deploy.serviceSlug} ${deploy.version}`,
            system: `Deploy at ${deploy.at} before ${incident.key}:`,
            free: [`${deploy.serviceSlug} ${deploy.version} (${deploy.env})`],
          }),
        );
      }
      return facts;
    },
  );
}
