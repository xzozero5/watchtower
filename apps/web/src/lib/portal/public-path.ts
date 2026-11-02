/**
 * The public client portal lives under `/portal` and has no staff session. The session provider
 * (which wraps every page) uses this to skip `GET /v1/auth/session` there: a customer opening a
 * tracking link must not cause a call to the staff api, and a staff cookie on a shared device
 * must not be touched. The CSAT survey page (`/csat`, T-110b) and the status page (`/status`, T-204b) are public in the same way.
 */
export function isPortalPath(pathname: string): boolean {
  return (
    pathname === '/portal' ||
    pathname.startsWith('/portal/') ||
    pathname === '/csat' ||
    pathname.startsWith('/csat/') ||
    // The public status page (T-204b). `/status-page` is the staff admin and does need the session.
    pathname === '/status' ||
    pathname.startsWith('/status/')
  );
}

export function onPortalPage(): boolean {
  return typeof window !== 'undefined' && isPortalPath(window.location.pathname);
}
