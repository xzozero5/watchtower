# 06 — UI Spec (Phase 1 reference)

> Owner: `ux-designer` · Task: T-101 · Status: draft for `po` review · Date: 2026-10-31
> Sources: PRD §2, §4.1–4.2, §4.4, §4.7, §4.9–4.10, §5.1–5.4, §6.2, §6.4, §10, §14 · `docs/brand/README.md` · ADR-004, ADR-005 · code in `packages/ui/src/**` and `apps/web/src/**` as of today.
> Labels: anything the PRD or an ADR does not decide is marked `[ASSUMED]`. Where this spec conflicts with the PRD, the PRD wins; raise the conflict in `docs/STATUS.md`.
> Implementation belongs to `frontend-dev` (T-006, T-109, T-111, T-116, T-007). This file contains no code, only names of existing code to reuse.

## 0. How to use this spec
- **Reuse first (N6).** §2 lists what already exists. Before building a component, check that list and `packages/ui/src/index.ts`. Shared primitives that two or more screens need go to `packages/ui`; screen compositions stay in `apps/web`.
- **No UI text in components.** Every string is a key in `apps/web/src/i18n/messages/en.ts` + `th.ts` (the compiler and `messages.test.ts` enforce same keys and placeholders). §16 lists the key copy. The i18n helper has no plural rules, so copy is written plural-free (`{count} new`, not `1 ticket / 2 tickets`).
- **Colour is never the only signal** (PRD §10). Every state in this spec has icon + text; colour is reinforcement.
- **Examples are neutral (N1):** `Acme Logistics`, `Example Co.`, `support@example.com`, `OPS-1234`. Never put a real organisation, person or procedure in mockups, seeds or copy.

---

## 1. Design tokens (pointers, not copies)

| Token group | Source of truth | CSS variable / Tailwind name | Notes |
|---|---|---|---|
| Colour (light/dark) | `packages/ui/src/tokens/colors.ts` `COLOR_TOKENS` | `--wt-color-*` → `bg-surface`, `text-muted-foreground`, `border-border-strong`, `bg-primary`, `text-link`, `outline-ring`, `text-danger`, `text-success`, `bg-scrim` | Contrast of every pair checked in `contrast.test.ts` (4.5:1 text, 3:1 UI). A new pair must be added to that test. |
| Severity P1–P4 | `tokens/severity.ts` `SEVERITIES` (code, rank, icon) + `colors.ts` `severity.*` | `--wt-color-severity-p1-fg/bg/border` → `bg-sev-p1-bg` etc. | Icons: P1 `octagon-alert`, P2 `triangle-alert`, P3 `circle-alert`, P4 `info`. Use `<SeverityBadge>`. |
| Density + font scale | `tokens/density.ts` `DENSITY_TOKENS` | `--wt-row-height`, `--wt-control-height`, `--wt-pane-padding`, `--wt-stack-gap`, `--wt-font-scale` → `h-row`, `h-control`, `p-pane`, `gap-stack` | `comfortable` 15 px base / `compact` 14 px base `[ASSUMED]` (PRD §10). Switched by `data-density` on `<html>`. |
| Motion | `density.ts` `MOTION_TOKENS` | `--wt-motion-duration-fast/base` | Zeroed under `prefers-reduced-motion` in generated CSS. |
| Theme switching | `packages/ui/src/theme/preferences.ts`, `apps/web/src/lib/preferences.ts` | `data-theme` on `<html>` (override) else OS | System / light / dark. Init script prevents flash. |
| Fonts | `tokens/css.ts` `SANS_STACK`, `MONO_STACK` | `font-sans`, `font-mono` | Plus Jakarta Sans Variable + IBM Plex Sans Thai (+ IBM Plex Mono), self-hosted with `@fontsource` (owner 2026-11-02: no font CDN at runtime). Thai line-height 1.6 on `html:lang(th)`, never below 1.5. |
| Soft Beacon surfaces (2026-11-03) | `colors.ts` `frame`, `foregroundStrong`, `navActive*`, `highlight*`, `backdrop*`, `chart.channel`; `RADIUS_TOKENS`; `SHADOW_TOKENS` | `bg-frame`, `text-foreground-strong`, `bg-nav-active`, `bg-highlight`, `bg-backdrop`, `bg-chart-email/line/portal`, `rounded-control/inner/card/app` (12/14/20/28), `shadow-card/lift/app`, `text-title/display/hero` (18/34/52) | Canvas `background` is the cool grey work area; cards are white with `shadow-card` and no border. Gradient grounds are `@utility` classes in `tailwind-theme.css`; text on every gradient stop is in `contrast.test.ts`. Highlight glow is seafoam, never gold (no warning look). Source: `docs/design/redesign-2026-11/README.md`. |

**Brand rules** (`docs/brand/README.md`, `[CONFIRMED]`): Coral `#E5594A` is logo-only, never a UI token. Primary buttons are navy (light) / inverted canvas (dark) via `primary`. Red in the UI means **P1 / SEV1 or an error**, nothing else.

**Token gaps to add in `packages/ui` (each with a contrast test)** `[ASSUMED]`:

| New token | Purpose | Proposal |
|---|---|---|
| `noteSurface`, `noteBorder` | Internal note entries + composer in note mode | Neutral muted surface + dashed `borderStrong`. Not yellow (would read as P3). |
| `aiSurface`, `aiAccent` | AI event rows, AI sidebar header, AI-drafted chip | A seafoam-derived teal from the brand palette (`#80CFC0` family), darkened until it meets 4.5:1 for text. Owner to confirm (Q2). |
| `warning` | SLA at risk, quota ≥ 80%, non-critical banners | Reuse the P3 amber values so there is one "caution" hue. |
| `info` | Neutral banners (offline, reconnecting) | Reuse `link` hue. |
| `overlayShadow` | Popovers/drawers | — |

Rule for `danger` (`#b91c1c` / `#fca5a5`): text and outline only (form errors, failed delivery, breached SLA text, destructive confirm). A **filled** red surface is allowed only for the P1/SEV1 banner and P1 badge.

---

## 2. Inventory: what exists vs what this spec adds (N6)

| Exists now | Where | Reuse for |
|---|---|---|
| `Button` (`primary` / `secondary` / `ghost`, `size=icon`) | `packages/ui/src/components/button.tsx` | All buttons. Add a `destructive` variant (outline danger) for reject/override — not a red fill. |
| `SeverityBadge` (icon + code + label, `hideLabel`) | `packages/ui/.../severity-badge.tsx` | Queue rows, banner, alerts, incidents (SEV1–4 map to p1–p4). |
| `EmptyState` (icon, title, description, action) | `packages/ui/.../empty-state.tsx` | Every empty state in §13. |
| `Kbd` | `packages/ui/.../kbd.tsx` | Shortcut hints in tooltips, palette, `?` overlay. |
| `cn`, theme prefs, tokens, contrast utils | `packages/ui/src/index.ts` | — |
| `AppShell` (top bar, skip link, palette toggle) | `apps/web/src/components/app-shell.tsx` | Extend top bar with shift chip, focus toggle, notifications, user menu (§3.1). |
| `ThreePane` + `Pane` (section + h2, scroll body, footer) | `apps/web/src/components/three-pane.tsx` | Keep `Pane` as the pane frame; T-006 replaces the empty states. |
| `CommandPalette` (Radix Dialog, filter, grouped, arrow/Enter) + `buildCommands` | `apps/web/src/components/command-palette/*` | Add groups `navigation`, `ticket`, `shift` (§14). |
| `PreferencesControls` (theme/density/language) | `apps/web/src/components/preferences-controls.tsx` | Move into the user menu on narrow screens. |
| `ApiStatus` | `apps/web/src/components/api-status.tsx` | Pattern for `ConnectionStatus` (WS live/reconnecting). |
| i18n `useT`, `translate`, TH/EN catalogues | `apps/web/src/i18n/*` | All copy. |

**New shared primitives → `packages/ui`** `[ASSUMED]`: `StatusBadge` (ticket status), `SlaBadge`, `ChannelBadge`, `StageBadge` (autonomy), `ConfidenceLabel`, `Banner` (info/warning/critical, sticky option), `Toast` (with Undo action), `Dialog` (wrap the Radix Dialog already used by the palette), `Skeleton`, `Meter` (quota), `Tabs`, `SplitButton`, `Avatar` (initials, no external images). Each with a test that it renders icon + text.
**New compositions → `apps/web`**: `QueueList`, `QueueRow`, `NewItemsPill`, `FilterBar`, `SavedViews`, `Timeline` + entry renderers, `Composer`, `AiSidebar`, `InvestigationProgress`, `EvidenceCard`, `DraftCard`, `RejectDialog`, `CriticalBanner`, `ShortcutHelp`, shift/handoff screens, admin integration cards. Portal pages live in the portal route group (T-007).

---

## 3. App shell and three-pane layout

> **Current shell (Soft Beacon, 2026-11-03, `[TESTED]` by e2e `smoke`/`keyboard`):** no global top bar. A rail on the `frame` ground: 68 px icons, 248 px with words (Ctrl/Cmd+B), a 48 px bar across the top below 768 px. The current page is the `bg-nav-active` gradient tile with ivory icon; other icons are neutral and light only with a count above zero. Overview (`/home`) and Login sit in a floating sheet (`AppFrame`, radius 28, `shadow-app`) on the `bg-backdrop` gradient from 768 px, full screen on a phone and in compact density; every other page is full screen. In the ticket workspace each pane is a white card (radius 20, `shadow-card`) on the Canvas with a 1 rem gutter from 768 px; on a phone a pane fills the screen. Page headers: Overview 34/300 with a one-line subtitle; other pages 26/300, no hairline. The wireframe below is the original Phase 1 plan and is kept for the behaviour it describes.

### 3.1 Wireframe (≥ 1024 px, comfortable)
```
+--------------------------------------------------------------------------------------------+
| [icon] Watchtower  (o) Live   | On shift 08:00-17:00 - 3h 12m left | [Focus off] [Bell 4] [Ctrl K] [Avatar v] |
+--------------------------------------------------------------------------------------------+
| [octagon] P1 Critical  OPS-1240  Webhooks failing for 3 orgs - 4m ago - not acknowledged    |
|                                                      [Open ticket] [Acknowledge]  [v hide]  |  <- sticky, P1/SEV1 only
+-------------------------+-------------------------------------------+----------------------+
| QUEUE                   | OPS-1234  Webhook not received            | AI ASSISTANT         |
| [My queue v] [Filters]  | Acme Logistics - Email - [P2 High] [Open] | Intent: webhook_not_ |
| ( 3 new - press . )     | SLA: First response in 42m  [Assign v]    | received  [Stage 2]  |
|-------------------------|-------------------------------------------| Summary ...          |
| > [P2] OPS-1234  42m    | (timeline, newest at bottom)              | Investigation 6/6    |
|   Webhook not received  |  customer msg / public reply / note /     | Evidence (4)         |
|   Acme - Email - AI:Draft|  AI event / system event                 | Draft  [A] [E] [R]   |
| [P3] OPS-1233  Paused   |-------------------------------------------|                      |
|   ...                   | [Reply | Internal note]  via Email v      |                      |
| [Severity key v]        | [ text area ...                       ]   |                      |
|                         | [Template /] [Attach]  [Send v Ctrl+Enter]|                      |
+-------------------------+-------------------------------------------+----------------------+
```

### 3.2 Panes and breakpoints
Current code: three columns from Tailwind `lg` (1024 px) with `minmax(15rem,22rem) | minmax(0,1fr) | minmax(15rem,24rem)`; below `lg` panes stack. Keep the `lg` behaviour; refine below it:

