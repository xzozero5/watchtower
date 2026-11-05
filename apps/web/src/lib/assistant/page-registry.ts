import {
  assistantEntityRefSchema,
  ticketRefSchema,
  type AssistantEntity,
  type AssistantPage,
} from '@watchtower/shared';

/**
 * Every route of the `(console)` group and what the assistant calls it (ADR-029 section 1, T-406).
 * A route that is missing here is a failing test (`page-registry.test.ts` walks `app/(console)`), so a
 * new page cannot ship without deciding its assistant page and its entity. Public routes (portal,
 * status, csat, start, login) have no entry on purpose and their layouts never import the assistant.
 *
 * The entity is a hint read from the address; the server resolves it with the person's own access.
 */
export interface RouteEntry {
  /** The Next.js path with `[param]` segments, for example `/admin/orgs/[id]`. */
  readonly route: string;
  readonly page: AssistantPage;
  /** The page kind when an entity is open on it (the queue becomes `ticket` once a ticket is open). */
  readonly pageWithEntity?: AssistantPage;
  /** Reads what is open from the dynamic params and the query string. Null when nothing is. */
  readonly entity?: (input: {
    params: Record<string, string>;
    search: URLSearchParams;
  }) => AssistantEntity | null;
}

const ref = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  return assistantEntityRefSchema.safeParse(value).success ? value : null;
};

const fromQuery =
  (kind: AssistantEntity['kind'], name: string): RouteEntry['entity'] =>
  ({ search }) => {
    const value = ref(search.get(name));
    return value === null ? null : { kind, ref: value };
  };

const fromParam =
  (kind: AssistantEntity['kind'], name: string): RouteEntry['entity'] =>
  ({ params }) => {
    const value = ref(params[name]);
    return value === null ? null : { kind, ref: value };
  };

export const PAGE_REGISTRY: readonly RouteEntry[] = [
  {
    route: '/',
    page: 'queue',
    pageWithEntity: 'ticket',
    entity: ({ search }) => {
      const parsed = ticketRefSchema.safeParse(search.get('ticket'));
      return parsed.success ? { kind: 'ticket', ref: parsed.data } : null;
    },
  },
  { route: '/tickets/new', page: 'queue' },
  { route: '/home', page: 'dashboard' },
  { route: '/dashboard', page: 'dashboard' },
  { route: '/dashboard/ceo', page: 'dashboard' },
  { route: '/dashboard/ceo/brief', page: 'reports' },
  { route: '/dashboard/cost', page: 'reports' },
  { route: '/incidents', page: 'incident', entity: fromQuery('incident', 'incident') },
  { route: '/alerts', page: 'alert', entity: fromQuery('alert', 'alert') },
  { route: '/alerts/services', page: 'alert' },
  { route: '/status-page', page: 'statuspage' },
  { route: '/other-mail', page: 'other' },
  { route: '/shift', page: 'shift' },
  { route: '/shift/overview', page: 'shift' },
  { route: '/shift/notes', page: 'shift' },
  { route: '/shift/brief', page: 'brief' },
  { route: '/shift/handoff', page: 'handoff' },
  { route: '/admin', page: 'admin' },
  { route: '/admin/ai', page: 'autonomy' },
  { route: '/admin/audit', page: 'admin' },
  { route: '/admin/golden', page: 'autonomy' },
  { route: '/admin/integrations', page: 'admin' },
  { route: '/admin/intents', page: 'autonomy' },
  { route: '/admin/intents/[id]', page: 'autonomy', entity: fromParam('intent', 'id') },
  { route: '/admin/orgs', page: 'admin' },
  { route: '/admin/orgs/[id]', page: 'admin', entity: fromParam('org', 'id') },
  { route: '/admin/outbox', page: 'admin' },
  { route: '/admin/queues', page: 'admin' },
  { route: '/admin/shifts', page: 'roster' },
  { route: '/admin/sla', page: 'admin' },
  { route: '/admin/sla/calendars/[id]', page: 'admin' },
  { route: '/admin/users', page: 'admin' },
];

const segments = (path: string): string[] => path.split('/').filter((part) => part !== '');

/** The entry for an address, with the dynamic params it matched. Null for a route that has none. */
export function matchRoute(
  pathname: string,
): { entry: RouteEntry; params: Record<string, string> } | null {
  const actual = segments(pathname);
  for (const entry of PAGE_REGISTRY) {
    const pattern = segments(entry.route);
    if (pattern.length !== actual.length) continue;
    const params: Record<string, string> = {};
    const ok = pattern.every((part, index) => {
      const value = actual[index] ?? '';
      if (part.startsWith('[') && part.endsWith(']')) {
        try {
          params[part.slice(1, -1)] = decodeURIComponent(value);
        } catch {
          return false;
        }
        return true;
      }
      return part === value;
    });
    if (ok) return { entry, params };
  }
  return null;
}

/** What the assistant knows of where the person is: the page kind and the open entity. */
export function resolveLocation(
  pathname: string,
  search: string,
): { page: AssistantPage; entity: AssistantEntity | null } {
  const found = matchRoute(pathname);
  if (found === null) return { page: 'other', entity: null };
  const entity =
    found.entry.entity?.({ params: found.params, search: new URLSearchParams(search) }) ?? null;
  return {
    page:
      entity !== null && found.entry.pageWithEntity ? found.entry.pageWithEntity : found.entry.page,
    entity,
  };
}

/** The Next.js route of a `page.tsx` path under `app` (used by the test). */
export function routeOfPageFile(relative: string): string {
  const parts = relative
    .replace(/\\/g, '/')
    .replace(/\/?page\.tsx$/, '')
    .split('/')
    .filter((part) => part !== '' && !/^\(.*\)$/.test(part));
  return `/${parts.join('/')}`;
}
