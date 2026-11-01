import type { SavedView } from '@watchtower/shared';

import {
  BUILT_IN_VIEWS,
  type BuiltInViewId,
  filtersFromView,
  type QueueFilters,
  SYSTEM_VIEW_OF,
} from './filters';

/** A view somebody saved (T-119a), as the view switcher lists it. */
export interface ViewOption {
  id: string;
  name: string;
  filters: QueueFilters;
  /** Shared with the whole team (`view.share`). */
  shared: boolean;
  ownerName: string | null;
  /** Whether the person may delete it. */
  editable: boolean;
  count: number | null;
}

/** The views the server lists that are not built in: the team's, then the person's own. */
export function viewOptions(items: readonly SavedView[]): ViewOption[] {
  return items
    .filter((view) => view.kind !== 'system')
    .map((view) => ({
      id: view.id,
      name: view.name,
      filters: filtersFromView(view),
      shared: view.kind === 'shared',
      ownerName: view.ownerName,
      editable: view.editable,
      count: view.count,
    }));
}

/** The number beside each built-in view, from the server's view of the same name. */
export function builtInCounts(
  items: readonly SavedView[],
): Partial<Record<BuiltInViewId, number>> {
  const byKey = new Map(items.flatMap((view) => (view.key ? [[view.key, view.count] as const] : [])));
  const counts: Partial<Record<BuiltInViewId, number>> = {};
  for (const view of BUILT_IN_VIEWS) {
    const key = SYSTEM_VIEW_OF[view.id];
    const count = key === undefined ? null : (byKey.get(key) ?? null);
    if (count !== null) counts[view.id] = count;
  }
  return counts;
}
