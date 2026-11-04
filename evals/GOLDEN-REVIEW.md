# Golden set review (T-302b)

Move to `evals/golden/README.md` (the write hook blocked the QA agent from writing it there).

Reviewed by a QA engineer who did not write the AI agents (N7). Run:
`node evals/runner/dist/cli.js run --source golden` (build the runner and its dependencies first:
`pnpm --filter "@watchtower/eval-runner..." build`). Schema: `evals/runner/src/case.ts`.

| File | Cases | What it covers |
|---|---|---|
| `classifier.json` | 19 | all 11 `examples/intents/*` (TH and EN), vague message (null + `triage`), two intents fit, advertisement (`noise`), prompt injection, no-intent (null) |
| `drafter.json` | 13 | citation, restricted contact (internal log, root cause, account claim without evidence, internal link, usage number, account enumeration), internal note never repeated, language TH/EN, no promise without evidence |
| `grader.json` | 15 | verified (customer text, CSAT), contained, assumed, cap (model says verified, nobody confirmed), CSAT contradicts model, denial in text, violations (disclosure, tone, promise, unsupported claim), draft matches/differs, kbGap cleared when an article was cited, injection |
| `kb_author.json` | 6 | no PII (name, email, phone), no internal link, too little to write (no article), invented tag dropped, no invented steps |

## What "pass on mock" means

On the mock provider `mockAnswer` is what the "model" says, so a mock pass proves two things only:
the harness works, and the agent's own code guards (disclosure filter, resolution cap, tag filter,
placeholder check) hold. It does not measure a model. The `expect` rules are invariants (must-not-contain,
class ceilings, violation counts, language) so a real provider is judged by the same rules. Cases whose
`mockAnswer` is deliberately wrong (`gold-grader-cap-unconfirmed-verified`, `gold-grader-csat-contradicts-model`,
the restricted drafter cases) test the code guard. Real-provider results: not run `[UNVERIFIED]`
(`[ASK-HUMAN]` for keys).

Content is made up: fictional people (Somchai, Dana, Company X), `*.invalid` / `*.example` hosts, a
fake phone number. No company, customer or internal procedure (N1).

## Review of `evals/proposals/phase3-initial.json` (9 cases)

All 9 moved (ids `prop-*` renamed `gold-*`, the PROPOSAL wording removed, the proposals file deleted).
None rejected. Notes:

- `classifier-th-password`, `classifier-en-outage`, `classifier-no-intent`: correct. They use their own
  three-intent list (fine, the app never hard-codes keys); the new cases use the `examples/intents` set.
- `drafter-th-cited`, `drafter-restricted-no-internal`: correct; the second fails if the filter lets an
  internal log line through.
- `grader-contained`, `grader-promise-violation`: correct; fact ids (`f2` = staff reply) checked against `buildGradeFacts`.
- `grader-customer-denies`: correct, but it is caught by the CSAT (`resolved: false`), not by the words (finding 2).
- `kb-author-no-customer-detail`: kept; the check word `twice` is a weak PII test, the real one is `gold-kb-author-no-pii`.

## Limits and findings

1. The runner cannot assert a maximum confidence, so "ambiguous: confidence must stay low" is not
   enforceable (`gold-classifier-ambiguous-two-intents` checks the key only).
2. `capResolutionClass` stops `verified` when the CSAT says not resolved, but a customer who says "still
   broken" in the ticket with no CSAT is caught only if the model says so (a cited customer message after
   the reply counts as confirmation). `gold-grader-denial-in-text-only` guards this on a real model.
3. A mock pass is not evidence of quality. Real-provider numbers: not run.
