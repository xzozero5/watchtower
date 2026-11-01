import {
  OPEN_STATUSES,
  ticketPrioritySchema,
  ticketStatusSchema,
  type TicketPriority,
  type TicketStatus,
} from '@watchtower/shared';
import { z } from 'zod';

import type { TicketListParams } from '@/lib/api/endpoints';

export const ASSIGNEE_FILTERS = ['any', 'me', 'unassigned'] as const;
export type AssigneeFilter = (typeof ASSIGNEE_FILTERS)[number];

export const SORTS = ['created_desc', 'updated_desc', 'due_asc'] as const;
export type SortOrder = (typeof SORTS)[number];

export const queueFiltersSchema = z.object({
  status: z.array(ticketStatusSchema).max(8),
  priority: z.array(ticketPrioritySchema).max(4),
  assignee: z.enum(ASSIGNEE_FILTERS),
  q: z.string().max(200),
  overdue: z.boolean(),
  sort: z.enum(SORTS),
  /** A team queue and a specific person: set by links from Home, not by the filter bar. */
  queueId: z.uuid().optional(),
  assigneeId: z.uuid().optional(),
});
export type QueueFilters = z.infer<typeof queueFiltersSchema>;

/** The queue a person lands in: everything still open, newest first. */
export const DEFAULT_FILTERS: QueueFilters = {
  status: [...OPEN_STATUSES],
  priority: [],
  assignee: 'any',
  q: '',
  overdue: false,
  sort: 'created_desc',
};

/** Built-in views, shown before the saved ones. Their names are translated by id. */
export const BUILT_IN_VIEWS = [
  { id: 'open', filters: DEFAULT_FILTERS },
  { id: 'mine', filters: { ...DEFAULT_FILTERS, assignee: 'me' as const } },
  { id: 'unassigned', filters: { ...DEFAULT_FILTERS, assignee: 'unassigned' as const } },
  {
    id: 'overdue',
    filters: { ...DEFAULT_FILTERS, overdue: true, sort: 'due_asc' as const },
  },
  { id: 'all', filters: { ...DEFAULT_FILTERS, status: [] } },
] as const satisfies readonly { id: string; filters: QueueFilters }[];
export type BuiltInViewId = (typeof BUILT_IN_VIEWS)[number]['id'];

const sameSet = <T extends string>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((item) => b.includes(item));

export function filtersEqual(a: QueueFilters, b: QueueFilters): boolean {
  return (
    sameSet<TicketStatus>(a.status, b.status) &&
    sameSet<TicketPriority>(a.priority, b.priority) &&
    a.assignee === b.assignee &&
    a.q.trim() === b.q.trim() &&
    a.overdue === b.overdue &&
    a.sort === b.sort &&
    a.queueId === b.queueId &&
    a.assigneeId === b.assigneeId
  );
}

/** Maps the UI filters onto the api query. Empty lists and blank text are simply left out. */
export function filtersToParams(filters: QueueFilters): TicketListParams {
  const q = filters.q.trim();
  return {
    ...(filters.status.length > 0 ? { status: filters.status } : {}),
    ...(filters.priority.length > 0 ? { priority: filters.priority } : {}),
    ...(filters.assigneeId
      ? { assignee: filters.assigneeId }
      : filters.assignee === 'any'
        ? {}
        : { assignee: filters.assignee }),
    ...(filters.queueId ? { queueId: filters.queueId } : {}),
    ...(q === '' ? {} : { q }),
    ...(filters.overdue ? { overdue: true } : {}),
    sort: filters.sort,
    limit: 50,
  };
}

/** The view a set of filters matches, or null when it is a custom combination. */
export function matchBuiltInView(filters: QueueFilters): BuiltInViewId | null {
  return BUILT_IN_VIEWS.find((view) => filtersEqual(view.filters, filters))?.id ?? null;
}

export function activeFilterCount(filters: QueueFilters): number {
  const base = DEFAULT_FILTERS;
  return [
    !sameSet(filters.status, base.status),
    filters.priority.length > 0,
    filters.assignee !== 'any',
    filters.q.trim() !== '',
    filters.overdue,
    filters.queueId !== undefined,
    filters.assigneeId !== undefined,
  ].filter(Boolean).length;
}

/** The query parameters a link to the queue may carry. Anything else in the address is ignored. */
export const FILTER_PARAMS = [
  'status',
  'priority',
  'assignee',
  'overdue',
  'sort',
  'queueId',
] as const;

/**
 * Filters named in the address (`/?status=new,triage&assignee=unassigned&overdue=true`), as the
 * Home page links to them. Null when the address names none of them, so the default view stays.
 * Unknown values are dropped rather than trusted: this is text from the address bar.
 */
export function filtersFromSearch(search: string): QueueFilters | null {
  const params = new URLSearchParams(search);
  if (!FILTER_PARAMS.some((name) => params.has(name))) return null;
  const list = (name: string) =>
    (params.get(name) ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  const statuses = z.array(ticketStatusSchema).safeParse(list('status'));
  const priorities = z.array(ticketPrioritySchema).safeParse(list('priority'));
  const assignee = params.get('assignee');
  const sort = z.enum(SORTS).safeParse(params.get('sort'));
  const queueId = z.uuid().safeParse(params.get('queueId'));
  const assigneeUuid = z.uuid().safeParse(assignee);
  return {
    ...DEFAULT_FILTERS,
    status: params.has('status') ? (statuses.success ? statuses.data : []) : DEFAULT_FILTERS.status,
    priority: priorities.success ? priorities.data : [],
    assignee: assignee === 'me' || assignee === 'unassigned' ? assignee : 'any',
    overdue: params.get('overdue') === 'true',
    sort: sort.success ? sort.data : DEFAULT_FILTERS.sort,
    ...(queueId.success ? { queueId: queueId.data } : {}),
    ...(assigneeUuid.success ? { assigneeId: assigneeUuid.data } : {}),
  };
}

/** The address of the queue with these filters, for links from Home. */
export function queueHref(
  filters: Partial<{
    status: readonly TicketStatus[];
    /** `me`, `unassigned` or a user id. */
    assignee: string;
    overdue: boolean;
    sort: SortOrder;
    queueId: string;
  }>,
): string {
  const params = new URLSearchParams();
  if (filters.status && filters.status.length > 0) params.set('status', filters.status.join(','));
  if (filters.assignee) params.set('assignee', filters.assignee);
  if (filters.queueId) params.set('queueId', filters.queueId);
  if (filters.overdue) params.set('overdue', 'true');
  if (filters.sort) params.set('sort', filters.sort);
  const query = params.toString();
  return query === '' ? '/' : `/?${query}`;
}
