# Friendly polish (T-129) — design direction

> Owner feedback 2026-11-01 on T-127/T-128: "better, but reduce the text on buttons; make it more pleasant and a bit cuter; rounder; use colour and symbols to help".
> Builds on `docs/design/ui-refresh-2026-11.md` and `docs/design/ai-first-workspace.md` (layout stays). `[ASSUMED]` until the owner sees screenshots.

## 1. Buttons: icon first, words only where they decide something
| Kind | Rule |
|---|---|
| Frequent, obvious actions (copy, refresh, collapse, filter, more, close, quote, open source, tabs with icons) | **Icon-only** round button (32 px, 36 px touch) + tooltip with label and shortcut + `aria-label`. |
| The one primary action of a surface (Approve reply, Send, Resolve) | Icon + **one or two words** (`✓ Approve`, `➤ Send`, `✓ Resolve`). Never sentences. |
| Risky actions (switches, delete, sign out everywhere) | Keep the words; confirm dialog stays. |
| Keyboard hints | Shown in tooltips, not inside buttons (remove "Ctrl ↵" chips from buttons; keep one subtle hint line in the composer footer). |
| Segmented controls | Icon + short word (`💬 Reply` / `🔒 Note`) using lucide icons, not emoji. |

## 2. Rounder, softer
- Radius scale: controls **10 px**, cards/brief/draft/popovers **16 px**, dialogs **20 px**, pills/avatars/icon buttons **full**.
- Cards: soft tinted backgrounds instead of borders where possible (`surface-raised` + 1 px hairline at 40 % opacity); subtle shadow only on overlays and the AI brief.
- Spacing: a little more air inside cards (16 → 20 px), row height unchanged for density.

## 3. Colour with meaning (and a bit of joy)
- **Soft tinted chips** (12 % tint background + full-colour icon + dark text) instead of outlined pills:
  - priority: P1 red (only P1 strong), P2 amber, P3 sky, P4 slate;
  - SLA: ok = green, at risk = amber, breached = red, paused = slate (icon: clock / hourglass / alert / pause);
  - AI state: draft ready = seafoam/teal ✨-free sparkle-less icon (`pen-line`), investigating = violet (`search`), needs you = amber (`hand`), classified = teal (`tag`), failed = slate (`circle-off`);
  - channel: email = blue (`mail`), LINE = green (`message-circle`), portal = indigo (`globe`), Discord = purple (`hash`).
- **Intent chips**: a stable colour per intent (hashed into 8 friendly hues) with a small icon per intent family (`key-round` login/access, `webhook`, `file-text` billing/report, `timer` timeout, `circle-help` question, `settings` config, `alert-triangle` incident, `scale` dispute).
- **Avatars**: initials on soft pastel circles (existing 8 hues), with a 2 px ring in the canvas colour.
- **Section headers** on the triage board get a coloured dot + icon (`hand` Needs you amber, `sparkles`-free `bot` AI working teal, `hourglass` Waiting slate, `check-circle` Done green).
- Red stays reserved for P1/breach (alert discipline). Coral stays logo-only. Every colour still has an icon or word (WCAG: colour is never the only signal); every new pair goes into `contrast.test.ts` (light + dark).

## 4. Cuter, without being childish
- Friendly empty states: a small line illustration made of lucide icons in a soft tinted circle (e.g. `coffee` for "All caught up", `inbox` for empty view), one short line, one action.
- Micro-interactions (respect reduced motion): button press scale 0.97, chip hover lift 1 px, approve success = brief check-mark pop + toast; queue row selected = soft tinted pill background instead of a hard left bar.
- Toasts: rounded, icon on the left, max one line.
- AI brief: rounded card with a subtle teal gradient edge on the left (4 px), confidence shown as a small segmented bar (5 dots) + number on hover.
- Typography: keep Inter + Noto Sans Thai; titles 600, everything else 400/500; no ALL CAPS anywhere.

## 5. Text budget
- Buttons: ≤ 2 words. Chips: ≤ 2 words or icon + number. Tooltips carry the rest.
- Remove remaining helper sentences except on risky actions.
- Numbers over words on `/home` tiles (big number, 1–2 word label, icon).
