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
| Fonts | `tokens/css.ts` `SANS_STACK`, `MONO_STACK` | `font-sans`, `font-mono` | Inter + Noto Sans Thai. Thai needs line-height ≥ 1.5 for body text so tone marks don't clip. |

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
