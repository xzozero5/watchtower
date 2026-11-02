import { safeHref } from '@/lib/ai/model';

/** The org page the investigation tools name; the app has no page at this path. */
const ORG_PATH = /^\/orgs\/([0-9A-Za-z-]+)\/?$/;

/**
 * The link to open an evidence source from, or null when there is none worth showing. The
 * organization evidence points at `/orgs/<id>`, which is a 404: the page that exists is the admin
 * one (`/admin/orgs/<id>`, `org.manage`), so someone who may open it gets that, and everyone else
 * gets no link at all rather than a dead one.
 */
export function evidenceHref(href: string | undefined, canOpenOrgs: boolean): string | null {
  const safe = safeHref(href);
  if (safe === null) return null;
  const org = ORG_PATH.exec(safe);
  if (org?.[1]) return canOpenOrgs ? `/admin/orgs/${org[1]}` : null;
  return safe;
}
