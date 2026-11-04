import {
  portalMyRequestsViewSchema,
  type PortalMyRequestItem,
  type PortalMyRequestsView,
} from '@watchtower/shared';

import { rememberTrackingToken } from './tracking-token';

/**
 * The opened "my requests" list (T-152) lives in this tab only. The link works once, so a reload
 * would otherwise lose the list: it is kept in `sessionStorage` (cleared when the tab closes) as the
 * list itself, WITHOUT the per-ticket tokens. Those go to the same place the tracking page reads its
 * token from (`rememberTrackingToken`), so a row opens its ticket and nothing credential-like sits
 * in the list, a URL or the history.
 */

const STORAGE_KEY = 'wt-portal-my-requests';

type BrowserWindow = Pick<Window, 'location' | 'history'> & { sessionStorage: Storage };

function safeStorage(win: BrowserWindow): Storage | null {
  try {
    return win.sessionStorage;
  } catch {
    return null;
  }
}

/** The list without its tokens: what is safe to keep and to show. */
export function withoutTokens(view: PortalMyRequestsView): PortalMyRequestsView {
  return {
    ...view,
    items: view.items.map((item): PortalMyRequestItem => ({ ...item, trackingToken: null })),
  };
}

/** Hands each ticket its token for the tracking page and keeps the list (tokens removed) for reloads. */
export function keepOpenedList(view: PortalMyRequestsView, win: BrowserWindow = window): void {
  for (const item of view.items) {
    if (item.trackingToken !== null) rememberTrackingToken(item.key, item.trackingToken, win);
  }
  try {
    safeStorage(win)?.setItem(STORAGE_KEY, JSON.stringify(withoutTokens(view)));
  } catch {
    // Quota or policy: the list is shown now and asked for again after a reload.
  }
}

/** The list this tab opened earlier, or null. */
export function loadOpenedList(win: BrowserWindow = window): PortalMyRequestsView | null {
  try {
    const raw = safeStorage(win)?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return null;
    const parsed = portalMyRequestsViewSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function forgetOpenedList(win: BrowserWindow = window): void {
  try {
    safeStorage(win)?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}
