/**
 * The public client portal lives under `/portal` and has no staff session. The session provider
 * (which wraps every page) uses this to skip `GET /v1/auth/session` there: a customer opening a
 * tracking link must not cause a call to the staff api, and a staff cookie on a shared device
 * must not be touched. The CSAT survey page (`/csat`, T-110b) is public in the same way.
 */
export function isPortalPath(pathname: string): boolean {
  return (
    pathname === '/portal' ||
    pathname.startsWith('/portal/') ||
    pathname === '/csat' ||
    pathname.startsWith('/csat/')
  );
}

export function onPortalPage(): boolean {
  return typeof window !== 'undefined' && isPortalPath(window.location.pathname);
}
