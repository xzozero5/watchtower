import { portalSubmittedSchema, type PortalSubmitted } from '@watchtower/shared';

/**
 * The confirmation page shows what the api answered to the submit. The answer travels in this
 * tab's `sessionStorage`, not in the URL, so the ticket number and the masked address do not end up
 * in history, logs or a shared link.
 */
export const SUBMITTED_KEY = 'wt-portal-submitted';

export function saveSubmitted(result: PortalSubmitted, storage: Storage = sessionStorage): void {
  try {
    storage.setItem(SUBMITTED_KEY, JSON.stringify(result));
  } catch {
    // Without storage the confirmation page says there is nothing to show; the email still arrives.
  }
}

/** The stored text, for `useSyncExternalStore` (a string is a stable snapshot). */
export function readSubmittedRaw(storage: Storage = sessionStorage): string | null {
  try {
    return storage.getItem(SUBMITTED_KEY);
  } catch {
    return null;
  }
}

export function parseSubmitted(raw: string | null): PortalSubmitted | null {
  if (raw === null) return null;
  try {
    const parsed = portalSubmittedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
