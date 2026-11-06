import { HttpException, Inject, Injectable } from '@nestjs/common';
import {
  ASSISTANT_MAX_SELECTION,
  type AssistantContext,
  type AssistantContextChip,
  type AssistantEntityKind,
  type Permission,
} from '@watchtower/shared';
import { z } from 'zod';

import { AlertsReader } from '../alerts/alerts-reader.service.js';
import type { Principal } from '../auth/principal.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { IntentsService } from '../intents/intents.service.js';
import { KbService } from '../kb/kb.service.js';
import { OrganizationsService } from '../orgs/organizations.service.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';
import { OtherMailService } from '../inbound/other-mail.service.js';
import { HandoffService } from '../shifts/handoff.service.js';
import { AlertsCatalog } from '../alerts/catalog.service.js';
import { visibleHandoff } from './entity-readers.js';
import { TicketReader } from '../tickets/ticket-reader.js';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '@watchtower/db';
import { ticketHref } from './assistant-hrefs.js';
import { runReadOnly } from './read-only.js';

/**
 * Resolves the refs a person's chips send (ADR-029 section 1). A ref is a hint, never an entitlement: each one is read
 * with the reader of its own module under the caller's principal, the way the GET route of that module reads it. A ref
 * that does not exist and a ref the caller may not read are dropped the same way: no different value, no different
 * order, no different time-to-first-byte beyond what the reader itself does. The drop is recorded as `context_dropped`
 * (kind and ref the person sent, never why).
 */

/** A ref the caller may read, as the reader of its module saw it. */
export interface ResolvedRef {
  readonly kind: AssistantEntityKind;
  /** The id the module uses (a ticket's uuid; the key such as `OPS-1` is the `label`). */
  readonly id: string;
  readonly label: string;
  /** Present only for a page the web has (`assistant-hrefs.ts`). */
  readonly href?: string;
  /** The organization it belongs to, when the kind has one: its people go to the redactor (N4). */
  readonly orgId?: string | null;
  readonly orgIds?: readonly string[];
  readonly names?: readonly string[];
  readonly namesComplete?: boolean;
  readonly summaryTool?: 'handoff_get' | 'handoff_incoming_get';
}

/** Returns the ref when the caller may read it; null for "no such thing" and for "not yours", the same. */
export type KindReader = (ref: string, principal: Principal) => Promise<ResolvedRef | null>;

/**
 * Which readers exist. A kind without one is a seam: its refs are dropped until a module adds its reader here
 * (T-402 to T-405 add `conversation`, `handoff` and `service`).
 */
export type KindReaders = { readonly [K in AssistantEntityKind]?: KindReader };

export const KINDS_WITHOUT_READER: readonly AssistantEntityKind[] = [];

export interface ContextDrop {
  readonly kind: AssistantEntityKind;
  readonly ref: string;
}

export interface ResolvedContext {
  /** The entity chip, when it resolved. */
  readonly entity: ResolvedRef | null;
  /** The selection that resolved, in the order sent, without duplicates. */
  readonly selection: readonly ResolvedRef[];
  /** `entity` and `selection` together, unique by kind and id. */
  readonly refs: readonly ResolvedRef[];
  /** `context_dropped`: what was sent and left out. */
  readonly dropped: readonly ContextDrop[];
  /** What the `context` phase event and the chips show. */
  readonly chips: readonly AssistantContextChip[];
}

const CHUNK = 5;

/** Statuses a reader answers with for a thing that is missing or not the caller's. Anything else is a real failure. */
const REFUSALS = new Set([403, 404]);

function isRefusal(error: unknown): boolean {
  return error instanceof HttpException && REFUSALS.has(error.getStatus());
}

/** Reads one ref; "missing" and "forbidden" both become null. */
async function readOne(
  reader: KindReader | undefined,
  ref: string,
  principal: Principal,
): Promise<ResolvedRef | null> {
  if (reader === undefined) return null;
  try {
    return await reader(ref, principal);
  } catch (error) {
    if (isRefusal(error)) return null;
    throw error;
  }
}

