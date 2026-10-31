/**
 * A non-secret flag that this browser had a session. The tokens are HttpOnly cookies the page
 * cannot see, so without a hint every visit by a signed-out person would try to refresh a session
 * that does not exist, and each of those attempts is a failed `auth.refresh` on the audit log.
 * With the hint, only a browser that really was signed in tries.
 */
export const SESSION_HINT_KEY = 'wt-had-session';

export function markSignedIn(): void {
  try {
    localStorage.setItem(SESSION_HINT_KEY, '1');
  } catch {
    // Storage blocked: fall back to always trying (see hasSessionHint).
  }
}

export function markSignedOut(): void {
  try {
    localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    // Nothing to do.
  }
}

/** True when this browser signed in before, or when storage is unavailable (then try anyway). */
export function hasSessionHint(): boolean {
  try {
    return localStorage.getItem(SESSION_HINT_KEY) !== null;
  } catch {
    return true;
  }
}
