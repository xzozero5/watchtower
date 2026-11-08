import { schema, type Database } from '@watchtower/db';
import type { InsightRef, InsightRefKind, Permission } from '@watchtower/shared';
import { inArray } from 'drizzle-orm';

import { runReadOnly } from '../assistant/read-only.js';
import type { Principal } from '../auth/principal.js';
import { refKey, type ResolvedRef } from './insight-claims.js';

/**
 * What a viewer may open behind a ref (ADR-029 section 9.3 "restore"). The viewer already passed the rule of the
 * element; this decides the chips: a ref to a customer needs the unmasked read of tickets, a person needs the
 * permission of the people screens (or is the viewer), and so on. A ref the viewer cannot open becomes a "No access"
 * chip and its label is never read.
 */
const PERMITS: Readonly<Record<InsightRefKind, readonly Permission[]>> = {
  user: ['roster.manage', 'performance.read.all'],
  org: ['ticket.read', 'ticket.read.org'],
  contact: ['ticket.read', 'ticket.read.org'],
  intent: ['ticket.read', 'ticket.read.masked'],
  queue: ['ticket.read', 'ticket.read.masked'],
  incident: ['ticket.read'],
  ticket: ['ticket.read', 'ticket.read.masked'],
  alert: ['alert.read'],
  service: ['alert.read', 'ticket.read'],
  shift: ['shift.clock', 'roster.manage'],
};

/** Pages of the web that exist (no page for an org or a ticket by id here: a ticket opens by key). */
const HREFS: Partial<
  Record<InsightRefKind, (id: string, viewer: Principal) => string | undefined>
> = {
  intent: (id, viewer) =>
    viewer.permissions.has('intent.manage') ? `/admin/intents/${id}` : undefined,
  incident: () => '/incidents',
  alert: () => '/alerts',
  service: () => '/alerts/services',
};

/** Kinds that have no name to show; the chip says what they are. */
const GENERIC: Readonly<Partial<Record<InsightRefKind, { th: string; en: string }>>> = {
  incident: { th: 'Incident', en: 'Incident' },
  alert: { th: 'Alert', en: 'Alert' },
  ticket: { th: 'Ticket', en: 'Ticket' },
  shift: { th: 'กะ', en: 'Shift' },
  contact: { th: 'ผู้ติดต่อ', en: 'Contact' },
};

export function mayOpenRef(viewer: Principal, ref: InsightRef): boolean {
  if (ref.kind === 'user' && ref.id === viewer.userId) return true;
  return PERMITS[ref.kind].some((permission) => viewer.permissions.has(permission));
}

type Names = ReadonlyMap<string, string>;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function namesOf(
  database: Pick<Database, 'pool'>,
  refs: readonly InsightRef[],
): Promise<Map<string, string>> {
  const ids = (kind: InsightRefKind): string[] => [
    ...new Set(
      refs.filter((ref) => ref.kind === kind && UUID_REGEX.test(ref.id)).map((ref) => ref.id),
    ),
  ];
  const out = new Map<string, string>();
  await runReadOnly(database, async (db) => {
    const users = ids('user');
    if (users.length > 0) {
      for (const row of await db
        .select({ id: schema.users.id, name: schema.users.name })
        .from(schema.users)
        .where(inArray(schema.users.id, users))) {
        out.set(`user:${row.id}`, row.name);
      }
    }
    const orgs = ids('org');
    if (orgs.length > 0) {
      for (const row of await db
        .select({ id: schema.organization.id, name: schema.organization.name })
        .from(schema.organization)
        .where(inArray(schema.organization.id, orgs))) {
        out.set(`org:${row.id}`, row.name);
      }
    }
    const intents = ids('intent');
    if (intents.length > 0) {
      for (const row of await db
        .select({ id: schema.intent.id, name: schema.intent.name })
        .from(schema.intent)
        .where(inArray(schema.intent.id, intents))) {
        out.set(`intent:${row.id}`, row.name);
      }
    }
    const queues = ids('queue');
    if (queues.length > 0) {
      for (const row of await db
        .select({ id: schema.teamQueue.id, name: schema.teamQueue.name })
        .from(schema.teamQueue)
        .where(inArray(schema.teamQueue.id, queues))) {
        out.set(`queue:${row.id}`, row.name);
      }
    }
    const services = ids('service');
    if (services.length > 0) {
      for (const row of await db
        .select({ id: schema.service.id, name: schema.service.name })
        .from(schema.service)
        .where(inArray(schema.service.id, services))) {
        out.set(`service:${row.id}`, row.name);
      }
    }
  });
  return out;
}

/**
 * Labels and pages for `refs`, with this viewer's rights. A ref the viewer may not open, or that no longer exists,
 * is `allowed: false` (the two look the same). Names come from the catalogs a staff member keeps.
 */
export async function resolveRefs(
  database: Pick<Database, 'pool'>,
  viewer: Principal,
  refs: readonly InsightRef[],
  locale: 'th' | 'en',
): Promise<Map<string, ResolvedRef>> {
  const permitted = refs.filter((ref) => mayOpenRef(viewer, ref));
  const names: Names = permitted.length === 0 ? new Map() : await namesOf(database, permitted);
  const out = new Map<string, ResolvedRef>();
  for (const ref of refs) {
    const key = refKey(ref);
    if (!permitted.includes(ref)) {
      out.set(key, { allowed: false, label: '' });
      continue;
    }
    const generic = GENERIC[ref.kind];
    const label = generic === undefined ? names.get(key) : generic[locale];
    if (label === undefined) {
      out.set(key, { allowed: false, label: '' });
      continue;
    }
    const href = HREFS[ref.kind]?.(ref.id, viewer);
    out.set(key, { allowed: true, label, ...(href === undefined ? {} : { href }) });
  }
  return out;
}
