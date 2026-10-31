# AI-first workspace (T-128) — design direction

> Owner feedback 2026-11-01 on the T-124 UI: "still feels like a generic mailbox, too much text, not pleasant to use, does not look like an AI-driven workspace".
> Decided by the main thread; amends `docs/design/ui-refresh-2026-11.md` (visual style stays) and `docs/06-UI-SPEC.md` §4–§6 for layout. `[ASSUMED]` until the owner reviews screenshots.

## 1. The shift
| From (mailbox) | To (AI-first workspace) |
|---|---|
| A list of subjects; open one; read the thread; think; type | A list of **situations** the AI already looked at; open one; read the AI's brief; approve, edit or take over |
| The conversation is the page | The **AI brief** is the page; the conversation is evidence, collapsed by default |
| AI is a side panel that may say something | AI work is **visible state** on every row and every ticket: classified → investigating → draft ready → needs you |
| Labels everywhere ("Customer message", "Status", "Assignee") | Icons, pills and position carry meaning; words only where they add information |

Principle: **the agent's first job is to decide, not to read.** Every screen answers, in this order: what is it, how urgent, what did the AI find, what should I do.

## 2. Queue = triage board, not inbox
- Row (2 lines max, no snippet of the raw mail):
  - line 1: AI one-line summary (≤ 80 chars, e.g. "Can't sign in after reset — account locked") · right: SLA countdown pill.
  - line 2: priority pill · intent chip · **AI state chip** (`Draft ready` / `Investigating` / `Needs you` / `Classified`) · org avatar · channel icon. No status words unless not `open`.
  - Fallback when no AI summary: the subject, in muted text.
- Grouping instead of one long list: **Needs you** (draft ready, AI unsure, SLA at risk) · **AI working** · **Waiting** (customer/dev) — collapsible section headers with counts. Saved views stay in the view switcher.
- Density: comfortable 56 px per row (2 lines), compact 40 px (1 line: summary + pills).
- Keyboard: `j/k`, `a` approve draft from the list when the row is "Draft ready" (opens a confirm preview, never sends blind).

## 3. Ticket = AI brief first
Top to bottom in the centre pane:
1. **Header (one line):** key · AI summary as title (subject available on hover/expand) · priority, SLA, status pills · actions (Resolve, ⋯).
2. **AI brief card** (the focal point, `aiSurface`):
   - "What's happening" — 1–2 sentences.
   - "Likely cause / intent" — intent chip + confidence meter (`High 0.86`) + one reason.
   - "Suggested next step" — one primary action button (e.g. *Approve reply*, *Ask for request ID*, *Escalate to dev*), max two secondary.
   - Evidence chips (KB article, similar ticket, log query) with confidence; each opens in the right panel. Uncited claims flagged (`Uncited` tag).
   - Clear provenance: "AI · prompt v3 · 2 min ago" and stage badge (`Stage 2 · Draft for approval`).
3. **Draft reply** (when present) inline under the brief — editable in place; **Approve (A) / Edit (E) / Reject (R)** with reason codes; diff vs. original once edited. Sending still goes through the undo window and the policy gate (N3).
4. **Conversation**, collapsed to the last customer message + "Show 6 earlier"; messages without role labels — avatar + name + time is enough; internal notes keep the dashed style.
5. Composer only when the human takes over (button "Write myself" or `c`), not always open.

Right panel: **Evidence** (default tab when AI has evidence) · **Details** (properties) · **Customer**.

## 4. Less text
- Remove field labels where the value is self-explanatory (status pill, priority pill, avatar = assignee). Keep labels only in the Details tab.
- Remove helper sentences under inputs unless the action is risky (sending to a customer, switches).
- Timestamps relative ("2m"), absolute on hover.
- Empty states: one short line.
- Max line length 72 ch in the brief; bullets over paragraphs.

## 5. Honesty (N5) and safety (N3)
- AI content is always marked as AI (chip + `aiAccent`), with confidence and citations; never presented as fact without a source.
- In mock mode the AI data comes from the deterministic mock provider; the UI never invents AI content itself. If the AI endpoint is unavailable, the brief area shows nothing more than "AI brief unavailable" — no placeholders that look real.
- Phase 1: no auto-send; "Approve" = a human sends (`ai_approved`, bound to the draft by T-122d/T-108).

## 6. Data contract (for the backend tasks)
`GET /v1/tickets/:id/ai` → `{ state: 'none'|'classified'|'investigating'|'draft_ready'|'needs_human'|'failed', summary?, intent?: {key, confidence, reason}, nextStep?: {kind, label}, evidence: {id, kind: 'kb'|'ticket'|'log'|'data'|'repo', title, snippet, confidence, href?}[], draft?: {id, body, citations: string[], uncitedClaims: number, promptVersion, createdAt}, stage, generatedAt }` and list rows carry `ai: {state, summary?}`. Producers: T-106e (classifier + summarizer), T-108 (investigator + drafter). Until they land, the frontend uses this contract with mocked responses in tests/e2e only.
