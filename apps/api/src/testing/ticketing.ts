import type {
  BusinessCalendarRecord,
  ClientTicket,
  Intent,
  Organization,
  SessionInfo,
  SlaPolicy,
  TeamQueue,
  TicketDetail,
  TimelineEntry,
} from '@watchtower/shared';

import { createOrg, uniqueEmail, type Harness, type TestClient } from './harness.js';

/** Helpers for the ticketing integration tests: people who are signed in, and reference data. */

export interface Persona {
  readonly client: TestClient;
  readonly email: string;
  readonly session: SessionInfo;
  readonly userId: string;
}

export async function signIn(
  h: Harness,
  role: 'agent' | 'lead' | 'head' | 'client',
  orgId?: string,
  name?: string,
): Promise<Persona> {
  const client = h.client();
  const email = uniqueEmail(role);
  const session = await client.devLogin(email, role, {
    ...(orgId === undefined ? {} : { orgId }),
    ...(name === undefined ? {} : { name }),
  });
  return { client, email, session, userId: session.user.id };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
}

/** An organization created through the API by someone who may. */
export async function apiOrg(
  lead: Persona,
  fields: { name?: string; tier?: 'gold' | 'silver' | 'standard'; domains?: string[] } = {},
): Promise<Organization> {
  const response = await lead.client.post<Organization>('/v1/orgs', {
    name: fields.name ?? `Acme ${uniqueEmail('org')}`,
    ...(fields.tier === undefined ? {} : { tier: fields.tier }),
    ...(fields.domains === undefined ? {} : { domains: fields.domains }),
  });
  if (response.status !== 201)
    throw new Error(`org create failed: ${JSON.stringify(response.body)}`);
  return response.body;
}

export async function apiCalendar(
  head: Persona,
  body: Record<string, unknown>,
): Promise<BusinessCalendarRecord> {
  const response = await head.client.post<BusinessCalendarRecord>('/v1/business-calendars', body);
  if (response.status !== 201) {
    throw new Error(`calendar create failed: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

export async function apiPolicy(head: Persona, body: Record<string, unknown>): Promise<SlaPolicy> {
  const response = await head.client.post<SlaPolicy>('/v1/sla-policies', body);
  if (response.status !== 201) {
    throw new Error(`policy create failed: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

export async function apiIntent(lead: Persona, body: Record<string, unknown>): Promise<Intent> {
  const response = await lead.client.post<Intent>('/v1/intents', body);
  if (response.status !== 201) {
    throw new Error(`intent create failed: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

export async function apiQueue(lead: Persona, body: Record<string, unknown>): Promise<TeamQueue> {
  const response = await lead.client.post<TeamQueue>('/v1/queues', body);
  if (response.status !== 201) {
    throw new Error(`queue create failed: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

/** A ticket filed by staff for an organization. */
export async function fileTicket(
  who: Persona,
  orgId: string,
  fields: Record<string, unknown> = {},
): Promise<TicketDetail> {
  const response = await who.client.post<TicketDetail>('/v1/tickets', {
    orgId,
    subject: 'Cannot sign in to the dashboard',
    body: 'Since this morning the dashboard rejects our password.',
    requester: { email: uniqueEmail('requester'), name: 'Requester' },
    ...fields,
  });
  if (response.status !== 201) {
    throw new Error(
      `ticket create failed: ${String(response.status)} ${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}

export async function fileClientTicket(
  who: Persona,
  fields: Record<string, unknown> = {},
): Promise<ClientTicket> {
  const response = await who.client.post<ClientTicket>('/v1/tickets', {
    subject: 'We cannot see our reports',
    body: 'The reports page stays empty for our organization.',
    ...fields,
  });
  if (response.status !== 201) {
    throw new Error(
      `client ticket failed: ${String(response.status)} ${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}

export async function timelineOf(
  who: Persona,
  ref: string,
  query = '',
): Promise<{ entries: TimelineEntry[]; nextCursor: string | null }> {
  const response = await who.client.get<{ entries: TimelineEntry[]; nextCursor: string | null }>(
    `/v1/tickets/${ref}/timeline${query}`,
  );
  if (response.status !== 200) {
    throw new Error(`timeline failed: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

/** A client user of a fresh organization. */
export async function clientOfNewOrg(
  h: Harness,
  name?: string,
): Promise<{ orgId: string; persona: Persona }> {
  const orgId = await createOrg(h.db.owner.pool);
  return { orgId, persona: await signIn(h, 'client', orgId, name) };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