| Width | Layout | Behaviour |
|---|---|---|
| ≥ 1440 px `[ASSUMED]` | 3 panes, AI sidebar may widen to 28rem | User can collapse queue (`[`) or AI sidebar (`]`); widths persist per user `[ASSUMED]`. |
| 1024–1439 px | 3 panes (current grid) | Default. |
| 768–1023 px `[ASSUMED]` | 2 panes: queue + conversation; AI sidebar becomes a right drawer (toggle button with badge "Draft ready") | Drawer is a non-modal region, not a dialog, so the conversation stays readable. |
| < 768 px (PWA phone) | 1 pane at a time: Queue → Ticket (tabs: Conversation / AI) | Back button returns to queue keeping scroll position. A/E/R live in a sticky bottom bar, targets ≥ 44 × 44 px. Composer opens full-screen. |

- Each pane: one `<section aria-labelledby>` with an `h2` (existing `Pane`). Each scrolls independently; the page never scrolls at `lg+` (`lg:h-dvh` exists).
- Pane focus: `F6` / `Shift+F6` cycle panes, `Alt+1/2/3` jump to a pane. Focused pane shows a 2 px `ring` outline on its border.
- Top bar order (left→right = tab order): logo/name, connection status, shift chip, focus toggle, notifications, palette button, user menu (preferences, sound, sign out).

---

## 4. Queue (left pane)

### 4.1 Row anatomy
```
[P2 icon P2] OPS-1234                       [clock] 42m      <- line 1: severity, number, SLA badge
Webhook not received for 2 hours                             <- line 2: subject, 1 line, ellipsis
Acme Logistics - [mail] Email - Unverified - AI: Draft ready - (MK)   <- line 3: org, channel, flags, AI state, assignee
```
- **2026-11-02 (po for the owner, QA-02/03):** this anatomy wins over `docs/design/ai-first-workspace.md` §2 where they differ: the subject is the human subject; the AI summary, when present, is shown as its own line labelled "AI" (never as the title). The SLA slot is always rendered ("No SLA" muted when none applies). "Needs you" includes every P1 and SLA breached/at-risk ticket.
- Compact density: lines 1+2 merged, line 3 hidden except severity, channel icon, SLA and AI state; `SeverityBadge hideLabel` (label stays for screen readers).
- Unread: bold subject + "Unread" visually hidden text + 8 px dot. Never colour only.
- Selected row: `primary` left bar 3 px + `surfaceMuted` background + `aria-selected="true"`.
- AI state chip (icon + text): `Investigating` (spinner, static under reduced motion) · `Draft ready` · `Needs triage` · `No draft (Stage 0/1)` · `AI failed — retrying`.
- `Unverified` chip (shield-question icon) when the contact is not linked (R-2.11).

### 4.2 Filters and saved views
- **Saved views** (dropdown at pane top, each with a count): `My queue` (default), `Unassigned`, `SLA at risk`, `Triage (low confidence)`, `Waiting on customer`, `All open`, `Alerts`, `Other mail` (§7). Users can save the current filter set as a view. T-006 may store user views locally; server-side views are T-119.
- **Filter bar** (chips; `/` focuses search): status, priority, channel, intent, org, assignee (me / unassigned / anyone / person), SLA state, AI state, tags, date range. Active filters show as removable chips; "Clear all".
- **Default sort** `[ASSUMED]`: SLA breached → SLA at risk → priority rank → oldest due time. Alternative sorts: newest, oldest, last customer reply.
- **Bulk** (T-119): `X` toggles row selection; a bulk bar replaces the filter bar showing "{count} selected" + assign / status / priority / merge.

### 4.3 "N new" pill (no reflow under the cursor)
- New or newly-matching items **never** insert above or move the focused row. They are held back and counted in a pill at the top of the list: `3 new — press .` (`.` key or click loads them, focus stays on the same ticket).
- Updates to visible rows (status, SLA) change in place without reordering; reorder happens only on pill click, view change or manual refresh.
- Screen readers: pill count is in a polite live region, announced at most once per 30 s `[ASSUMED]`.
- P1 items also go to the critical banner (§8) — they still do not reflow the list.

### 4.4 SLA badge states
| State | Rule | Icon (lucide) | Text example | Colour |
|---|---|---|---|---|
| On track | > 25% of target left `[ASSUMED]` | `clock` | `FR 2h 10m` / `Res 1d 4h` | muted foreground |
| At risk | ≤ 25% left or ≤ 30 min `[ASSUMED]` | `clock-alert` | `FR 18m left` | `warning` |
| Breached | past due | `alarm-clock-off` | `Overdue 12m` | `danger` text + outline (no fill) |
| Paused | `waiting_on_customer` (R-1.2) | `circle-pause` | `Paused` | muted |
| Met | target achieved | `circle-check` | `Responded 14m` | `success` |
| None | no SLA policy / internal | — | `No SLA` | muted |
- Badge shows the **next** due target (first response until responded, then resolution). Tooltip + `aria-label` gives full text: "First response due at 14:30 (in 42 minutes), business hours".
- Times update every 30 s; no animation; screen readers are not re-announced on tick.

---

## 5. Conversation (centre pane)

### 5.1 Ticket header
Subject (h3, editable via a pencil button; no shortcut because `E` is Edit draft) · number · org (link to org card) · requester + verification state · `StatusBadge` · `SeverityBadge` · intent (with confidence if AI-set) · `SlaBadge` · assignee picker · tags · linked incident/tickets · "Possible duplicate: OPS-1229 (same org, same intent, 3h ago) — Review / Merge / Not a duplicate" (R-1.5) as a dismissible info `Banner`.

### 5.2 Timeline visual grammar (R-1.3)
Oldest at top, newest at bottom, auto-scroll to the newest entry only when the user is already at the bottom; otherwise a "New message ↓" pill (same no-reflow rule as the queue).

| Entry type | Shape | Header line | Distinguishing cues (never colour only) |
|---|---|---|---|
| Customer message (inbound) | Full card, `surface`, left border `borderStrong` | Sender name · org · `ChannelBadge` (icon + "Email" / "LINE" / "Portal") · time | Avatar initials; "Unverified" chip if applicable |
| Public reply (outbound) | Full card, `surface`, right-aligned header, left border `primary` | Agent name · "Sent via Email to a@example.com" · delivery status (`Sending` / `Sent` / `Delivered` / `Read` (LINE, if available) / `Failed — Retry`) · time | Chip `AI draft · approved by MK` or `AI draft · edited by MK (23% changed)` when it came from a draft |
| Internal note | Full card, `noteSurface`, **dashed** border | Lock icon + "Internal note — not sent to the customer" · author · time | Lock icon + label on every note; `@mention` chips |
| AI event | One line, `aiSurface`, expandable | Sparkles icon + verb: "AI classified as `webhook_not_received` (High confidence, 0.86)", "AI investigation finished (6 steps, 4 evidence)", "AI draft created", "AI run failed — will retry" | Expand → agent, model tier, prompt version, tools called, duration, cost (PRD §6.1). Raw JSON behind a second "Show raw" toggle. |
| System event | One line, muted text, no card | Icon per type: assignment `user-round`, status `circle-dot`, SLA warning `clock-alert`, merge `git-merge`, CSAT `star`, reopen `rotate-ccw` | 3+ consecutive system events collapse to "4 system events — show" `[ASSUMED]` |

- Every entry shows its own channel (a ticket can mix email and LINE). Times are relative ("5m ago") with absolute time in `<time datetime>` + tooltip, Asia/Bangkok unless the user overrides (PRD §8.4).
- Email: sanitized HTML, quoted history collapsed ("Show quoted text"), inline images kept, attachments as chips (name, size, type icon); images show "Text found in image (OCR)" expandable (R-2.5).
- LINE: stickers shown as "[Sticker]" text, location as an address line + map link `[ASSUMED]`.
- Timeline filter (segmented control): `All` · `Messages` (public + inbound) · `Notes` · `AI & system`.
- PII: staff views show the original text (PRD §6.6 re-insertion); redacted copies are never shown in the UI.

### 5.3 Composer (R-1.4, R-2.10)
```
[ Reply | Internal note ]                   Send via: [mail Email - support@example.com v]
+---------------------------------------------------------------------------------------+
| Hi {{contact.first_name}}, ...                                                        |
+---------------------------------------------------------------------------------------+
[/ Template] [Attach] [Variables]   LINE push - 212 / 300 used this month [=====---]   [Send v]
```
- **Mode tabs**: `Reply` (public) and `Internal note`. Note mode recolours the whole composer to `noteSurface` + dashed border and changes the send button text to `Add note`, so a note can never look like a reply. `C` opens reply, `N` opens note.
- **Channel switch**: defaults to the ticket's channel. Options list only channels the contact can receive (email address present, LINE linked, portal). Switching shows "The customer last wrote via LINE" as context. Disabled options say why ("No LINE account linked").
- **Templates**: typing `/` at the start of an empty line, or the Template button, opens a searchable list filtered by intent and language. Variables render as non-editable chips (`{{ticket.number}}`, `{{contact.first_name}}`, `{{sla.first_response_due}}`, `{{portal.tracking_link}}`). An unresolved variable blocks send with an inline error naming it.
- **Send**: `SplitButton` — main `Send` (`Ctrl/⌘+Enter`); menu `Send and set status → Waiting on customer / Waiting on dev / Resolved` (`Ctrl/⌘+Shift+Enter` = send + last used status `[ASSUMED]`, default `Waiting on customer`).
- **Undo send**: after Send or Approve, a toast "Sending in 5 s — Undo" `[ASSUMED]`; the message is queued server-side only after the window. Under reduced motion the countdown is text only.
- **LINE quota indicator** (when channel = LINE): `Meter` + text "Push message · 212 / 300 used this month". ≥ 80%: warning icon + "Quota 85% used — consider email". 100%: send disabled, "Monthly push quota used up. Send by email instead or ask the head to change the plan." (R-2.10).
- **Disclosure warning** for `unverified` contacts: warning `Banner` in the composer "Unverified contact — don't share account data, internal links or root causes" (PRD §6.6).
- Drafts autosave locally per ticket; leaving with unsent text asks for confirmation.
- Attachments: drag-drop + button; size limit shown before upload `[ASSUMED 25 MB]`.

---

## 6. AI sidebar (right pane)

Order top→bottom (progressive disclosure: summary first, evidence on expand):
1. **Header**: intent (+ confidence) · `StageBadge` · `Regenerate` (button only, no shortcut `[ASSUMED]`) · overflow (view all AI runs for this ticket).
2. **Summary** (Summarizer): 3–5 bullet lines: what happened, what was tried, open questions, next action, sentiment label (text, not emoji).
3. **Investigation progress / report**.
4. **Evidence cards**.
5. **Draft** with Approve / Edit / Reject.

### 6.1 Investigation progress and report (§5.1 step 4)
- While running: step list with state per step — `Done` (check), `Running` (spinner; static dot under reduced motion), `Waiting` (empty circle), `Skipped` (with reason), `Failed` (with reason). Header text: "Investigating… step 3 of 6: querying logs". Never a silent spinner > 2 s (PRD §10).
- Rate budget visible when relevant: "Waiting for log query budget (about 20 s)" (R-5.1).
- Report: **Summary**, **Hypotheses** (each with `ConfidenceLabel` = word + number: `High 0.86` / `Medium 0.55` / `Low 0.20`; bands `[ASSUMED]` ≥ 0.75 / ≥ 0.4 / < 0.4), supporting evidence links, **Open questions**, **Proposed incident** (when several orgs match; button `Create incident` — agent role may create, PRD §2.2).
- LLM down / AI failed: info banner "AI is unavailable. The ticket was created and acknowledged; investigation will retry." + `Retry now`.

