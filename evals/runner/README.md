# Eval runner (T-302)

Runs the agents (classifier, drafter, grader, KB author) on cases and reports the pass rate per prompt
version (PRD 6.5 step 3).

```
pnpm eval                                  # mock provider, offline: evals/golden + evals/.replay + the runner's smoke cases
pnpm eval -- --source proposal             # also the cases proposed in evals/proposals (not yet reviewed)
pnpm --filter @watchtower/eval-runner eval -- --all-versions --baseline evals/reports/last.json
pnpm --filter @watchtower/eval-runner replay -- --days 30 --limit 50   # needs DATABASE_URL
```

- **Procedure simulation (T-303d).** `pnpm --filter @watchtower/eval-runner simulate -- --steps evals/runner/simulation/smoke-steps.json`
  runs the steps of a procedure version on made-up cases and tools (`evals/runner/simulation/smoke.json`, runner-owned, not golden)
  with the same engine the worker runs on resolved tickets (`runProcedureSimulation` of `@watchtower/ai`): investigator and drafter
  with the steps and with `--baseline` (default: the default runbook), edit distance to the reply of a person, uncited claims, the
  grader's policy violations, disclosure leaks and steps that never worked. Exit 1 unless it passes (ADR-026 section 6). On the mock
  provider it checks the plumbing and the rules, not the quality of a real model `[UNVERIFIED]`.
- **Providers.** `mock` (default) never opens a socket. `claude-cli` needs `CLAUDE_CLI_BRIDGE_TOKEN`,
  `AI_MODEL_DEEP/STANDARD/LIGHT` and `AI_MODEL_PRICES` in the environment (`[ASK-HUMAN]`), is limited by
  `--max-calls` (default 100) and goes through the same `createAuditedLlm` (redaction, `ai_run` record) as the apps.
- **Cases.** JSON, one case, an array or `{ "cases": [...] }`; schema in `src/case.ts`. A case holds redacted or
  made-up text only (N1, N4). `mockAnswer` is what the mock answers and is ignored by a real provider.
- **`evals/golden/`** is written by people, never by this program (N7). New cases are proposed in `evals/proposals/`
  for a reviewer who did not write them to move.
- **Replay.** `replay` reads resolved tickets, redacts them and writes `evals/.replay/replay.json` (git-ignored). Its
  labels are what the ticket ended with, not an independent judgement `[UNVERIFIED]`.
- **Record (T-306g).** `pnpm --filter @watchtower/eval-runner record -- --intent <key> --as <email> [--dry-run] [--max-calls 100] [--days 90] [--limit 30]`
  replays the combination the gate reads (drafter and grader model aliases from the settings, latest versions of the two prompts, the
  intent's published procedure version via `replaySetFor` of `@watchtower/domain`) on the latest resolved non-seed tickets of the intent
  (redacted by the replay export), runs the redaction eval, and stores the result with `record_replay_result()` as the person of `--as`
  (the database requires `ai.autonomy.promote`). The provider is `AI_PROVIDER` (mock by default): a mock run is stored but can never be
  `passed`. A violation is a drafter or grader case that fails its checks. It prints numbers only, never ticket text. When the call
  budget (`--max-calls`) stops the run nothing is stored (exit 2). Needs `DATABASE_URL` (the application login). Integration test:
  `TEST_DATABASE_URL=... pnpm --filter @watchtower/eval-runner test:integration`. Runbook: `docs/runbooks/pilot-instance.md` 9b.
- **Regression.** `--baseline file.json` compares with an earlier report of the same prompt version; a case that
  passed and now fails exits 1, as does a pass rate under `--min-pass-rate` (default 1).
