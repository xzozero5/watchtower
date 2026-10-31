import { z } from 'zod';

import { queueFiltersSchema, type QueueFilters } from './filters';

/**
 * Saved views live in this browser only for now (T-006); a server-side, shareable version comes
 * with the preferences API. The key includes the user id so two people sharing a browser profile
 * do not see each other's views.
 */
export const SAVED_VIEWS_KEY_PREFIX = 'wt-saved-views:v1:';
export const MAX_SAVED_VIEWS = 20;
export const MAX_VIEW_NAME = 60;

export const savedViewSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(MAX_VIEW_NAME),
  filters: queueFiltersSchema,
});
export type SavedView = z.infer<typeof savedViewSchema>;

const storedSchema = z.array(z.unknown());

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const keyFor = (userId: string) => `${SAVED_VIEWS_KEY_PREFIX}${userId}`;

/** Reads the views, dropping any entry that does not parse (a hand-edited or older value). */
export function loadSavedViews(storage: KeyValueStorage | null, userId: string): SavedView[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(keyFor(userId));
    if (raw === null) return [];
    const list = storedSchema.safeParse(JSON.parse(raw));
    if (!list.success) return [];
    const views: SavedView[] = [];
    for (const entry of list.data) {
      const parsed = savedViewSchema.safeParse(entry);
      if (parsed.success) views.push(parsed.data);
    }
    return views.slice(0, MAX_SAVED_VIEWS);
  } catch {
    return [];
  }
}

export function persistSavedViews(
  storage: KeyValueStorage | null,
  userId: string,
  views: readonly SavedView[],
): void {
  if (!storage) return;
  try {
    storage.setItem(keyFor(userId), JSON.stringify(views.slice(0, MAX_SAVED_VIEWS)));
  } catch {
    // Storage full or blocked: the view lasts until the page closes, which is better than an error.
  }
}

export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Adds a view, or replaces the one with the same name (case-insensitive). Returns the new list. */
export function upsertView(
  views: readonly SavedView[],
  name: string,
  filters: QueueFilters,
  makeId: () => string,
): SavedView[] {
  const trimmed = name.trim().slice(0, MAX_VIEW_NAME);
  if (trimmed === '') return [...views];
  const existing = views.find((view) => view.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) {
    return views.map((view) => (view === existing ? { ...view, name: trimmed, filters } : view));
  }
  if (views.length >= MAX_SAVED_VIEWS) return [...views];
  return [...views, { id: makeId(), name: trimmed, filters }];
}

export function removeView(views: readonly SavedView[], id: string): SavedView[] {
  return views.filter((view) => view.id !== id);
}
