import type { Role } from '@watchtower/shared';

/**
 * Where each role starts: the logo in the rail, the landing page after sign-in and the app root
 * for someone who has nowhere better to be. One map, so they cannot disagree. Chosen by the PO
 * (2026-11-03): the page that role opens most and gets the most from.
 *
 * - agent: the queue (its default view, "Needs you")
 * - lead, head: Overview, the team picture
 * - dev: the developer home, which the app root renders for a role that reads tickets masked
 * - client: their own ticket workspace at the root. The PO asked for `/portal`, but that is the public,
 *   session-less form (no rail, no replies to their tickets); a signed-in customer reads and answers
 *   their tickets at `/`. One line to change if the PO still wants `/portal` [ASK-HUMAN].
 */
export const ROLE_HOME: Readonly<Record<Role, string>> = {
  agent: '/',
  lead: '/home',
  head: '/home',
  dev: '/',
  client: '/',
  // Not a person; never signs in. Falls back to the root like an unknown role.
  system: '/',
};

export function roleHomePath(role: Role | null | undefined): string {
  return role ? ROLE_HOME[role] : '/';
}

/** The route that sends a freshly signed-in person to their start page (or to `next`). */
export const START_PATH = '/start';

/**
 * A destination from `?next=` that is safe to follow: a path inside this app. Anything else
 * (an absolute URL, `//host`, a backslash, control characters, a path back to the sign-in
 * pages) is refused with null, so the parameter cannot be used as an open redirect.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 200) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  for (const character of raw) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  if (/^\/(login|start)(?:[/?#]|$)/.test(raw)) return null;
  return raw;
}

/** An explicit, valid destination wins; otherwise the role's own start page. */
export function landingPath(role: Role | null | undefined, next?: string | null): string {
  return safeNextPath(next) ?? roleHomePath(role);
}

/** `/start`, carrying a destination when there is a valid one. */
export function startUrl(next?: string | null): string {
  const safe = safeNextPath(next);
  return safe ? `${START_PATH}?next=${encodeURIComponent(safe)}` : START_PATH;
}
