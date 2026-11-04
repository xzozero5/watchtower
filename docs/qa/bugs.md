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
- **Update 2026-11-04 (AC-7 spec finished):** the element axe reports is the notification bell in the rail (`components/notifications/notification-center.tsx`, `data-testid="notification-bell"`), and also the banner link (`Open OPS-n`, as first suspected), in the same run. The bell: `aria-label="Notifications, 1 unread"` while the visible text reads "1" (the badge, placed before the title in the DOM) then "Notifications". It shows whenever the user has an unread notification, on any page. `[UNVERIFIED 70%]` for the cause (the order of badge and title); `ac7-shifts.e2e.ts` excludes both from the scan with a comment pointing here; remove the two `exclude` lines when fixed.
- **Status:** fixed 2026-11-04 (T-178) `[TESTED]` at component level; the fullstack e2e (`ac7-shifts.e2e.ts`) no longer excludes either element, but it was not run on this branch `[UNVERIFIED]`. Banner link name is now `Open ticket OPS-n` (visible text `Open ticket`); the bell renders its title before the badge in the DOM (CSS `order` keeps the icon first) so the visible text `Notifications 1` is contained in `Notifications, 1 unread`; the Thai unread label was reworded to start with the visible title and put the count right after it.

- **Update 2026-11-04 (T-207 pass, QA):** the T-178 fix was **not enough**: full-stack `ac7-shifts.e2e.ts` still failed on `label-content-name-mismatch` for the bell (`aria-label="Notifications 1 unread"`). Cause `[TESTED]`: the title and the badge are two adjacent `<span>`s with nothing between them, and axe joins their text as `Notifications1`, which is not contained in `Notifications 1 unread` (reproduced on a bare HTML page: no space fails, a space passes). Fixed by a `{' '}` between the two spans (rendered nothing in a flex row). Full-stack ac7 passes with it `[TESTED]`.

### B-005 (P2) ClamAV container never starts clamd: `LogFile /dev/stdout` (T-180)

- **Found:** 2026-11-04, first run of `clamav/clamav:1.5.3` with `config/clamav/clamd.conf` and the compose caps.
- **Actual:** `ERROR: Failed to open log file /dev/stdout: Symbolic link loop`, then the entrypoint waits for a socket that never comes (1800 s). clamd refuses to open a symlink as its log file, so it exits before it listens; the `scan` profile would sit unhealthy and every upload would stay `pending`.
- **Fix applied:** no `LogFile` line; with `Foreground yes` clamd logs to the console (`docker logs`). `clamd-config.test.ts` pins it. `[TESTED]` on the real image with `cap_drop ALL` + CHOWN/SETUID/SETGID/DAC_OVERRIDE/FOWNER and `no-new-privileges`.

### B-006 (P2) ClamAV healthcheck can never pass (T-180)

- **Found:** 2026-11-04. `clamdcheck.sh` of the image pings `localhost`, which resolves to `::1` first; clamd listens on IPv4 only (`TCPAddr 0.0.0.0`) so it prints "Unable to contact server" forever and the container stays `starting`/`unhealthy`.
- **Fix applied:** compose healthcheck is the same PING against `127.0.0.1` (`nc -w 3`). `[TESTED]` healthy after ~30 s with signatures already in the volume.

### B-007 (P2, open, risk) ClamAV answers OK for an archive whose member is larger than `MaxFileSize` / `MaxScanSize` (T-180)

- **Found:** 2026-11-04. With `AlertExceedsMax yes`, `MaxFileSize 25M`, `MaxScanSize 100M`: a zip holding a 30 MB member and one holding a 150 MB member (both a few hundred KB on the wire) are answered `OK` by INSTREAM and by `clamdscan`; `clamscan --debug` shows only ~27 MiB of the 150 MB scanned and no `Heuristics.Limits.Exceeded`. A password-protected zip is caught (`Heuristics.Encrypted.Zip FOUND`), a top-level stream over `StreamMaxLength` is an `ERROR` (never served).
- **Impact:** the part of a large archive member beyond ~25 MB is never looked at, yet the file is marked `clean`. Not fixable by `clamd.conf` as far as tested; options for the owner: reject archive types (or archives whose declared uncompressed size is large) at upload, or accept the risk for staff-only downloads. Recorded in `docs/runbooks/local-poc.md` 5c. `[ASK-HUMAN]` for the decision.

### B-008 (P3, test, fixed) `ac4-kb.e2e.ts` failed about half the runs

- **Found:** 2026-11-04 (main regression). The test read the first hit of the article for "webhook retry" and expected section "Backoff schedule". The title chunk and that section score the same in the keyword list (`word_similarity` 1 for both words) and ties are broken by chunk id (a random uuid), so either can come first. Not an app bug (up to two chunks of one article are returned by design); the test now looks at the article's hits as a set. Passed in the 3 full runs after the change. Related, not fixed: `ac1-gmail` "5.1 step 4" (a KB card with a section citation) failed once in 3 runs with the same kind of tie in the brief's KB retrieval; it needs the owner of the retrieval ordering.

### B-009 (P3) "AI meant to send but was held" shows an unexplained code for four of the reasons (T-304g / T-306e)

- **Found:** 2026-11-05, T-306b (`apps/web/e2e-fullstack/stage3-autosend.e2e.ts`, flag ON).
- **Area:** `apps/web/src/i18n/messages/{en,th}/stage3.ts` (`held`), `components/conversation/timeline.tsx` (`heldUnknown`).
- **Steps:** with the flag on, a stage 3 intent with no passing replay gets a ticket; open it in the workspace.
- **Expected:** the note says why in words, like the other reasons ("the reply does not cite a customer-facing article").
- **Actual:** the reason codes `replay_missing`, `procedure_requires_human`, `escalation_pending` and `ai_run_missing` (added by T-306e, migration 0108-0110) have no entry in `stage3.held`, so the line reads `the check "replay_missing" did not pass` (the `heldUnknown` fallback). The person who picks up the draft cannot tell a missing replay from a real fault.
- **Suggested fix (not applied, app code):** add the four codes to `stage3.held` in TH and EN (and a unit test that every `GATE_REASONS` value has copy in both languages).
- **Status:** open, reported to main thread.

### B-011 (P3) A refused promotion request carries no `reason` code over HTTP, against its OpenAPI text (T-304d)

- **Found:** 2026-11-05, T-306b (`stage3-autosend.e2e.ts`, "eval gate").
- **Steps:** `POST /v1/intents/:id/autonomy/promotions` with a gate report that is not green (an intent with no replay: `eval_replay_violations` is `not_measured`).
- **Expected:** 403 with the `reason` code the OpenAPI description of the route promises (`report_not_green`, `window_not_at_stage_2`, `pinned`, `stage_cap_on`, ...). The domain builds it: `DomainError('policy_denied', ..., { reason })` in `packages/domain/src/autonomy/promotion.ts`.
- **Actual:** `{"statusCode":403,"error":"Forbidden","code":"forbidden","message":"This intent cannot be promoted now"}`. `toHttpError` in `apps/api/src/domain/domain-errors.ts` maps `policy_denied` to `forbidden(message)` and drops `details`. The same holds for `confirm_key_mismatch` (wrong key typed by the owner). A client (the Stage 3 dialog) cannot say why the request was refused.
- **Suggested fix (not applied, app code):** carry `details.reason` into the body for `policy_denied` (like `domains` for `external_recipients`), or change the OpenAPI text.
- **Status:** open, reported to main thread.

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
