import { CSAT_SCORE_FRAGMENT_KEY, CSAT_TOKEN_FRAGMENT_KEY } from '@watchtower/shared';

/**
 * The survey link is `/csat#token=<token>&score=<1-5>`. A fragment is never sent to a server and
 * never appears in a Referer header, but it stays in the address bar and in history, so the page
 * reads it once, removes it with `history.replaceState`, and keeps the token only for this tab: in
 * memory while the page is open and in `sessionStorage` so a reload keeps working.
 */

const STORAGE_KEY = 'wt-csat-link';
const MAX_TOKEN_LENGTH = 512;
/** Printable ASCII without whitespace. The api's links are URL-safe; anything else is not ours. */
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

export interface SurveyLink {
  readonly token: string;
  /** The rating chosen in the email, 1 to 5, when the link had one. */
  readonly score: number | null;
}

type BrowserWindow = Pick<Window, 'location' | 'history'> & { sessionStorage: Storage };

/** The token and score in a fragment, or null when there is no usable token. */
export function parseSurveyFragment(hash: string): SurveyLink | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(fragment);
  const token = params.get(CSAT_TOKEN_FRAGMENT_KEY);
  if (token === null || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  if (!TOKEN_SHAPE.test(token)) return null;
  const rawScore = params.get(CSAT_SCORE_FRAGMENT_KEY);
  const score = rawScore !== null && /^[1-5]$/.test(rawScore) ? Number(rawScore) : null;
  return { token, score };
}

function safeStorage(win: BrowserWindow): Storage | null {
  try {
    return win.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Takes the survey link from the address bar if it carries one (and removes it from there), else
 * from this tab's storage. Returns null when the tab has none.
 */
export function claimSurveyLink(win: BrowserWindow = window): SurveyLink | null {
  const storage = safeStorage(win);
  const fromFragment = parseSurveyFragment(win.location.hash);
  if (win.location.hash !== '') {
    win.history.replaceState(
      win.history.state as unknown,
      '',
      `${win.location.pathname}${win.location.search}`,
    );
  }
  if (fromFragment !== null) {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(fromFragment));
    } catch {
      // Quota or policy: keep going with the in-memory copy.
    }
    return fromFragment;
  }
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    if (stored === null || stored === undefined) return null;
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { token, score } = parsed as { token?: unknown; score?: unknown };
    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return null;
    return { token, score: typeof score === 'number' && score >= 1 && score <= 5 ? score : null };
  } catch {
    return null;
  }
}

/** Forgets the link in this tab, after the api said it no longer works or the survey is answered. */
export function forgetSurveyLink(win: BrowserWindow = window): void {
  try {
    safeStorage(win)?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}