export async function resolveContext(
  context: AssistantContext | undefined,
  principal: Principal,
  readers: KindReaders,
): Promise<ResolvedContext> {
  const wanted: { kind: AssistantEntityKind; ref: string; role: 'entity' | 'selection' }[] = [];
  if (context?.entity !== undefined) {
    wanted.push({ kind: context.entity.kind, ref: context.entity.ref, role: 'entity' });
  }
  for (const ref of context?.selection?.refs.slice(0, ASSISTANT_MAX_SELECTION) ?? []) {
    wanted.push({ kind: context?.selection?.kind ?? 'ticket', ref, role: 'selection' });
  }

  // The same thing named twice is read once.
  const tasks: { item: (typeof wanted)[number]; key: string }[] = [];
  for (const item of wanted) {
    const key = `${item.kind}\u0000${item.ref}`;
    tasks.push({ item, key });
  }
  const results = new Map<string, ResolvedRef | null>();
  const keys = [...new Set(tasks.map((task) => task.key))];
  for (let from = 0; from < keys.length; from += CHUNK) {
    const part = keys.slice(from, from + CHUNK);
    const settled = await Promise.all(
      part.map((key) => {
        const task = tasks.find((candidate) => candidate.key === key);
        if (task === undefined) return Promise.resolve(null);
        return readOne(readers[task.item.kind], task.item.ref, principal);
      }),
    );
    part.forEach((key, index) => results.set(key, settled[index] ?? null));
  }

  const dropped: ContextDrop[] = [];
  const chips: AssistantContextChip[] = [];
  const refs = new Map<string, ResolvedRef>();
  let entity: ResolvedRef | null = null;
  const selection: ResolvedRef[] = [];
  const seenSelection = new Set<string>();
  for (const { item, key } of tasks) {
    const found = results.get(key) ?? null;
    if (found === null) {
      dropped.push({ kind: item.kind, ref: item.ref });
      chips.push({ kind: item.kind, status: 'dropped' });
      continue;
    }
    const identity = `${found.kind}\u0000${found.id}`;
    refs.set(identity, found);
    if (item.role === 'entity') entity = found;
    else if (!seenSelection.has(identity)) {
      seenSelection.add(identity);
      selection.push(found);
    }
    chips.push({
      kind: found.kind,
      status: 'resolved',
      label: found.label.slice(0, 200),
      ...(found.href === undefined ? {} : { href: found.href }),
    });
  }
  return { entity, selection, refs: [...refs.values()], dropped, chips };
}

// --- the readers of the kinds that have one -----------------------------------------------------------

const uuid = z.uuid();

function holdsAny(principal: Principal, permissions: readonly Permission[]): boolean {
  return permissions.some((permission) => principal.permissions.has(permission));
}

/**
 * The context resolver with the readers of the modules (ticket, incident, alert, kb_article, intent, org). Each reader
 * asks first for the permission the GET route of the same module asks (`ticket.read` for an incident, `alert.read` for an
 * alert, `kb.read` ...) and then lets the module's own service decide about the row, so the answer is the one the
 * screen would give the same person.
 */
@Injectable()
export class ContextResolver {
  private readonly readers: KindReaders;

