import { PORTAL_TOKEN_FRAGMENT_KEY } from '@watchtower/shared';

/**
 * The tracking link is `/portal/tickets/<KEY>#token=<token>`. A fragment is never sent to a server
 * and never appears in a Referer header, but it stays in the address bar and in history, so the
 * page reads it once, removes it with `history.replaceState`, and keeps the token only for this
 * tab: in memory while the page is open and in `sessionStorage` so a reload keeps working.
 */

const STORAGE_PREFIX = 'wt-portal-token:';
const MAX_TOKEN_LENGTH = 512;
/** Printable ASCII without whitespace. The api's tokens are URL-safe; anything else is not ours. */
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

/** The token in `#token=...`, or null when the fragment has none or something odd. */
export function parseFragmentToken(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const value = new URLSearchParams(fragment).get(PORTAL_TOKEN_FRAGMENT_KEY);
  if (value === null || value.length === 0 || value.length > MAX_TOKEN_LENGTH) return null;
  return TOKEN_SHAPE.test(value) ? value : null;
}

type BrowserWindow = Pick<Window, 'location' | 'history'> & { sessionStorage: Storage };

function storageKey(ticketKey: string): string {
  return `${STORAGE_PREFIX}${ticketKey.toUpperCase()}`;
}

function safeStorage(win: BrowserWindow): Storage | null {
  try {
    return win.sessionStorage;
  } catch {
    // Storage can be blocked (private modes, policies). The token then lives in memory only.
    return null;
  }
}

/** Removes the fragment from the address bar without adding a history entry. */
export function stripFragment(win: Pick<Window, 'location' | 'history'>): void {
  const { pathname, search } = win.location;
  win.history.replaceState(win.history.state as unknown, '', `${pathname}${search}`);
}

/**
 * Takes the token for `ticketKey` from the address bar if it carries one (and removes it from
 * there), else from this tab's storage. Returns null when the tab has no token.
 */
export function claimTrackingToken(ticketKey: string, win: BrowserWindow = window): string | null {
  const storage = safeStorage(win);
  const fromFragment = parseFragmentToken(win.location.hash);
  if (win.location.hash !== '') stripFragment(win);
  if (fromFragment !== null) {
    try {
      storage?.setItem(storageKey(ticketKey), fromFragment);
    } catch {
      // Quota or policy: keep going with the in-memory copy.
    }
    return fromFragment;
  }
  try {
    return storage?.getItem(storageKey(ticketKey)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Keeps a token for `ticketKey` in this tab's storage without putting it in the address bar: the
 * "my requests" list hands over one per open request, and the ticket page then finds it where it
 * looks for a token that is not in the fragment (T-152).
 */
export function rememberTrackingToken(
  ticketKey: string,
  token: string,
  win: BrowserWindow = window,
): void {
  try {
    safeStorage(win)?.setItem(storageKey(ticketKey), token);
  } catch {
    // Quota or policy: the ticket page then asks for a link, as it does for an expired one.
  }
  // A ticket page opened earlier in this tab may have remembered "no token": ask storage again.
  claimed.delete(ticketKey);
}

/** Forgets the token of a ticket, for example after the api said it no longer works. */
export function forgetTrackingToken(ticketKey: string, win: BrowserWindow = window): void {
  try {
    safeStorage(win)?.removeItem(storageKey(ticketKey));
  } catch {
    // Nothing to forget.
  }
}

// --- the tab's in-memory copy, shaped for useSyncExternalStore ---

const claimed = new Map<string, string | null>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeToClaims(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `undefined` until `claimIntoStore` ran for this ticket, then the value or `null`. */
export function claimedToken(ticketKey: string): string | null | undefined {
  return claimed.get(ticketKey);
}

/**
 * Claims the value for `ticketKey` (see `claimTrackingToken`) and publishes it to subscribers. Run
 * it from an effect: it changes the address bar. A link with a fresh fragment always wins over what
 * the tab already holds.
 */
export function claimIntoStore(ticketKey: string, win: BrowserWindow = window): void {
  if (claimed.has(ticketKey) && win.location.hash === '') return;
  claimed.set(ticketKey, claimTrackingToken(ticketKey, win));
  notify();
}

/** Forgets the value everywhere in this tab (memory and storage). */
export function dropFromStore(ticketKey: string, win: BrowserWindow = window): void {
  forgetTrackingToken(ticketKey, win);
  claimed.set(ticketKey, null);
  notify();
}

/** Tests only: start from a tab that has claimed nothing. */
export function resetClaimedTokens(): void {
  claimed.clear();
  notify();
}
