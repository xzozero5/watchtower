# UI refresh (T-124) — design direction after studying 21st.dev

> Owner request 2026-11-01: the T-006 UI "looks too AI-generated"; study https://21st.dev and make the UI more pleasant and usable.
> Research by a `general-purpose` agent on 2026-11-01; direction decided by the main thread. All rules are `[ASSUMED]` until the owner reviews the screenshots.
> This document amends `docs/06-UI-SPEC.md` §1, §3, §4, §5. Where the two differ, this document wins for layout and visual style; the spec still wins for behaviour, copy, a11y and alert discipline.

## 1. Licensing: inspiration only, no copied code
- 21st.dev Terms (updated 2026-07-20, https://21st.dev/terms) §2–§3: marketplace content belongs to its authors and 21st Labs; redistribution without authorization and copying without a visible link back are not allowed. The home page line "the code lands in your repo as your code" is not a licence.
- Licences differ per component (some MIT, some "no-license"/"Unknown"). Pulling through the 21st registry also needs an API key and a new network destination.
- **Rule:** no code is copied from 21st.dev. Components are re-implemented on Radix primitives / shadcn/ui patterns (shadcn/ui upstream is MIT). Any third-party source we ever copy keeps its LICENSE in `THIRD_PARTY_NOTICES`.
- Reference components studied (pattern level only): shadcn Sidebar, Origin UI Command + Dropdown Menu, Status Badge, Avatar with initials/group, Combobox with search, Segmented Control, Message Thread, Activity Feed, AI Prompt Composer, Agent tool timeline, Empty states, Sonner toasts.

## 2. What made T-006 look generic
Every region a bordered card with an UPPERCASE title · a top bar full of native `<select>`s · a form of native selects at the top of the conversation pushing the timeline down · cream canvas with grey borders everywhere · sparkle-icon empty state · no avatars · composer = big textarea + two tab buttons.

## 3. Rules
1. **Layout** — nav rail 56 px (icons + tooltips; expands to 220 px with ⌘B) · queue list 360 px · conversation flex · right panel 320 px with tabs **Details / AI / Customer**, collapses with `]`. Panes are separated by a single 1 px hairline: no outer cards, no gaps, no UPPERCASE titles.
2. **Headers** — each pane has its own 48 px header in normal case (queue: view name + count; conversation: key + subject + status/priority pills + actions). The global top bar goes away. Search lives in the queue header, ⌘K in the rail. Theme / Density / Language move into the **user menu** at the bottom of the rail (avatar → dropdown with radio submenus).
3. **Surfaces** — neutral near-white canvas (near-black in dark). Three steps: canvas, raised (hover, customer bubbles), overlay (popover/menu/dialog/toast). Only overlays get a shadow. Ivory `#F7F0D4` is a brand moment only (login, portal header), not the app background.
4. **Colour** — navy `#1D2739` = primary button, focus ring, selected indicator · seafoam darkened = `aiAccent` for AI only · coral stays logo-only; P1 uses the existing `danger`/`sev-p1` reds · everything else greyscale. Colour always means something (severity, SLA, AI) and is never the only signal.
5. **Type** — Inter + Noto Sans Thai, scale 12/13/14/16/20, weights 400/500/600, Thai line-height ≥ 1.5, `tabular-nums` for times/counts/SLA, ticket keys in 12 px mono.
6. **Density** — compact 32 px rows / 28 px controls; comfortable 40 / 32 (existing tokens).
7. **Radius** — 6 controls · 8 composer, bubbles, popovers · 12 dialogs · full pills/avatars.
8. **Icons** — lucide only, 16 px (14 in pills), stroke 1.75. No sparkle icon anywhere; AI = `aiAccent` dot or `Bot` glyph + the word "AI".
9. **Queue row (no card)** — 24 px initials avatar · requester + org, relative time right · one-line subject + muted snippet · meta line: priority pill, status dot, channel icon, SLA countdown. Unread = semibold subject + 6 px navy dot. Hover = raised. Selected = 2 px navy left bar + tint.
10. **Pills** — status: neutral pill, coloured dot + text · priority: existing `SeverityBadge` icon + label, only P1 filled · 20 px high, 12 px/500.
11. **Avatars** — initials on a muted hue hashed from a stable id (8 hues, contrast-tested), 20/24/32 px, never remote images.
12. **Properties** — the form leaves the conversation. Details tab lists label/value rows; each value is an inline trigger that looks like text until hover and opens a Popover + cmdk combobox (search, check mark). Shortcuts per spec §14. Optimistic save with an Undo toast.
13. **Timeline** — customer messages left on raised surface · staff replies on a navy-tinted surface with avatar + name · consecutive messages by the same author within 5 min grouped · hover actions (copy, quote) and exact time in a tooltip · system and AI events are one-line rows (icon, text, time), not bubbles.
14. **Composer** — one bordered box, radius 8: segmented control Reply / Internal note · auto-growing textarea (3–12 rows) · bottom toolbar (template, attach placeholder, AI draft placeholder) and the primary button with the ⌘↵ hint. **Internal note mode keeps UI spec §1**: neutral muted surface, dashed border, lock icon, "Internal note — not sent to the customer", button "Add note" (not amber — amber reads as P3).
15. **Empty states** — one small line icon, one human sentence ("All caught up — nothing waiting in your queue." / "ไม่มีงานค้าง"), one secondary action, a keyboard hint. AI panel before Phase 1: a short plain explanation, no illustration.
16. **Motion** — 120 ms hover/press, 180 ms popover/panel, ease-out, panels slide 8 px with opacity; nothing under `prefers-reduced-motion` (existing `MOTION_TOKENS`).
17. **A11y** — tooltips with kbd hints on every icon button; 2 px navy focus ring offset 2; every new colour pair in `contrast.test.ts`; axe stays clean in light and dark.

## 4. Dependencies
Client-side MIT libraries, no runtime network calls (verify by reading source when adding): `@radix-ui/react-popover`, `react-dropdown-menu`, `react-tooltip`, `react-tabs`, `react-toggle-group`, `react-scroll-area`, `react-separator`, `react-slot`, `cmdk`, `sonner`. Avatars are plain elements (initials only), no `src`.