### 6.2 Evidence card (R-5.6, PRD §6.1 "evidence over confidence")
```
[file-text] KB article - "Webhook retry schedule" - section 3            relevance High
"Webhooks retry 5 times over 24 hours..."                                [Open source ->]
[v Details]  [Pin to ticket]
```
| Field | Rule |
|---|---|
| Source type | Icon + label: `KB article`, `Similar ticket`, `Log query`, `Data query`, `Code change`, `Deploy`, `Metric` |
| Title + citation | Clickable link to the source (KB section anchor, ticket, PR, log console, saved result). Opens in a new tab with an external-link icon when outside Watchtower. |
| Result summary | One or two lines, human-readable ("37 failed deliveries for org between 09:00–11:00"). |
| Relevance / confidence | `ConfidenceLabel` word + number. |
| Details (collapsed) | Tool name, parameters (redacted), time window, rows, bytes, duration, who ran it, when. Raw result behind "Show raw result" — monospace, max-height, copy button. |
| Actions | `Pin to ticket` (adds to timeline as AI event), `Re-run` (humans; shares the rate budget). |
- Citation markers in the draft (`[1]`, `[2]`) link to cards; focusing a marker highlights the card (outline + "Cited in draft" text).

### 6.3 Draft card and A / E / R
```
Draft reply - English - Stage 2 Draft for approval - from investigation at 10:42
+-----------------------------------------------------------------------+
| Hi Dana, we checked webhook deliveries for your account [1] ...       |
| The fix was deployed at 10:05 [3]. ~~Retries will finish by noon.~~   |
|                                      ^ Uncited claim                  |
+-----------------------------------------------------------------------+
[Approve and send  A]   [Edit  E]   [Reject  R]
```
- **Uncited claims** (PRD §6.6): wavy underline + inline `Uncited` tag (icon + text) + count in the header "1 uncited claim". Approve is allowed but shows "1 uncited claim — approve anyway?" inline confirmation `[ASSUMED]`.
- **Disclosure blocks** (unverified contact): sentences removed by policy are listed as "Removed by disclosure policy: 1 sentence (account data)".
- **Approve (`A`)**: sends through the ticket's channel with the Undo toast (§5.3), records `approved`. If the channel is LINE, the quota meter is shown in the confirmation line.
- **Edit (`E`)**: copies the draft into the composer (Reply mode, same channel), keeps citation markers as chips, shows "Editing AI draft" label. On send the diff and edit distance are stored (`edited`); the user never fills a form for this.
- **Reject (`R`)**: opens `RejectDialog` — one required reason (radio, digits `1`–`9` select), optional comment (required for `Other`), `Reject` button. After reject: sidebar offers "Write reply myself" (focuses composer) and "Regenerate with note".
- Stage 1: no draft until requested — button `Draft a reply` (`D`). Stage 0: no draft UI; text "Drafts are off for this intent (Stage 0 · Observe)".
- Internal note drafts (Drafter output) use the same card with the note styling and `Add as note`.

**Reject reason codes** `[ASSUMED]` — stored as `ai_draft.reject_reason` ids (English), labels translated:

| # | id | EN | TH |
|---|---|---|---|
| 1 | `wrong_intent` | Wrong intent / misunderstood the request | เข้าใจคำขอผิด / intent ผิด |
| 2 | `factually_wrong` | Factually wrong | ข้อมูลไม่ถูกต้อง |
| 3 | `missing_info` | Missing information or steps | ข้อมูลหรือขั้นตอนไม่ครบ |
| 4 | `not_grounded` | Not supported by evidence / bad citation | ไม่มีหลักฐานรองรับ / อ้างอิงผิด |
| 5 | `disclosure_risk` | Shares something it shouldn't | เปิดเผยข้อมูลที่ไม่ควรเปิดเผย |
| 6 | `tone_style` | Tone or style | น้ำเสียงหรือสำนวนไม่เหมาะ |
| 7 | `wrong_language` | Wrong language | ภาษาไม่ถูกต้อง |
| 8 | `no_reply_needed` | No reply needed / already answered | ไม่ต้องตอบ / ตอบไปแล้ว |
| 9 | `other` | Other (explain) | อื่น ๆ (โปรดระบุ) |

### 6.4 Autonomy stage badge (PRD §6.4)
| Stage | Badge text EN / TH | Icon | Shown on |
|---|---|---|---|
| 0 | `Stage 0 · Observe` / `ขั้น 0 · สังเกต` | `eye` | sidebar header |
| 1 | `Stage 1 · Suggest` / `ขั้น 1 · แนะนำเมื่อขอ` | `lightbulb` | header + every draft |
| 2 | `Stage 2 · Draft for approval` / `ขั้น 2 · ร่างรออนุมัติ` | `user-check` | header + every draft |
- Tooltip explains: "A person approves every reply for this intent."
- **Phase 1: stage ≥ 3 is not rendered anywhere** — no auto-send toggle, threshold slider, "promote to stage 3" button or automated-answer disclosure setting. The intent admin's stage selector lists 0–2 only (lead/head per PRD §2.2). Re-introduce in Phase 2 with its own spec section.
- Auto-ack messages (allowed at any stage) appear in the timeline as public replies with chip `Automatic acknowledgment` so they are never mistaken for an AI answer.

### 6.5 Emergency switch (head only)
- Location: Admin → AI → "Emergency controls" (also as a palette command for head). Two controls:
  1. `Limit all intents to Stage 2 or lower` (PRD §6.4): caps every intent at `min(stage, 2)` and **pins** it (blocks promotion) until turned off. It never raises a stage 0/1 intent to 2 `[ASSUMED]` (po 2026-11-01).
  2. `Stop all AI runs` (kill switch, PRD §6.6): classifier falls back to rules, no investigations or drafts; auto-ack templates continue.