  constructor(
    @Inject(DATABASE) database: Database,
    @Inject(TicketReader) tickets: TicketReader,
    @Inject(TICKET_KEYS) keys: TicketKeys,
    @Inject(IncidentsService) incidents: IncidentsService,
    @Inject(AlertsReader) alerts: AlertsReader,
    @Inject(KbService) kb: KbService,
    @Inject(IntentsService) intents: IntentsService,
    @Inject(OrganizationsService) orgs: OrganizationsService,
    @Inject(OtherMailService) otherMail: OtherMailService,
    @Inject(HandoffService) handoffs: HandoffService,
    @Inject(AlertsCatalog) catalog: AlertsCatalog,
  ) {
    this.readers = {
      service: async (ref, principal) => {
        if (!holdsAny(principal, ['alert.read']) || !uuid.safeParse(ref).success) return null;
        const service = await runReadOnly(database, () => catalog.getService(ref));
        return { kind: 'service', id: service.id, label: service.name };
      },
      handoff: async (ref, principal) => {
        if (!uuid.safeParse(ref).success) return null;
        const handoff = await runReadOnly(database, () => visibleHandoff(handoffs, principal, ref));
        if (handoff === null) return null;
        const orgIds: string[] = [];
        let namesComplete = true;
        for (const item of handoff.items)
          if (item.ticket !== null) {
            try {
              const view = await runReadOnly(database, (db) =>
                tickets.viewRow(item.ticket?.id ?? '', principal, db),
              );
              orgIds.push(view.t.orgId);
            } catch (error) {
              if (!isRefusal(error)) throw error;
              namesComplete = false;
            }
          }
        return {
          kind: 'handoff',
          id: handoff.id,
          label: 'Handoff',
          orgIds,
          namesComplete,
          names: [
            handoff.from.name,
            ...handoff.items.flatMap((item) => item.ticket?.assignee?.name ?? []),
          ],
          summaryTool:
            handoff.from.id === principal.userId ? 'handoff_get' : 'handoff_incoming_get',
        };
      },
      conversation: async (ref, principal) => {
        if (!holdsAny(principal, ['inbound.read']) || !uuid.safeParse(ref).success) return null;
        const mail = await otherMail.get(ref);
        return {
          kind: 'conversation',
          id: mail.id,
          label: mail.subject || 'Other mail',
          href: '/other-mail',
          names: [mail.fromName, mail.fromAddress].filter((name): name is string => name !== null),
        };
      },
      ticket: async (ref, principal) => {
        // `ticket.read` or the masked read: `viewRow` refuses anyone else and hides what the person may not see.
        const view = await runReadOnly(database, (db) => tickets.viewRow(ref, principal, db));
        const key = keys.format(view.t.number);
        return {
          kind: 'ticket',
          id: view.t.id,
          label: key,
          href: ticketHref(key),
          orgId: view.t.orgId,
        };
      },
      incident: async (ref, principal) => {
        if (!holdsAny(principal, ['ticket.read']) || !uuid.safeParse(ref).success) return null;
        const row = await incidents.get(ref);
        return { kind: 'incident', id: row.id, label: row.title, orgIds: row.orgIds };
      },
      alert: async (ref, principal) => {
        if (!holdsAny(principal, ['alert.read']) || !uuid.safeParse(ref).success) return null;
        const alert = await alerts.getOne(ref);
        return { kind: 'alert', id: alert.id, label: alert.title };
      },
      kb_article: async (ref, principal) => {
        if (!holdsAny(principal, ['kb.read']) || !uuid.safeParse(ref).success) return null;
        const article = await runReadOnly(database, (db) => kb.get(ref, db));
        return { kind: 'kb_article', id: article.id, label: article.title };
      },
      intent: async (ref, principal) => {
        if (!holdsAny(principal, ['ticket.read']) || !uuid.safeParse(ref).success) return null;
        const intent = await intents.get(ref);
        return { kind: 'intent', id: intent.id, label: intent.name };
      },
      org: async (ref, principal) => {
        if (
          !holdsAny(principal, ['ticket.read', 'ticket.read.org']) ||
          !uuid.safeParse(ref).success
        ) {
          return null;
        }
        const org = await orgs.get(ref, principal);
        return { kind: 'org', id: org.id, label: org.name, orgId: org.id };
      },
    };
  }

  resolve(context: AssistantContext | undefined, principal: Principal): Promise<ResolvedContext> {
    return resolveContext(context, principal, this.readers);
  }
}
