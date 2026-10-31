# QA bug log

Bugs found by `qa-engineer`. One entry per bug: `B-xxx`, severity, steps, expected, actual, evidence,
status. Severity: P1 data loss / security / blocks a core flow, P2 wrong behaviour with a workaround,
P3 cosmetic or rare, P4 polish. Developers fix; QA verifies. Do not edit an entry's history, add to it.

## Open

### B-001 (P3) Tracking page stays stale when a newer emailed link differs only in the `#fragment`

- **Found:** 2026-11-01, T-009 full-stack e2e (`apps/web/e2e-fullstack/ac1-portal.e2e.ts`).
- **Area:** `apps/web` portal tracking page (`components/portal/tracking-page.tsx`, `lib/portal/tracking-token.ts`).
- **Steps**
  1. Submit a request on the portal; open the tracking link from the confirmation email. The page shows the ticket as "Received".
  2. A staff member replies. The customer gets "New reply on OPS-n" with a new tracking link (every email carries a fresh link).
  3. In the same tab (address bar, or a link that targets the open tab) go to the new link. Only the `#token=...` part differs from the address already open.
- **Expected:** the page shows the reply (the new link is used, or at least the data is fetched again).
- **Actual:** the browser treats it as a same-document navigation; the page is not reloaded, `claimIntoStore` does not run again (it runs once on mount) and the timeline is not refetched. The customer still sees the old conversation and status until they reload by hand. The query refetches on window focus once its data is 15 s old (`refetchOnWindowFocus`), which softens this for a person but does not fire in automation. The comment on `claimIntoStore` says a link with a fresh fragment "always wins", but the effect that calls it depends only on `ticketKey`, so it does not run for a same-document fragment change.
- **Why P3:** a mail client normally opens a link in a new tab, which loads fresh; the stale page needs the same ticket already open in the tab. The old token keeps working, so nothing is lost; the page is just out of date.
- **Evidence:** failing run of the AC-1 scenario before the test opened links through `about:blank` (page snapshot: heading `OPS-1031`, status "Received", only the customer's first message, the reply missing). The known-bug test `B-001: a newer emailed link opened in the same tab shows the new reply` is marked `test.fail()`; it goes red when the bug is fixed, which is the signal to remove that marker.
- **Suggested fix (not applied, app code):** listen to `hashchange` and re-claim the token, then invalidate the ticket query; or refetch on `visibilitychange`/focus.
- **Status:** open, reported to main thread.

## Observations that are not bugs (recorded so nobody re-investigates them)

- `GET /v1/auth/config` reports `devLoginEnabled: true` in mock mode, and `POST /v1/auth/dev-login` signs anyone in. Known: T-010 finding C-1, being fixed in `wip/t-010-fixes`. The full-stack e2e never uses dev login (staff use break-glass, clients the magic link), so the fix will not break it.
- The staff queue opens on the "open" view (statuses new to waiting_on_dev), so a client with 13 tickets sees 8 in the queue; resolved and closed ones are behind the "all" view. The RBAC test asserts that the queue equals the open tickets of the organization.
- The e2e signs staff in as the break-glass account, which has role `head`. Agent- and lead-specific permission limits are therefore not exercised through the browser yet (the api integration tests cover them). A follow-up could provision an agent through a mock identity provider once one is available for a running stack.

## Closed

(none)