- Turning a control **on** (the safe direction): one confirm + required reason + audit entry, no typed confirmation. Turning it **off** (resuming AI): confirm + required reason + audit entry `[ASSUMED]` (po 2026-11-01).
- While active: global non-dismissible info `Banner` for all staff "AI paused by the head at 10:42 — replies are manual." The sidebar shows the same message instead of drafts. Not red (it's a safe state, not P1).

---

## 7. "Other mail" view (R-2.6, R-2.7)
- A saved view in the queue pane, excluded from queue counts and notifications.
- Row: classification chip (icon + text: `Auto-reply`, `Bounce`, `Newsletter`, `Machine notification`, `Spam`), sender, subject, received time, one-line reason ("Header Auto-Submitted: auto-replied").
- Opening shows the sanitized email read-only in the centre pane (no composer) with actions: `This is a ticket` (`T`) → creates a ticket, records classifier feedback, toast "Created OPS-1250 — Undo"; `Send to alerts` for machine notifications `[ASSUMED]`; `Keep as other mail`.
- Bulk select + `This is a ticket` for several. Empty state: "No other mail. Auto-replies, bounces and newsletters land here instead of the queue."

---

## 8. Alert discipline, notifications, focus mode (PRD §10, R-3.16)

### 8.1 What may interrupt
| Event | Visual | Sound | Web Push (background tab) | Focus mode |
|---|---|---|---|---|
| P1 ticket, SEV1 incident, critical alert, escalation to me at P1 | **Sticky critical banner** under top bar (filled P1 tokens, octagon icon, "P1 Critical"), tab title prefix `(P1)` | Yes, P1 tone; repeats every 60 s until acknowledged or opened `[ASSUMED]` | Yes | Still interrupts |
| P2 ticket, SEV2 incident, error alert | Toast (top-right, 8 s, focusable, pauses on hover/focus) + badge count | Yes, P2 tone, once | Yes | Still interrupts |
| P3/P4 ticket, warning alert, assignment to me, mention | Badge count + "N new" pill only | No | No `[ASSUMED]` | Batched into a digest every 15 min `[ASSUMED, user setting 5–60]` |
| Shift note for me, handoff item to acknowledge | Badge on shift chip + item in brief | No | No | Not batched (shift-critical) |
| Handoff unacknowledged 30 min (lead) | Toast for the lead + badge | No | Yes | Still shown |
| System health (Gmail watch heartbeat, integration down) | Warning `Banner` for head/lead; agents see a status dot in the top bar | No | No | — |

- Severity mapping: ticket P1–P4 = `SeverityBadge` p1–p4; incident SEV1–SEV4 → p1–p4 tokens with code `SEV1`…; alert source severity `critical → p1`, `error → p2`, `warning → p3`, `info → p4` `[ASSUMED]`.
- **Only one critical banner** at a time; more P1 items show "+2 more P1" inside it, with a list on expand. Banner collapses to a one-line strip but cannot be dismissed until acknowledged.
- Sound rules: two distinct tones (P1 longer/lower than P2); max one sound per 10 s `[ASSUMED]`; per-user mute with a persistent "Sound off" indicator in the top bar; the first sound needs a user gesture (browser autoplay) so the clock-in screen includes "Test sound".
- Visual rules: no flashing (WCAG 2.3.1), no shaking; banner appears without animation under reduced motion; favicon gets a badge dot for P1/P2 only.
- Ack: banner `Acknowledge` button; `A` acknowledges when an alert is open in the centre pane (no draft present there). Acks from Discord update the web within 2 s (AC-3) — banner shows "Acknowledged by MK via Discord".

### 8.2 Focus mode
- Toggle in top bar (`Shift+F`) with a visible state "Focus on · digest at 10:45". Suppresses P3/P4 toasts and counts arrivals in a digest panel delivered every N minutes. P1/P2 always break through. Turning it off delivers the digest immediately.
- Notification panel (bell): grouped by today/earlier, filter by type, `Mark all read`; each item links to its target.

---

## 9. Shift screens (R-7.3–7.7, §5.4)

### 9.1 Shift chip and clock in/out
- Top bar chip states: `Off shift — Clock in` (button) · `On shift · 08:00–17:00 · 3h 12m left` · `Shift ended 10m ago — finish handoff` (warning) · `Late 12m` (warning; text + icon).
- **Clock in** dialog: today's roster entry (or "Not on the roster today — clock in anyway?"), device name (auto), optional location consent checkbox **off by default**, "Test sound" button. On confirm → Daily brief.
- **Clock out**: disabled until the handoff record is confirmed; the button explains why ("Finish the handoff first: 2 items need a next action"). Lead/head can override with a required reason (audit).

### 9.2 Daily brief (R-7.4) — full-width page, also reachable from the shift chip
Sections in this order, each with count and links; empty sections collapse to one line "No open incidents":
1. Handoff from the previous shift (pending items to acknowledge → §9.4) 2. Open incidents 3. My tickets by SLA risk 4. Tickets carried over to me 5. Snoozed alerts with expiry 6. Deploys in the last 24 h 7. Customer watch items 8. KB changes 9. Notes left for me (must be marked read).
- AI-written paragraphs have the AI chip and "Generated at 08:01 from data at 08:00". `Mark brief read` → queue.

### 9.3 Handoff record (outgoing, R-7.5)
```
Handoff - Evening shift 13:00-22:00 -> Night shift (incoming: PS)        Saved 21:41
1 Shift      13:00-22:00 · out: MK · in: PS
2 Incidents  [AI filled] SEV2 INC-12 Monitoring · owner MK · next: confirm error rate < 1% · ETA 23:00  [edit]
3 Pending    | Ticket   | Next action (required)       | Due    | Carried |
             | OPS-1234 | Wait for customer's log file  | 09:00  | 1 shift |
             | OPS-1240 | [ ! required ]                | --     | new     |   <- blocks confirm (AC-7)
4 SLA risk   [AI filled] 2 tickets ...
5 Deploys / snoozed alerts [AI filled] ...
6 Watch      [AI filled] "Acme Logistics go-live tonight 23:00"
7 Notes      [ free text ]   + Message for next shift
                                                 [Save draft]  [Confirm handoff]
```
- AI-filled sections are labelled `AI filled — check before confirming` and editable; edits are tracked.
- Validation: every open assigned P1/P2 ticket must be a pending item with a next action (AC-7 for P1; P2 `[ASSUMED]`). Errors listed at top with links to each field (error summary pattern).

### 9.4 Acknowledgment (incoming, R-7.6)
- List of pending items, each with `Accept` / `Reassign…` / `Ask a question` (keys `1` / `2` / `3` on the focused item). Question sends a note to the outgoing person and keeps the item open.
- Progress: "3 of 7 acknowledged" + timer text "The lead will be alerted at 22:30 if items are still unacknowledged."
- Carried count badge on each item: `Crossed 3 shifts` (icon `repeat`); ≥ 3 shows warning style `[ASSUMED]`.

### 9.5 Shift notes (R-7.7)
- Compose: audience segmented control `Next shift` / `Person` / `Date and time`, body, send. Received notes appear in the brief and the notification panel with `Mark as read` (required; unread count stays on the shift chip).

---

## 10. Client portal (R-9.1–9.5, T-007) — public, mobile-first, TH/EN switch, org branding
- **Submit form**: email, organisation (auto from allow-listed domain, else text), category, description, attachments, affected session/request IDs (optional, with example format), urgency (plain words: "Everything is down" / "Something is broken" / "A question"). Human verification on the generic link only, placed above Submit: self-hosted proof-of-work challenge solved in a Web Worker + honeypot field + minimum fill time + per-IP/email/org rate limits, behind a `HumanVerificationProvider` interface; a hosted provider (Turnstile/hCaptcha) is a new network destination → `[ASK-HUMAN]` (po 2026-11-01, ADR before T-007); if it fails to load, show "Verification couldn't load. Check your connection or try another browser." Labels above fields, errors inline + summary, no placeholder-only labels.
- **Confirmation page**: "We received your request" + ticket number + "We sent a tracking link to a***@example.com" (masked) + expected first response from SLA.
- **Tracking page** (signed link, R-9.2): status in customer words — `Received` / `In progress` / `Waiting for your reply` / `Resolved` / `Closed` / `Merged into OPS-xxxx` (mapping from internal statuses `[ASSUMED]`; `triage`, `open` and `waiting_on_dev` show `In progress`; `merged` links to the primary ticket); public timeline only (never internal notes, AI events, system events, or agent surnames `[ASSUMED]`); reply box + attachments; rating prompt once resolved. Link expired/invalid → "This link has expired. Enter your email and we'll send a new one." (response is the same whether or not the email exists).
- Logged-in org view (R-9.4) is P1/Phase 2 — out of this spec.

## 11. CSAT (R-10.1–10.5)
- **Email**: subject "How did we do with {ticketNumber}?"; one line of context (ticket subject); five links as buttons with number **and** word: `1 Very poor` … `5 Very good` (no stars/emoji only); footer: why you got this, opt-out link. Plain-text alternative part required.
- **Landing page** (one click already records the score): "Thanks — you rated 4 · Good" + change rating, "Was your issue resolved? Yes / No", optional comment, `Send`. States: `Already answered` (show previous answer, allow comment), `Survey closed` (ticket reopened/voided), `Link invalid`. Score ≤ 2 or "No" shows "We've reopened your request and a lead will contact you." (R-10.5).

## 12. Admin → Integrations (ADR-004, T-116) — `head` only
```
LINE Official Account                      [Configured]  updated 2026-10-01 by head
  Channel secret      [ ••••••• set ]  [Replace]        Locked? no
  Channel access token[ (locked) Set by environment variable LINE_CHANNEL_ACCESS_TOKEN ]
  Health: Webhook OK · last event 2m ago · Push quota 212 / 300
                                             [Test connection]  [Save]  [View audit]
```
- Card per integration (Gmail, LINE, Discord, GitHub, AI provider, …) with status chip (icon + text): `Not configured` · `Configured` · `Set by environment` (lock icon) · `Error — last check failed`.
- **Write-only fields**: the value is never shown, not even masked characters or its length; display only "Set · updated {date} by {name}". `Replace` reveals an empty password-type input with show/hide toggle for what is being typed now. `Remove` needs confirmation.
- **Environment wins**: field disabled, lock icon, "Set by environment variable `NAME` — change it in your deployment" (shows the variable name, never the value).
- **Test connection** runs against the unsaved values before Save; result inline: success "Connected" + non-secret identity (e.g., bot name, mailbox address) or a plain-language error. Errors never echo the submitted value.
- Health line per integration: last success, last error, Gmail watch expiry / next renewal, LINE quota.
- Non-head users: permission-denied state (§13) and the nav item is hidden.

---

## 13. States for every screen

| State | Pattern | Copy rule |
|---|---|---|
| Empty | `EmptyState` with icon, title (what's missing), description (what will appear / what to do), optional action | Never just "No data". |
| Loading | `Skeleton` in the shape of the content; after 2 s add text of what's happening ("Loading tickets…", "Investigating… step 2 of 6") | No bare spinners > 2 s (PRD §10). `aria-busy` on the region. |
| Error | Inline in the failing pane (other panes keep working): message + `Try again` + "Your work was not changed" when true | Existing `errors.*` keys; never show stack traces or raw JSON. |
| Offline (PWA) | Top `Banner` (info): "You're offline. Showing data from 10:42." Sending, approving and ack are disabled with reason; drafts stay saved locally. No queued outbound sends `[ASSUMED]` | Re-enable automatically on reconnect + toast "Back online". |
| Live updates lost | Top bar connection chip `Reconnecting…` (WS down, REST OK); after 30 s a banner "Live updates paused — refresh to see new tickets" | Don't block work. |
| Permission denied | `EmptyState` with lock icon: "You don't have access to this page. It needs the {role} role." No data or counts leak. | Link back to the queue. |
| Not found | Existing `not-found.tsx` | — |
| Session expired | Dialog "Your session ended. Sign in again — your draft is saved." | ADR-005 single-flight refresh happens first silently. |

Per screen: Queue (empty view, no results for filters → "Clear filters"), Conversation (no selection, ticket merged → redirect notice, ticket deleted/forbidden), AI sidebar (Stage 0, AI paused, AI failed, investigating, no evidence found — "No evidence found. The draft has no citations."), Composer (channel unavailable, quota exhausted, send failed with Retry), Brief (first shift ever), Handoff (nothing pending — "Nothing to hand over" still requires Confirm), Portal (expired link, verification failed, upload too large), CSAT (answered/closed/invalid), Admin integrations (not configured, env-locked, test failed).

---

## 14. Keyboard map
Single-letter keys work only when focus is **not** in a text field, select or contenteditable; `Esc` leaves a field first. `?` shows this map (overlay dialog, grouped like below, uses `Kbd`). All shortcuts also exist as palette commands and visible buttons. `[ASSUMED]` unless the key is named in PRD §10 / §5.1 (⌘K, J/K, A/E/R, ?).

| Scope | Key | Action |
|---|---|---|
| Global | `Ctrl/⌘ K` | Command palette (exists) |
| Global | `?` | Shortcut help |
| Global | `/` | Focus queue search |
| Global | `g` then `q` / `o` / `b` / `h` / `n` | Go to queue / Other mail / Brief / Handoff / Notifications |
| Global | `F6`, `Shift F6`, `Alt 1/2/3` | Cycle / jump panes |
| Global | `[` / `]` | Collapse queue / AI sidebar |
| Global | `Shift F` | Focus mode on/off |
| Global | `Esc` | Close dialog/drawer, leave field |
| Queue | `J` / `K` | Next / previous ticket (moves selection, opens in centre) |
| Queue | `Enter` / `O` | Move focus into the conversation |
| Queue | `.` | Load "N new" items |
| Queue | `X` | Select row (bulk) |
| Ticket | `C` / `N` | Reply / internal note |
| Ticket | `S` / `P` / `I` | Status / priority / assign menus (assign to me: `I` then `Enter`) |
| Ticket | `T` | (Other mail) This is a ticket |
| Composer | `Ctrl/⌘ Enter` | Send |
| Composer | `Ctrl/⌘ Shift Enter` | Send and set last status |
| Composer | `/` at line start | Templates |
| AI draft | `A` / `E` / `R` | Approve and send / Edit / Reject |
| AI draft | `D` | Request a draft (Stage 1) |
| Reject dialog | `1`–`9`, `Enter` | Pick reason, confirm |
| Alert open | `A` | Acknowledge |
| Handoff ack | `1` / `2` / `3` | Accept / Reassign / Ask |
| Toast | `U` while an Undo toast is visible (not in a text field, so `Ctrl/⌘ Z` keeps its text meaning) | Undo send / undo convert |

Conflicts: `A` means Approve when a draft is present and Acknowledge only on an alert view (never both on one screen). Thai keyboard layout: shortcuts match on `event.code` (physical key) as well as `event.key`, so they work without switching the input language `[ASSUMED]`.

---

## 15. Accessibility checklist (WCAG 2.1 AA; goes into `docs/08-QA-CHECKLIST.md` via `qa-engineer`)
- [ ] Text contrast ≥ 4.5:1, large text and UI parts (borders of inputs/buttons, focus ring, icons that carry meaning) ≥ 3:1 in both themes — enforced for tokens by `contrast.test.ts`; check composite states (hover, selected, disabled-with-meaning) by axe in Playwright.
- [ ] Severity, SLA, status, stage, channel, delivery and AI state each have icon + text; grayscale screenshot test still tells them apart.
- [ ] Focus visible everywhere (2 px `ring`, offset 2); focus never lost on list updates; after closing a dialog focus returns to its trigger.
- [ ] Focus order: skip link → top bar → banner (if any) → queue → conversation → composer → AI sidebar. Skip link exists (`app.skipToContent`); add "Skip to queue" and "Skip to AI assistant".
- [ ] Landmarks: `header`, `main`, each pane a labelled `section`; queue is a `listbox` (or `grid` with roving tabindex) with `aria-activedescendant`; timeline is a `feed` or list with `article` entries.
- [ ] Live regions: polite for "N new", toasts, investigation step changes (throttled); assertive only for the P1 banner.
- [ ] Every shortcut has a visible control alternative; single-key shortcuts can be turned off in preferences (WCAG 2.1.4).
- [ ] Reduced motion: no spinners spinning, no slide-in, no countdown animation (tokens already zero durations); also offered as a user setting.
- [ ] Target size ≥ 24 × 24 px desktop (`--wt-control-height` already ≥ 32 px), ≥ 44 × 44 px for mobile A/E/R bar.
- [ ] Text resize to 200% and 320 px width reflow without loss (stacked layout); root font uses `%` so browser font settings apply (exists).
- [ ] Forms: visible labels, inline errors tied with `aria-describedby`, error summary on submit, no timeout on the portal form; CAPTCHA has an accessible mode.
- [ ] `lang` attribute follows the UI locale; customer messages in another language get `lang` on the entry when detected.
- [ ] Time: relative times have absolute equivalents; SLA timers don't announce on tick.
- [ ] Sound always paired with a visual; never the only signal.

---

## 16. Copy TH/EN (key strings; add to `en.ts`/`th.ts` under these keys)

| Key | EN | TH |
|---|---|---|
| `queue.newPill` | `{count} new — press .` | `ใหม่ {count} รายการ — กด .` |
| `queue.views.mine` | My queue | คิวของฉัน |
| `queue.views.unassigned` | Unassigned | ยังไม่มีผู้รับผิดชอบ |
| `queue.views.slaRisk` | SLA at risk | ใกล้หลุด SLA |
| `queue.views.triage` | Needs triage | รอคัดแยก |
| `queue.views.otherMail` | Other mail | อีเมลอื่น ๆ |
| `queue.filters.clear` | Clear filters | ล้างตัวกรอง |
| `queue.emptyFiltered` | No tickets match these filters. | ไม่มี ticket ที่ตรงกับตัวกรองนี้ |
| `queue.unverified` | Unverified | ยังไม่ยืนยันตัวตน |
| `sla.onTrack` | `{target} {time}` | `{target} {time}` |
| `sla.atRisk` | `{time} left` | `เหลือ {time}` |
| `sla.breached` | `Overdue {time}` | `เกินกำหนด {time}` |
| `sla.paused` | Paused | หยุดนับ |
| `sla.met` | Met | ทันเวลา |
| `sla.firstResponse` | FR | ตอบแรก |
| `sla.resolution` | Res | แก้ไข |
| `status.new` / `triage` / `open` | New / Triage / Open | ใหม่ / คัดแยก / กำลังดำเนินการ |
| `status.waitingOnCustomer` | Waiting on customer | รอลูกค้า |
| `status.waitingOnDev` | Waiting on dev | รอทีมพัฒนา |
| `status.resolved` / `closed` / `merged` | Resolved / Closed / Merged | แก้ไขแล้ว / ปิดแล้ว / รวมแล้ว |
| `timeline.internalNote` | Internal note — not sent to the customer | โน้ตภายใน — ไม่ส่งถึงลูกค้า |
| `timeline.sentVia` | `Sent via {channel}` | `ส่งทาง {channel}` |
| `timeline.deliveryFailed` | Not delivered — Retry | ส่งไม่สำเร็จ — ลองอีกครั้ง |
| `timeline.aiDraftApproved` | `AI draft · approved by {name}` | `ร่างจาก AI · อนุมัติโดย {name}` |
| `timeline.aiDraftEdited` | `AI draft · edited by {name} ({percent}% changed)` | `ร่างจาก AI · แก้โดย {name} (เปลี่ยน {percent}%)` |
| `timeline.autoAck` | Automatic acknowledgment | ข้อความตอบรับอัตโนมัติ |
| `timeline.systemCollapsed` | `{count} system events — show` | `เหตุการณ์ระบบ {count} รายการ — แสดง` |
| `composer.reply` / `composer.note` | Reply / Internal note | ตอบกลับ / โน้ตภายใน |
| `composer.sendVia` | Send via | ส่งทาง |
| `composer.send` / `composer.addNote` | Send / Add note | ส่ง / เพิ่มโน้ต |
| `composer.sendAndSet` | Send and set status | ส่งและเปลี่ยนสถานะ |
| `composer.undo` | `Sending in {seconds} s — Undo` | `กำลังส่งใน {seconds} วินาที — ยกเลิก` |
| `composer.lineQuota` | `LINE push · {used} / {limit} used this month` | `LINE push · ใช้ไป {used} / {limit} เดือนนี้` |
| `composer.lineQuotaWarn` | `Quota {percent}% used — consider email` | `ใช้โควตาไป {percent}% — พิจารณาส่งทางอีเมล` |
| `composer.lineQuotaOut` | Monthly push quota used up. Send by email instead. | โควตา push เดือนนี้หมดแล้ว ส่งทางอีเมลแทน |
| `composer.unverifiedWarn` | Unverified contact — don't share account data, internal links or root causes. | ผู้ติดต่อยังไม่ยืนยันตัวตน — ห้ามให้ข้อมูลบัญชี ลิงก์ภายใน หรือสาเหตุของปัญหา |
| `composer.unresolvedVar` | `Fill in {variable} before sending.` | `กรอก {variable} ก่อนส่ง` |
| `ai.investigating` | `Investigating… step {step} of {total}: {label}` | `กำลังตรวจสอบ… ขั้นที่ {step} จาก {total}: {label}` |
| `ai.evidence` | Evidence | หลักฐาน |
| `ai.openSource` | Open source | เปิดแหล่งที่มา |
| `ai.pin` | Pin to ticket | ปักไว้ใน ticket |
| `ai.uncited` | Uncited claim | ข้อความที่ไม่มีอ้างอิง |
| `ai.approve` / `ai.edit` / `ai.reject` | Approve and send / Edit / Reject | อนุมัติและส่ง / แก้ไข / ปฏิเสธ |
| `ai.rejectTitle` | Why are you rejecting this draft? | ทำไมจึงปฏิเสธร่างนี้ |
| `ai.requestDraft` | Draft a reply | ให้ AI ร่างคำตอบ |
| `ai.stage0Off` | Drafts are off for this intent (Stage 0 · Observe). | intent นี้ปิดการร่างคำตอบ (ขั้น 0 · สังเกต) |
| `ai.unavailable` | AI is unavailable. The ticket was created; investigation will retry. | AI ใช้งานไม่ได้ขณะนี้ ticket ถูกสร้างแล้ว และจะตรวจสอบใหม่อัตโนมัติ |
| `ai.paused` | `AI paused by {name} at {time} — replies are manual.` | `AI ถูกหยุดโดย {name} เมื่อ {time} — ตอบด้วยตนเองเท่านั้น` |
| `ai.confidence.high/medium/low` | High / Medium / Low | สูง / กลาง / ต่ำ |
| `alerts.acknowledge` | Acknowledge | รับทราบ |
| `alerts.moreP1` | `+{count} more P1` | `P1 อีก {count} รายการ` |
| `alerts.ackedVia` | `Acknowledged by {name} via {source}` | `รับทราบโดย {name} ผ่าน {source}` |
| `focus.on` | `Focus on · digest at {time}` | `โหมดโฟกัส · สรุปเวลา {time}` |
| `focus.off` | Focus off | ปิดโหมดโฟกัส |
| `sound.off` | Sound off | ปิดเสียง |
| `shift.clockIn` / `shift.clockOut` | Clock in / Clock out | เข้ากะ / ออกกะ |
| `shift.onShift` | `On shift · {range} · {left} left` | `อยู่ในกะ · {range} · เหลือ {left}` |
| `shift.late` | `Late {time}` | `สาย {time}` |
| `shift.clockOutBlocked` | `Finish the handoff first: {count} items need a next action.` | `ส่งต่องานให้เสร็จก่อน: ยังมี {count} รายการที่ไม่มีขั้นตอนถัดไป` |
| `shift.locationConsent` | Share my location for this clock-in (optional) | แชร์ตำแหน่งสำหรับการเข้ากะครั้งนี้ (ไม่บังคับ) |
| `brief.title` | Daily brief | สรุปก่อนเริ่มกะ |
| `brief.markRead` | Mark brief read | อ่านสรุปแล้ว |
| `handoff.title` | Shift handoff | ส่งต่องานระหว่างกะ |
| `handoff.aiFilled` | AI filled — check before confirming | AI กรอกให้ — ตรวจก่อนยืนยัน |
| `handoff.nextActionRequired` | Next action is required | ต้องระบุขั้นตอนถัดไป |
| `handoff.confirm` | Confirm handoff | ยืนยันการส่งต่องาน |
| `handoff.accept` / `reassign` / `ask` | Accept / Reassign / Ask a question | รับงาน / มอบหมายใหม่ / ถามคำถาม |
| `handoff.progress` | `{done} of {total} acknowledged` | `รับทราบแล้ว {done} จาก {total}` |
| `handoff.leadAlertAt` | `The lead will be alerted at {time} if items are still unacknowledged.` | `หากยังไม่รับทราบภายใน {time} ระบบจะแจ้งหัวหน้าทีม` |
| `handoff.carried` | `Crossed {count} shifts` | `ข้ามมาแล้ว {count} กะ` |
| `notes.audience.nextShift` / `person` / `datetime` | Next shift / Person / Date and time | กะถัดไป / ระบุคน / วันและเวลา |
| `otherMail.convert` | This is a ticket | เปิดเป็น ticket |
| `otherMail.empty` | No other mail. Auto-replies, bounces and newsletters land here instead of the queue. | ไม่มีอีเมลอื่น ๆ — อีเมลตอบกลับอัตโนมัติ อีเมลตีกลับ และจดหมายข่าวจะมาอยู่ที่นี่แทนคิวงาน |
| `portal.submit` | Submit request | ส่งคำขอ |
| `portal.received` | `We received your request {number}` | `เราได้รับคำขอ {number} แล้ว` |
| `portal.trackingSent` | `We sent a tracking link to {email}.` | `เราส่งลิงก์ติดตามสถานะไปที่ {email} แล้ว` |
| `portal.status.received/inProgress/waitingForYou/resolved/closed` | Received / In progress / Waiting for your reply / Resolved / Closed | ได้รับแล้ว / กำลังดำเนินการ / รอคำตอบจากคุณ / แก้ไขแล้ว / ปิดแล้ว |
| `portal.linkExpired` | This link has expired. Enter your email and we'll send a new one. | ลิงก์นี้หมดอายุแล้ว กรอกอีเมลเพื่อรับลิงก์ใหม่ |
| `portal.verifyFailed` | Verification couldn't load. Check your connection or try another browser. | โหลดการยืนยันตัวตนไม่สำเร็จ ตรวจการเชื่อมต่อหรือลองเบราว์เซอร์อื่น |
| `csat.subject` | `How did we do with {number}?` | `บริการของเราสำหรับ {number} เป็นอย่างไรบ้าง` |
| `csat.scale.1`…`5` | Very poor / Poor / OK / Good / Very good | แย่มาก / แย่ / พอใช้ / ดี / ดีมาก |
| `csat.thanks` | `Thanks — you rated {score} · {label}` | `ขอบคุณ — คุณให้คะแนน {score} · {label}` |
| `csat.resolvedQ` | Was your issue resolved? | ปัญหาของคุณได้รับการแก้ไขแล้วหรือไม่ |
| `csat.reopened` | We've reopened your request and a lead will contact you. | เราเปิดคำขอของคุณอีกครั้ง และหัวหน้าทีมจะติดต่อกลับ |
| `admin.int.notConfigured` / `configured` | Not configured / Configured | ยังไม่ได้ตั้งค่า / ตั้งค่าแล้ว |
| `admin.int.setOn` | `Set · updated {date} by {name}` | `ตั้งแล้ว · อัปเดต {date} โดย {name}` |
| `admin.int.envLocked` | `Set by environment variable {name} — change it in your deployment.` | `ตั้งจาก environment variable {name} — แก้ที่การ deploy` |
| `admin.int.replace` / `test` | Replace / Test connection | เปลี่ยนค่า / ทดสอบการเชื่อมต่อ |
| `admin.int.testOk` / `testFail` | Connected / Connection failed: {reason} | เชื่อมต่อสำเร็จ / เชื่อมต่อไม่สำเร็จ: {reason} |
| `states.offline` | `You're offline. Showing data from {time}.` | `คุณออฟไลน์อยู่ แสดงข้อมูล ณ {time}` |
| `states.reconnecting` | Reconnecting… | กำลังเชื่อมต่อใหม่… |
| `states.denied` | `You don't have access to this page. It needs the {role} role.` | `คุณไม่มีสิทธิ์เข้าหน้านี้ ต้องมีบทบาท {role}` |
| `states.sessionExpired` | Your session ended. Sign in again — your draft is saved. | เซสชันหมดอายุ เข้าสู่ระบบอีกครั้ง — ร่างของคุณถูกบันทึกไว้แล้ว |

Thai copy notes: keep `ticket`, `SLA`, `intent`, `LINE`, `push` in English (team vocabulary, matches existing `th.ts`); polite neutral tone without ครับ/ค่ะ; customer-facing portal/CSAT copy may be overridden per deployment `[ASSUMED]`.

---

## 17. Open questions — decided by `po` under owner delegation 2026-11-01 (all `[ASSUMED]`, owner review pending)
| # | Question | Decision |
|---|---|---|
| Q1 | Undo-send window length (and whether approve should confirm instead) | 5 s Undo toast, hold is **server-side** (send scheduled at T+5 s, Undo cancels); org setting 0–30 s; inline confirm only for uncited claims or LINE quota ≥ 80 %; auto-ack not delayed |
| Q2 | AI accent colour (no accent in brand palette besides seafoam/gold) | `aiAccent`/`aiSurface` from `#80CFC0`, darkened in light theme until text ≥ 4.5:1 and UI ≥ 3:1; pairs added to `contrast.test.ts`; AI chip always icon + text "AI" |
| Q3 | Focus-mode digest interval and whether P2 breaks through focus | digest every 15 min (user setting 5–60); P1 and P2 interrupt; P3/P4/assign/mention batched |
| Q4 | Does P1 sound repeat until ack? | repeat every 60 s until anyone acks/opens, ≤ 1 sound per 10 s; mute allowed but banner stays and "Sound off" is shown; clock-in warns if muted |
| Q5 | Human-verification provider for the portal (needs ADR + new network destination → `[ASK-HUMAN]`) | self-hosted PoW + honeypot + rate limit behind `HumanVerificationProvider`; hosted provider `[ASK-HUMAN]`; ADR before T-007 |
| Q6 | Show agent names to customers on the portal? | public display name (default first name, alias allowed); never surname/email/role; approved AI drafts show the approver; no external avatar URLs |
| Q7 | Mobile layout split at 768 px vs current stack below 1024 px | 3 tiers as §3.2; ≥ 1440 widening + per-user widths are nice-to-have |
| Q8 | Reject reason codes | the 9 codes in §6.3, stable English ids stored as data (not a CHECK); `other` requires a comment |
| Q9 | SLA at-risk threshold | ≤ 25 % of target left **or** ≤ 30 min, whichever first, in business time; default per SLA policy, computed server-side |
| Q10 | Alert severity → P-level | critical→P1, error→P2, warning→P3, info→P4, configurable per policy; unknown → P3 + "Severity unmapped" label + head warning; GCP field values `[VERIFY]` |
| Q11 | Spec language | English (PRD/open-source docs); TH copy stays in §16 |

---

## 18. Head console (T-127) — Head home + Admin

> Why: owner asked 2026-11-01 "isn't there a page for the head of tech ops yet?" — there was none. Scope: a Phase 1 **light** Head home (PRD §9.1 without history/charts; the full Ops dashboard is T-206) and the P0 admin pages of PRD §4.12 that already have an API. Visual style follows `docs/design/ui-refresh-2026-11.md` (rail, 1 px hairlines, no cards, no UPPERCASE, inline comboboxes, neutral canvas, colour only with meaning); behaviour follows §6.4–6.5, §12–15 of this spec.
> API names were read from `apps/api/src/**/*.controller.ts` on `main` and from `apps/api/src/autonomy/` + ADR-011 on `wip/t-112a` (not merged yet) on 2026-11-01. `[NEEDS API]` = no endpoint exists; the stated interim is what the UI does until it does. Everything not decided by PRD/ADR is `[ASSUMED]`.

### 18.1 Navigation, routes, keyboard
| Route | Page | Visible with (permission, role per PRD §2.2) | Breadcrumb |
|---|---|---|---|
| `/home` | Head home (§18.2) | `user.read` (head, lead) `[ASSUMED]` | Home |
| `/admin` | Redirects to the first section the user may open | any admin permission below | — |
| `/admin/users` | Users & roles | `user.read` (lead read-only, head edits: `user.manage`) | Admin / Users |
| `/admin/orgs`, `/admin/orgs/:id` | Organizations, one org + its contacts | `org.manage` (lead, head) | Admin / Organizations / Acme Logistics |
| `/admin/sla`, `/admin/sla/calendars/:id` | SLA policies, business calendar + holidays | `sla.manage` (head) | Admin / SLA / Bangkok office hours |
| `/admin/intents`, `/admin/intents/:id` | Intents + autonomy stage | `intent.manage` (lead, head) | Admin / Intents / webhook_not_received |
| `/admin/queues` | Queues & members | `queue.manage` (lead, head) | Admin / Queues |
| `/admin/ai` | AI controls (§18.4) | `ai.autonomy.set` (lead read-only, head acts) | Admin / AI controls |
| `/admin/audit` | Audit log | `audit.read` (head) | Admin / Audit log |
| `/admin/integrations` | Integrations (§12) | `integration.manage` (head) | Admin / Integrations |

- **Rail**: after the existing queue/brief/handoff/notifications items add `Home` (lucide `gauge`), a hairline separator, then `Admin` (`settings-2`). Items the user may not open are **hidden**, not disabled (same rule as §12). `aria-current="page"` on the active one.
- **Admin layout**: rail · 220 px section list (plain text links with count where cheap, hairline right border) · page. The section list shows only permitted sections. Below 768 px the section list becomes a `Combobox` "Section" in the page header.
- **Page header** (48 px, normal case): breadcrumb `nav aria-label="Breadcrumb"` (last item `aria-current="page"`) left; page actions right (`Invite`, `New organization`…). Body = one table or one form; edits open in a right **sheet** (400 px, modal, focus returns to the row on close; unsaved changes ask before closing).
- **Landing** `[ASSUMED]`: head lands on `/home` after sign-in; lead and agent land on the queue.
- **Keyboard** (adds to §14; single keys follow the §14 text-field rule): `g` then `d` Head home · `g` then `a` Admin · on admin lists `J`/`K` move the row focus, `Enter` opens the sheet, `N` starts "New…", `/` focuses the page filter (not the queue search) · `Esc` closes the sheet.
- **⌘K**: new palette group `admin` — "Go to Home", "Go to Admin › {section}" (filtered by permission); head only: "AI: Stop all AI runs…", "AI: Limit all intents to Stage 2…". Palette commands only **open** the confirm dialog of §18.4; they never flip a switch directly.

### 18.2 Head home `/home` (Phase 1 light)
```
Home                                     Data from 09:14 · refreshes every minute  [Refresh]
-----------------------------------------------------------------------------------------------
[info] AI runs are stopped since 08:50 — replies are manual.                    [AI controls]   <- only while a switch is on
-----------------------------------------------------------------------------------------------
SLA at risk now  7  (2 overdue)            [View in queue] | Waiting for someone
[P1] OPS-1240  Overdue 12m   Acme Logistics   unassigned   | Unassigned      3   oldest 18m
[P2] OPS-1234  FR 18m left   Example Co.      (MK)         | New (not triaged) 2
... up to 10 rows, then "Show all 7"                       | Needs triage    1
-----------------------------------------------------------------------------------------------
Open tickets by status                                     | Open tickets by queue
New 4 · Triage 2 · Open 31 · Waiting on dev 6 ·            | Default 22 · Billing 9 · No queue 3
Waiting on customer 12 (SLA paused)                        |
-----------------------------------------------------------------------------------------------
Open load per person                                       | System health
(MK) Mana K.     9 open · 2 at risk                        | [check] Database and Redis: ready
(PS) Pim S.      4 open · 0 at risk                        | [minus] Outbound queue: not available yet
(DN) Dao N.      0 open                                    | [minus] Integrations: not available yet
-----------------------------------------------------------------------------------------------
AI   Runs: on · Stage limit: off · 14 intents: Stage 0 · 2 · Stage 1 · 3 · Stage 2 · 9 · 1 pinned   [Intents]
```
| Widget | Shows | Data source today | Gap |
|---|---|---|---|
| SLA at risk now | count + top 10 rows (severity, key, `SlaBadge`, org, assignee avatar); "overdue" sub-count | `GET /v1/tickets?status=new,triage,open,waiting_on_dev&sort=due_asc&limit=200` → existing `slaView()` (`apps/web/src/lib/tickets/sla.ts`) keeps `atRisk` + `breached`; overdue alone = `overdue=true` | `[NEEDS API]` server `slaState=at_risk` filter + total count (same need as T-119 "SLA at risk" view); counts are "at least" when the page is full |
| Waiting for someone | unassigned, new, triage counts; oldest unassigned age | `GET /v1/tickets?assignee=unassigned&status=new,triage,open`, `?status=new`, `?status=triage` (limit 200 each) | `[NEEDS API]` `created_asc` sort / counts; oldest computed from the loaded page |
| Open by status / by queue | one labelled number per status / per queue, each a link to the queue filtered | one `GET /v1/tickets?status=<open statuses>&limit=200` grouped client-side; queue names `GET /v1/queues` | `[NEEDS API]` grouped counts endpoint (e.g. `GET /v1/tickets/counts?groupBy=status\|queue\|assignee`) |
| Open load per person | per active staff user: open count, at-risk count; people with 0 still listed | same ticket page grouped by `assignee`; people from `GET /v1/users` (active, staff) | same counts endpoint; this is load, not performance (performance is T-206) |
| System health | Postgres + Redis readiness; outbound queue pending/dead + oldest pending age; integration health | `GET /health/ready` ✓ | `[NEEDS API]` outbox pending/dead/oldest (T-121) · integration health (T-116) — rows show "Not available yet" in muted text, never hidden and never green |
| AI status | both switch states with who/when; intents per stage; pinned count | `GET /v1/autonomy` (`wip/t-112a`) | names of `changedBy` need `GET /v1/users` (head/lead have it) |

- Restraint (dataviz): **numbers with labels and lists only** — no charts, sparklines, trends or WoW deltas in Phase 1 (they need history → T-206). `tabular-nums` for all counts and times. A count ≥ 200 from a full page shows `200+`.
- Every number is a link to the queue with the matching filter (status, queue, assignee, `overdue`); the "SLA at risk" link opens the `SLA at risk` saved view once T-119 lands, until then the queue sorted by due time.
- Colour only where it means something: severity badges, SLA badge states, AI banner (info). Section titles are plain 14 px/600 text, sections divided by hairlines.
- Refresh: refetch every 60 s `[ASSUMED]` + `Refresh` button; numbers change in place. Lists never reorder while focus or hover is inside them — they show the §4.3 pill "`{count} changed — press .`" instead.
- Lead sees the same page; the AI line links to a read-only AI controls page. Agents have no Home (their home is the queue).

### 18.3 Admin pages
Common pattern: `DataTable` (sticky header, sortable columns with `aria-sort`, row = one focusable item, `h-row` height) + filter field + right sheet for create/edit. Save is explicit (button), success toast, field errors inline from the API's 400 details, 409 messages shown as a plain sentence above the form. Nothing is deleted from a list without a confirm dialog naming the item.

| Page | List columns | Create / edit and rules | API |
|---|---|---|---|
| Users & roles | avatar + name · email · role pill · status dot + text (`Active`/`Disabled`) · last sign-in | `Invite` (head): email, name, role `agent`/`lead`/`head` — "They sign in with Google using this address." Role = inline combobox; promoting to `head` asks to confirm. `Disable…` confirm: "Their sessions end now." `Enable`. `Sign out everywhere` (`session.revoke.any`). Own row: role/status read-only with "You can't change your own role or status." **Break-glass** row: lock icon + "Emergency sign-in account — not editable here", no actions. Lead: whole page read-only. | `GET/POST/PATCH /v1/users`, `POST /v1/users/:id/force-logout` · role–permission matrix `GET /v1/rbac/roles` shown read-only in a "Roles" tab `[ASSUMED]` (editing `PUT` deferred) |
| Organizations | name · tier · status · domains (first + "+2") · SLA policy · contacts count `[NEEDS API]` (hidden until available) | Sheet: name, tier (combobox), SLA policy (combobox, "Tier default" option = null), domains (chip input; free-mail domains rejected inline with the API message), LINE group ids, notes, status `Active`/`Inactive`. Deactivate preferred over delete; `Delete…` in overflow, API 409 shown as text. Org page tabs: **Details · Contacts · Tickets** (Tickets = link to queue `orgId=`). | `GET/POST/PATCH/DELETE /v1/orgs` · tier list `[NEEDS API]` (T-121 `org_tier`); interim: tiers seen on loaded orgs + typed slug validated by the API |
| Contacts (org tab) | name · emails · LINE linked (icon + "Linked") · verified (`Verified` / `Unverified` chip, §4.1) · role in org | Sheet: name, emails (1–10), LINE user id, phone, role in org. `Invite to portal` = `POST /v1/users` role `client` + `orgId` (lead/head, `client.invite`). | `GET /v1/contacts?orgId=`, `POST/PATCH/DELETE /v1/contacts` |
| SLA policies | name · tier default · P1–P4 "FR / Res" targets in business time · calendar | Sheet: name, tier, calendar, a 4-row grid (priority × first response × resolution × `Business`/`24×7` segmented). Inline error if FR > Res. Editing note: "Changes apply to new due times; running tickets keep theirs." `[ASSUMED]` | `GET/POST/PATCH/DELETE /v1/sla-policies` |
| Business calendars + holidays | calendar list: name · timezone · default · holiday count; holiday table: date · weekday · name · check state | Weekly hours: 7 rows, time-window inputs. Holidays: add row, edit inline, remove, import JSON file (preview before save; duplicates flagged). **`[VERIFY]` badge**: every imported/example holiday shows `Not checked` (icon `shield-question` + text) until a person ticks `Checked against the official announcement`; a calendar with unchecked rows shows a warning line above the table. | `GET/POST/PATCH /v1/business-calendars` (holidays are part of the calendar body) · per-holiday check state `[NEEDS API]` (holiday has only `date`,`name`); interim: calendar-level warning "Check every date against the official announcement before using it for a real SLA." always shown, no per-row badge |
| Intents | name + key (mono) · default priority (`SeverityBadge`) · SLA policy · `StageBadge` · pinned (lock + "Pinned") · active | Sheet tabs **Details · Autonomy · History**. Details: name, description, typical evidence, default priority, SLA policy, active (allowed tools + reply templates read-only chips in this version `[ASSUMED]`). Autonomy: §18.3.1. History: stage/pin changes (who, when, from→to, reason). | `GET/POST/PATCH /v1/intents` · `GET /v1/autonomy`, `POST /v1/intents/:id/autonomy` (`wip/t-112a`) · History: `GET /v1/audit-logs?targetType=intent&targetId=` (head only) — `[NEEDS API]` history endpoint for leads; lead sees "History is visible to the head." |
| Queues & members | name · assignment (`Manual`/`Round robin`) · default · members (avatar group + count) | Sheet: name, assignment segmented control, default checkbox ("New tickets without a queue go here"), members multi-combobox of active staff. | `GET/POST/PATCH/DELETE /v1/queues`, people from `GET /v1/users` |
| Audit log | time · actor (name, or `System` / `AI` / `Anonymous`) · action (readable label + code in mono) · target (type + ticket key / intent key / short id) · outcome (`Success` check · `Failure` x · `Denied` lock) | Filters: actor (user combobox → `actorId`), action (combobox from the shared `AUDIT_ACTIONS` catalogue, exact match), target type + target id, outcome segmented (`Any`/`Success`/`Failure`/`Denied`), date range (default last 24 h, Asia/Bangkok). **No PII in the list**: no IP, no before/after, no email. Row → **detail sheet**: all fields, before/after as a field diff, metadata, IP, request id, copy id; PII-bearing values masked with a local `Show` toggle `[ASSUMED]`. `Load more` (keyset). Note under the header: "Opening this log is itself recorded." | `GET /v1/audit-logs` (head) · export `[NEEDS API]` (PRD §8.2) · actor-type filter `[NEEDS API]` |
| Integrations | as §12 | as §12 | `[NEEDS API]` T-116 |
| Portal links (not an admin page) | — | Ticket header overflow → `Revoke tracking links…` confirm: "Revoke every tracking link of OPS-1234? The customer can ask for a new one by email; only the requester receives it." Result toast "`{count}` links revoked". Any `ticket.handle` user. | `POST /v1/tickets/:id/portal-links/revoke` |

#### 18.3.1 Intent autonomy control (stage 0–2 only)
```
Autonomy                                                     [Stage 2 · Draft for approval]
Stage   ( Stage 0 · Observe | Stage 1 · Suggest | (*) Stage 2 · Draft for approval )
Reason  [ required, 3–500 characters                                   ]   [Change stage]
Pin     [ ] Pin this stage — nobody can change it until unpinned (head)    reason [....]
i  Stage 3 and above (automatic replies) is the owner's decision and isn't available in this version.
```
- `SegmentedControl` with exactly three options; **stage ≥ 3 is never rendered** (no option, no disabled option, no slider, no hint of a toggle) — §6.4. The owner-only line is static text.
- Changing the selection reveals the required reason field and `Change stage`; nothing is saved until then. Pin/unpin is a checkbox with its own required reason, **head only** (`ai.autonomy.set.any`); lead sees the pin state as text.
- Blocked states (text, not just disabled): pinned → "Pinned by {name} on {date} — unpin to change"; stage limit switch on → higher options disabled with "Stage limit is on — stages can only go down"; API 409 shows the same sentences; 403 `autonomy_stage_requires_owner` cannot happen from this UI but maps to the owner-only line.
- Success toast "Stage changed to Stage 1 · Suggest — recorded with your reason." `changed: false` → "Already at this stage — nothing changed."

### 18.4 AI controls `/admin/ai` (two emergency switches, po #23, ADR-011 §4)
```
Admin / AI controls                                                          Only the head can change these
-----------------------------------------------------------------------------------------------------------
[shield] Limit all intents to Stage 2 or lower                        Off            [Turn on…]
         Keeps every intent at its stage or lower and blocks raising. Never raises Stage 0 or 1.
         Last changed 1 Nov 10:42 by Mana K. — "eval regression on billing replies"
-----------------------------------------------------------------------------------------------------------
[circle-stop] Stop all AI runs                                        On since 08:50 [Turn off…]
         No classification, investigation or drafts. Safe automatic acknowledgments continue.
         Last changed 2 Nov 08:50 by Mana K. — "provider outage"
-----------------------------------------------------------------------------------------------------------
Stages per intent: Stage 0 · 2 · Stage 1 · 3 · Stage 2 · 9 · 1 pinned                      [Open intents]
```
- **Who**: head sees buttons (needs `ai.emergency_switch` + `ai.autonomy.set.any`, ADR-011); lead sees the same rows, states and history but no buttons, with "Only the head can change these."; agents never see the page (they see only the banner).
- **State** text + icon, never colour alone: `Off` (muted) · `On since {time}` (info tone, icon). Neither state is red — both are safe states (§6.5).
- **Confirm dialog** (both directions, po #23): title `Stop all AI runs?` / `Resume AI runs?` / `Limit all intents to Stage 2 or lower?` / `Remove the stage limit?`; 2–3 lines of consequences; **Reason** textarea required (3–500 chars, live counter, initial focus); line "Recorded in the audit log with your name and reason."; buttons `Cancel` + primary verb (`Stop AI runs`, `Resume AI runs`, `Turn on limit`, `Remove limit`). No typed confirmation. `Ctrl/⌘ Enter` submits, `Esc` cancels. Submit → `POST /v1/autonomy/switches {switch, on, reason}`; `changed: false` → toast "Already {state} — nothing changed."; 400 → inline reason error; 403 → permission-denied text in the dialog.
- **Banner semantics** (refines §6.5): kill switch on → global non-dismissible info `Alert` at the top of the main area for **all staff** (`ai.paused`; agents lack `user.read`, so they get `ai.pausedNoName` unless the API adds a display name `[NEEDS API]`), and the AI panel shows the same text instead of drafts. Stage limit on → no global banner (nothing changes for agents in Phase 1, stages are ≤ 2 already) `[ASSUMED]`; head/lead see a status line on Home, AI controls and Intents.
- Freshness: no realtime event for switches yet (ADR-011) → poll `GET /v1/autonomy` every 30 s on every staff screen + refetch after a flip `[ASSUMED]`.

### 18.5 States (applies §13 to these screens)
| Screen | Empty | Loading | Error | Permission denied |
|---|---|---|---|---|
| Head home | per section one line (`home.empty.*`): "No tickets at risk.", "Nothing waiting for an owner.", "No open tickets." | skeleton rows per section; text after 2 s "Loading home…" | per section inline error + `Try again`; other sections keep working | agent opening `/home` → §13 denied (`states.denied` with role `lead`) + link to queue |
| Admin lists | `EmptyState` + primary action ("No organizations yet." + `New organization`) · filtered: "Nothing matches — Clear filters" | table skeleton (5 rows) | inline above table, list keeps last data | §13 pattern; section hidden from section list and rail |
| Sheet save | — | button shows "Saving…", fields locked | inline + summary; "Your changes were not saved." | 403 mid-session → message in sheet, fields read-only |
| AI controls | — | skeleton of the two rows | "Couldn't load AI status. The switches keep their last state." + `Try again` | lead read-only (not an error); agent → §13 |
| Audit log | "No entries match these filters." | table skeleton | inline + `Try again` | §13 with role `head` |

### 18.6 Components (N6 — checked `packages/ui/src/index.ts` 2026-11-01)
- **Reuse**: `Button`, `Alert` (info/error/success — banner), `EmptyState`, `Input`/`Textarea`, `Skeleton`, `Avatar`, `Pill`/`StatusPill`/`StatusDot`, `Tooltip`, `Popover`, `DropdownMenu`, `Tabs`, `SegmentedControl`, `Separator`, `Combobox` (single + multi), `Toaster`/`toast`, `Kbd`, `SeverityBadge` · web: `NavRail`/`RailButton`, `SlaBadge` + `slaView`, `CommandPalette`, `UserMenu`.
- **New in `packages/ui`** (each with an icon+text / a11y test): `Dialog` (wrap the Radix Dialog the palette already uses — still missing from §2's list), `Sheet` (right drawer on the same primitive), `DataTable` (table + sortable header + roving row focus), `Breadcrumb`, `StageBadge` (§6.4, still missing).
- **New in `apps/web`**: `AdminLayout` + `AdminSectionNav`, `HomePage` sections, `SwitchRow` + `SwitchConfirmDialog`, `IntentAutonomyControl`, `HolidayTable`, `AuditFilters` + `AuditDetailSheet`.

### 18.7 Accessibility and density
- Tables: `<table>` with visible caption (= page title, `sr-only` if the header shows it), `th scope="col"`, `aria-sort` on sortable headers; status/outcome/stage/verified cells each icon + text.
- Head home sections are `section aria-labelledby` with `h2`; counts read as one phrase ("Unassigned, 3 tickets"); the 60 s refresh is not announced; the "changed" pill uses the §4.3 polite live region.
- Dialog/sheet: focus trapped, returns to the trigger; reason errors tied with `aria-describedby`; destructive-looking verbs never rely on red.
- Density: table rows and controls use `h-row`/`h-control` (compact 32/28, comfortable 40/32); Thai line-height ≥ 1.5 in multi-line cells.
- Grayscale check: Off/On switch states, outcomes and `Not checked` holidays stay distinguishable without colour.

### 18.8 Copy TH/EN (new keys; add to `en.ts`/`th.ts`, same style as §16)
| Key | EN | TH |
|---|---|---|
| `rail.home` / `rail.admin` | Home / Admin | หน้าหลัก / ผู้ดูแลระบบ |
| `admin.sections.users/orgs/sla/intents/queues/ai/audit/integrations` | Users / Organizations / SLA / Intents / Queues / AI controls / Audit log / Integrations | ผู้ใช้ / องค์กร / SLA / intent / คิว / การควบคุม AI / บันทึกการตรวจสอบ / การเชื่อมต่อ |
| `admin.breadcrumb` | Breadcrumb | เส้นทางหน้า |
| `home.title` | Home | หน้าหลัก |
| `home.dataAt` | `Data from {time} · refreshes every minute` | `ข้อมูล ณ {time} · อัปเดตทุกนาที` |
| `home.refresh` | Refresh | รีเฟรช |
| `home.slaRisk` | SLA at risk now | ใกล้หลุด SLA ตอนนี้ |
| `home.overdueCount` | `{count} overdue` | `เกินกำหนด {count}` |
| `home.waiting` | Waiting for someone | รอคนรับ |
| `home.unassigned` / `home.new` / `home.triage` | Unassigned / New (not triaged) / Needs triage | ยังไม่มีผู้รับผิดชอบ / ใหม่ (ยังไม่คัดแยก) / รอคัดแยก |
| `home.oldest` | `oldest {time}` | `นานสุด {time}` |
| `home.byStatus` / `home.byQueue` | Open tickets by status / Open tickets by queue | ticket ที่เปิดอยู่ตามสถานะ / ตามคิว |
| `home.noQueue` | No queue | ไม่อยู่ในคิวใด |
| `home.load` | Open load per person | งานที่ถืออยู่ต่อคน |
| `home.loadRow` | `{open} open · {atRisk} at risk` | `เปิดอยู่ {open} · ใกล้หลุด {atRisk}` |
| `home.atLeast` | `{count}+` | `{count}+` |
| `home.health` | System health | สถานะระบบ |
| `home.health.ready` / `notReady` | Database and Redis: ready / Database or Redis: not responding | ฐานข้อมูลและ Redis: พร้อม / ฐานข้อมูลหรือ Redis: ไม่ตอบสนอง |
| `home.health.outbox` | `Outbound queue: {pending} waiting · {dead} failed · oldest {age}` | `คิวส่งออก: รอ {pending} · ล้มเหลว {dead} · ค้างนานสุด {age}` |
| `home.health.unavailable` | Not available yet | ยังไม่พร้อมใช้งาน |
| `home.ai` | `Runs: {runs} · Stage limit: {limit} · {count} intents` | `การทำงานของ AI: {runs} · จำกัดขั้น: {limit} · intent {count} รายการ` |
| `home.changedPill` | `{count} changed — press .` | `เปลี่ยน {count} รายการ — กด .` |
| `home.empty.slaRisk` / `waiting` / `open` | No tickets at risk. / Nothing waiting for an owner. / No open tickets. | ไม่มี ticket ที่ใกล้หลุด SLA / ไม่มีงานรอคนรับ / ไม่มี ticket ที่เปิดอยู่ |
| `admin.users.invite` | Invite | เชิญ |
| `admin.users.inviteHint` | They sign in with Google using this address. | ผู้ใช้จะเข้าสู่ระบบด้วย Google ด้วยอีเมลนี้ |
| `admin.users.disableConfirm` | `Disable {name}? Their sessions end now.` | `ปิดบัญชี {name}? เซสชันทั้งหมดจะสิ้นสุดทันที` |
| `admin.users.enable` / `signOutAll` | Enable / Sign out everywhere | เปิดใช้งาน / ออกจากระบบทุกอุปกรณ์ |
| `admin.users.selfLocked` | You can't change your own role or status. | คุณเปลี่ยนบทบาทหรือสถานะของตัวเองไม่ได้ |
| `admin.users.breakGlass` | Emergency sign-in account — not editable here | บัญชีเข้าระบบฉุกเฉิน — แก้ไขที่หน้านี้ไม่ได้ |
| `admin.users.promoteHead` | `Make {name} a head? Heads can change integrations, users and AI controls.` | `ตั้ง {name} เป็น head? head แก้การเชื่อมต่อ ผู้ใช้ และการควบคุม AI ได้` |
| `admin.orgs.new` / `admin.orgs.tierDefault` | New organization / Tier default | เพิ่มองค์กร / ตามค่าเริ่มต้นของ tier |
| `admin.orgs.inviteClient` | Invite to portal | เชิญเข้า portal |
| `admin.sla.appliesToNew` | Changes apply to new due times; running tickets keep theirs. | การแก้ไขมีผลกับกำหนดเวลาใหม่ ticket ที่กำลังนับอยู่ใช้ค่าเดิม |
| `admin.cal.notChecked` | Not checked | ยังไม่ตรวจ |
| `admin.cal.markChecked` | Checked against the official announcement | ตรวจกับประกาศทางการแล้ว |
| `admin.cal.verifyWarn` | Check every date against the official announcement before using it for a real SLA. | ตรวจทุกวันที่กับประกาศทางการก่อนใช้กับ SLA จริง |
| `admin.intents.stageReason` | Reason (required) | เหตุผล (จำเป็น) |
| `admin.intents.changeStage` | Change stage | เปลี่ยนขั้น |
| `admin.intents.pin` | Pin this stage — nobody can change it until unpinned | ปักขั้นนี้ไว้ — ไม่มีใครเปลี่ยนได้จนกว่าจะยกเลิกการปัก |
| `admin.intents.pinnedBy` | `Pinned by {name} on {date} — unpin to change` | `ปักไว้โดย {name} เมื่อ {date} — ยกเลิกการปักก่อนจึงเปลี่ยนได้` |
| `admin.intents.capOn` | Stage limit is on — stages can only go down | เปิดการจำกัดขั้นอยู่ — ลดขั้นได้อย่างเดียว |
| `admin.intents.ownerOnly` | Stage 3 and above (automatic replies) is the owner's decision and isn't available in this version. | ขั้น 3 ขึ้นไป (ตอบลูกค้าอัตโนมัติ) เป็นการตัดสินใจของเจ้าของ และยังไม่มีในเวอร์ชันนี้ |
| `admin.intents.stageChanged` / `noChange` | `Stage changed to {stage} — recorded with your reason.` / Already at this stage — nothing changed. | `เปลี่ยนเป็น {stage} แล้ว — บันทึกพร้อมเหตุผล` / อยู่ขั้นนี้แล้ว — ไม่มีการเปลี่ยนแปลง |
| `admin.intents.historyHeadOnly` | History is visible to the head. | ประวัติดูได้เฉพาะ head |
| `admin.ai.capTitle` / `capBody` | Limit all intents to Stage 2 or lower / Keeps every intent at its stage or lower and blocks raising. Never raises Stage 0 or 1. | จำกัดทุก intent ไม่เกินขั้น 2 / คงขั้นเดิมหรือต่ำกว่า และห้ามยกขั้น ไม่ยกขั้น 0 หรือ 1 ขึ้น |
| `admin.ai.killTitle` / `killBody` | Stop all AI runs / No classification, investigation or drafts. Safe automatic acknowledgments continue. | หยุด AI ทั้งหมด / ไม่คัดแยก ไม่ตรวจสอบ ไม่ร่างคำตอบ ข้อความตอบรับอัตโนมัติที่ปลอดภัยยังส่งต่อ |
| `admin.ai.off` / `onSince` | Off / `On since {time}` | ปิด / `เปิดตั้งแต่ {time}` |
| `admin.ai.lastChanged` | `Last changed {time} by {name} — "{reason}"` | `เปลี่ยนล่าสุด {time} โดย {name} — "{reason}"` |
| `admin.ai.headOnly` | Only the head can change these. | head เท่านั้นที่เปลี่ยนได้ |
| `admin.ai.turnOn` / `turnOff` | Turn on… / Turn off… | เปิด… / ปิด… |
| `admin.ai.confirm.stop` / `resume` / `limit` / `unlimit` | Stop AI runs / Resume AI runs / Turn on limit / Remove limit | หยุด AI / ให้ AI ทำงานต่อ / เปิดการจำกัด / ยกเลิกการจำกัด |
| `admin.ai.reasonLabel` | `Reason (required, {min}–{max} characters)` | `เหตุผล (จำเป็น {min}–{max} ตัวอักษร)` |
| `admin.ai.auditNote` | Recorded in the audit log with your name and reason. | บันทึกลง audit log พร้อมชื่อและเหตุผลของคุณ |
| `admin.ai.noChange` | `Already {state} — nothing changed.` | `{state} อยู่แล้ว — ไม่มีการเปลี่ยนแปลง` |
| `ai.pausedNoName` | `AI paused at {time} — replies are manual.` | `AI ถูกหยุดเมื่อ {time} — ตอบด้วยตนเองเท่านั้น` |
| `admin.audit.readNote` | Opening this log is itself recorded. | การเปิดดูบันทึกนี้ก็ถูกบันทึกด้วย |
| `admin.audit.outcome.success/failure/denied` | Success / Failure / Denied | สำเร็จ / ล้มเหลว / ถูกปฏิเสธ |
| `admin.audit.actor.system/ai/anonymous` | System / AI / Anonymous | ระบบ / AI / ไม่ระบุตัวตน |
| `admin.audit.loadMore` / `show` | Load more / Show | โหลดเพิ่ม / แสดง |
| `admin.portal.revoke` | Revoke tracking links… | ยกเลิกลิงก์ติดตามสถานะ… |
| `admin.portal.revokeConfirm` | `Revoke every tracking link of {number}? The customer can ask for a new one by email; only the requester receives it.` | `ยกเลิกลิงก์ติดตามทั้งหมดของ {number}? ลูกค้าขอลิงก์ใหม่ทางอีเมลได้ และส่งถึงผู้แจ้งเท่านั้น` |
| `admin.portal.revoked` | `{count} links revoked` | `ยกเลิกลิงก์แล้ว {count} รายการ` |
| `admin.form.saving` / `notSaved` | Saving… / Your changes were not saved. | กำลังบันทึก… / การแก้ไขยังไม่ถูกบันทึก |

### 18.9 Open questions (for `po`, all `[ASSUMED]` until decided)
| # | Question | Proposal |
|---|---|---|
| H1 | Who sees `/home` — head only (owner's wording) or head + lead (PRD §9.1 "head, lead")? | head + lead; agents keep the queue |
| H2 | Counts need an aggregate endpoint (tickets by status/queue/assignee + `slaState=at_risk`) | add to T-119 or a new backend task before T-127 UI; interim client grouping with `200+` cap |
| H3 | Kill-switch banner name for agents (`changedBy` is a uuid; agents lack `user.read`) | API adds `changedByName` to `aiSwitch`; until then `ai.pausedNoName` |
| H4 | Holiday check state (`[VERIFY]` per row) needs a field on `holiday` | add `checked: boolean` (+ who/when) in a migration; interim calendar-level warning |
| H5 | Stage limit switch: global banner or not? | no global banner in Phase 1 (no behaviour change); status line for head/lead |
| H6 | Intent autonomy history for leads | `GET /v1/intents/:id/autonomy/history` (reads `intent_autonomy_history`); head uses audit log meanwhile |
