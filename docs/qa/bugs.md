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

### B-002 (P3) A LINE ticket from an unlinked user does not say "unverified" on the ticket

- **Found:** 2026-11-02, T-113 (`apps/web/e2e-fullstack/ac2-line.e2e.ts`).
- **Steps:** send a signed LINE webhook from a new user id; open the ticket in the workspace.
- **Expected (AC-2):** the ticket shows `unverified`.
- **Actual:** Details shows organization "Unidentified senders" and requester "LINE user", with no verification label. The state is visible only on Admin / Organizations / Unidentified senders / Contacts ("Unverified", "LINE not verified"), and as "Contact not verified" on an AI draft. The ticket JSON has no verification field.
- **Suggested fix (not applied):** a chip next to the requester in Details, fed by the contact's `verifiedAt`.
- **Status:** open, reported to main thread.

### B-003 (P3) No acknowledgment email for a new Gmail ticket (PRD 5.1 step 3C)

- **Found:** 2026-11-02, T-113 (`ac1-gmail.e2e.ts`, known-gap test with `test.fail`).
- **Actual:** the auto-ack (`apps/worker/src/ingest/auto-ack.ts`) is built for LINE only; nothing is sent into the thread of a new Gmail ticket. Check with the owner whether email is meant to be covered before calling it a bug.
- **Status:** open. Delete the `test.fail` line when built.

### B-004 (P3) a11y: `label-content-name-mismatch` on a link of the P1 critical banner

- **Found:** 2026-11-02, T-113, axe on `/shift/overview` with a real open P1 ticket (WCAG 2.5.3). Element: link with `aria-label="Open OPS-n"` styled as `BUTTON` in `apps/web/src/components/notifications/critical-banner.tsx` (`notifications.banner.openNamed`); the visible text is not contained in the name.
- **Status:** open, `[UNVERIFIED 70%]` that this is the only element. The test that found it (`ac7-shifts.e2e.ts`) is not committed (unfinished).

## Observations that are not bugs (recorded so nobody re-investigates them)

- A reply to a LINE ticket within ~50 s of the customer's last message uses the free reply token (not a push, quota unchanged). Correct per R-2.10; a push only follows after the token window.
- The stack's mock classifier gives text-dependent confidence, so the AI drafts alone for some mails and waits for "Draft a reply" for others (intent not trusted). Tests handle both.

- `GET /v1/auth/config` reports `devLoginEnabled: true` in mock mode, and `POST /v1/auth/dev-login` signs anyone in. Known: T-010 finding C-1, being fixed in `wip/t-010-fixes`. The full-stack e2e never uses dev login (staff use break-glass, clients the magic link), so the fix will not break it.
- The staff queue opens on the "open" view (statuses new to waiting_on_dev), so a client with 13 tickets sees 8 in the queue; resolved and closed ones are behind the "all" view. The RBAC test asserts that the queue equals the open tickets of the organization.
- The e2e signs staff in as the break-glass account, which has role `head`. Agent- and lead-specific permission limits are therefore not exercised through the browser yet (the api integration tests cover them). A follow-up could provision an agent through a mock identity provider once one is available for a running stack.

## ตรวจซ้ำ 2026-11-03 — PO quality sweep

- **B-001 ปิด [TESTED]:** ฟัง hashchange + refetch ด้วย revision ที่ไม่บรรจุ token; current401 revoke ตามเดิม แต่ stale GET/POST401 ไม่ลบลิงก์ใหม่; unit regression 29 กรณีผ่านโดย security reviewer (producer suite รวม store 40) และ browser same-document acceptance ผ่าน
- Fullstack เดิมที่ยังมี test.fail รันแล้ว B-001 **ผ่านโดยไม่ควรล้ม** (Expected to fail, but passed) จึงให้ QA คนละตัวนำ marker และ about:blank workaround ออก แล้วรัน suite ซ้ำ ดูผลสุดท้าย STATUS/รายงานรอบนี้
- ประวัติเดิมในหัวข้อ Open ด้านบนเก็บไว้ตามกฎ append-only; สถานะปัจจุบัน B-001 = closed ส่วน B-002/B-003/B-004 ต้องตรวจ/ปิดต่อแยก ห้ามตีความ browser gate ว่าปิด known gaps เหล่านี้แล้ว

## Closed

(none)
