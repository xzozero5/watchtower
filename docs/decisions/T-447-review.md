# T-447 Independent QA & Security Review — Birdday Cockatiel Persona, Claude-Style Chat UX & Lively Skeletons

- **Date:** 2026-11-09 (Asia/Bangkok)
- **Branch:** `feat/birdday-lively-ui`
- **Reviewers (N7, Read-Only):**
  - `security-reviewer` (`0ea6fef5`): **PASS (`P0=0, P1=0, P2=0, P3=0`)** `[CONFIRMED]`
  - `qa-engineer` (`758d9644`): **PASS (`P0=0, P1=0, P2=0, P3=0`)** `[TESTED]`

## 1. Security & Invariant Audit (`0ea6fef5`)
1. **N1 (Neutral Open-Source Mascot & Zero Secrets):** `Birdday` (cockatiel AI mascot) and all TH/EN copy are 100% organization-neutral open-source assets; zero secrets, external runtime fetches, or internal company references.
2. **ADR-023 / ADR-029 / ADR-034 Streaming & Citation Invariants:**
   - `useAssistantChat` records `phaseHistory` strictly from validated SSE phase events (`queued`, `context`, `tool`, `answering`) without exposing raw unredacted or uncited LLM tokens prior to server-side redaction/citation verification.
   - `ClaimLine` citation rendering, `hadCustomerContent` prompt-injection warning on `ProposalCard`, `<AssistantPanelForUser key={userId}>` cross-user isolation, and `isAssistantWorkspace && can('assistant.use')` RBAC gates remain intact.
3. **XSS / SVG Safety & Alert Discipline (`brand.test.ts`):**
   - Zero `dangerouslySetInnerHTML` or unvalidated markup construction.
   - `BirddayIcon` and `BirddayAvatar` strictly exclude Brand Coral (`#e5594a`, reserved from UI tokens to preserve P1 severity alert discipline), using warm golden crest (`#fbbf24` / `#f59e0b`), pearl-slate wings (`#cbd5e1` / `#94a3b8`), and apricot cheek (`#fb923c`).

## 2. QA, Accessibility & E2E Audit (`758d9644`)
1. **WCAG 2.x AA & Valid HTML:**
   - Valid `<ul> > <li>` DOM hierarchy preserved across starter prompts, `ClaimLine` items, and tool steps.
   - Decorative `<Skeleton />`, `<BirddayIcon />`, `<BirddayAvatar />`, elapsed timer (`elapsedSec`), and past step checkmarks carry `aria-hidden`, keeping `role="log"` and `role="status"` announcements clean.
   - `focus-visible:outline-solid focus-visible:outline-2` (`T-443`) preserved on auto-growing `<textarea>` and new panel controls.
2. **Reduced Motion (`prefers-reduced-motion: reduce`):**
   - `--wt-motion-duration-*` (including `--wt-motion-duration-shimmer`) drops to `0ms` under reduced motion (`tokens.css`), and all infinite keyframes (`animate-shimmer`, `animate-bird-*`, `animate-crest-wiggle`) are gated behind `motion-safe:`.
3. **Automated Test Execution (`[TESTED]`):**
   - `@watchtower/ui`: `16/16` files (`815/815` tests, including `contrast.test.ts` 663/663, `brand.test.ts` 9/9, `css.test.ts` 20/20, `birdday.test.tsx` 3/3, `skeleton.test.tsx` 3/3).
   - `@watchtower/web` unit: `156/156` files (`1,807/1,807` tests).
   - Playwright E2E (`PW_CHANNEL=msedge`): `assistant-t410-gate.e2e.ts`, `assistant-stream.e2e.ts`, `element-insight-axe.e2e.ts`, `assistant-routes.e2e.ts`, `assistant-library.e2e.ts` — **`52/52` passed (`0` `axe` violations in both Light and Dark mode)**.

