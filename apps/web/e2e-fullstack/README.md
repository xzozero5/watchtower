# Full-stack e2e (T-009)

A real browser against the real web, api and worker with Postgres, Redis and Mailpit. Nothing is
mocked (the UI tests in `../e2e/` mock the api; these do not). It covers:

| File                           | Scenarios                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ac1-portal.e2e.ts`            | AC-1, portal path: submit on the portal, ticket with org / intent / SLA due within 10 s (measured), staff assign it to a seeded agent in the Details panel (checked in the UI after a reload, over REST, in the timeline `ticket.assigned` event and in the audit log), confirmation email and tracking link, staff reply in the workspace, customer sees it on the tracking page, internal note never reaches the customer, staff resolve, customer gets the status email |
| `auth.e2e.ts`                  | Magic link end to end (login page, email read from Mailpit's HTTP API, link opened, signed in, link works once, sign out), no email for an unknown address, break-glass staff sign-in                                                                                                                                                                                                                                                                                      |
| `rbac.e2e.ts`                  | A client sees only their own organization (REST and UI), never an internal note, cannot use staff actions; checked for two clients of two organizations                                                                                                                                                                                                                                                                                                                    |
| `ac1-gmail.e2e.ts`             | AC-1 Gmail path and PRD 5.1 with the stack's in-memory Gmail: ticket with org / intent / SLA within 10 s, investigation report with cited KB sections, draft, approve, thread replies, noise in Other mail, merge                                                                                                                                                                                                                                                          |
| `ac2-line.e2e.ts`              | AC-2 and PRD 5.2 with the stack's in-memory LINE: signed webhook, ack by reply token within 5 s, push quota, identity link                                                                                                                                                                                                                                                                                                                                                 |
| `ac3-alerts.e2e.ts`            | AC-3: the same alert fired twice in 5 minutes is one alert with count 2 (a redelivery is not a third fire), not acknowledged within T1 (20 s here) the lead is told in Discord with an Ack button, an unlinked Discord account is refused, a signed button press acknowledges and the open web page shows it within 2 s (measured), the head step is no longer scheduled                                                                                                   |
| `ac5-investigation.e2e.ts`     | AC-5: a `webhook_not_received` ticket, one click on the intent's log template pins one evidence card (mock fixture, personal data redacted), the organization-scoped template finds none of other organizations' lines, and people clicking far past the budget are accepted at most 20 each / 55 together (the rest 429 with Retry-After)                                                                                                                                 |
| `scenario-5-3-incident.e2e.ts` | PRD 5.3: alert -> incident (alert and ticket linked) -> Discord thread (mock, mirrored lines) -> status post draft (agent cannot publish, lead can; subscriber mailed) -> mass update with the recipient count confirmed -> alert closed by the tool, incident closed by a person, page operational                                                                                                                                                                        |
| `ac4-kb.e2e.ts`                | AC-4: an article written by an agent and published by a lead is found by "webhook retry" with a section-level citation; resolving a ticket that cited nothing leaves an AI draft `in_review` within 5 min, which its requester cannot publish and another lead can                                                                                                                                                                                                         |
| `ac7-shifts.e2e.ts`            | AC-7 and PRD 5.4: clock-out blocked by an open P1 without a handoff entry (UI and 409), handoff confirmation, lead sees 1 unacknowledged, incoming agent accepts with the keyboard, lead sees 0; axe on each page                                                                                                                                                                                                                                                          |
| `staff-permissions.e2e.ts`     | Agent, lead and head through the browser: rail links, admin sections, denied pages and the same limits over REST (403)                                                                                                                                                                                                                                                                                                                                                     |

Staff sign in with the break-glass account, never dev login. Customers sign in with the magic link.

## Run it from source (cloud container, CI, or your machine with only the infra up)

```bash
docker compose up -d postgres redis mailpit     # infra only (minio is not needed by these tests)
pnpm test:e2e:fullstack                         # builds first (turbo), then runs the suite
```

`tools/e2e-stack/up.mjs` is started by `e2e-fullstack/global-setup.ts`. It creates a throwaway
database on the compose Postgres (`wt_test_<random>`, migrated, demo-seeded, dropped at the end),
starts api, worker and the web standalone build on `127.0.0.1:4310`, `:4410` and `:3310`, and uses
its own Redis database index (9) and BullMQ prefix. It generates the JWT secret, the encryption key
and the break-glass password at run time and never prints them. Nothing leaves `127.0.0.1`.

In a container with a preinstalled browser add `PW_EXECUTABLE_PATH=/opt/pw-browsers/chromium`
(or `PW_CHANNEL=msedge|chrome`). Set `TURBO_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1` if you want.

Optional environment: `E2E_WEB_PORT`, `E2E_API_PORT`, `E2E_WORKER_PORT`, `E2E_REDIS_URL`,
`E2E_MAILPIT_URL`, `E2E_ADMIN_DATABASE_URL` (a Postgres superuser; default is the compose one).

## Run it against `docker compose up` (the real images)

The tests only need URLs, the break-glass account and Mailpit, so they also run against the full
compose stack:

```bash
# .env (or your shell): a break-glass account and cheap portal checks, then
docker compose up -d --build
pnpm db:migrate && pnpm db:seed                 # the demo organizations the tests use

E2E_STACK=external \
E2E_WEB_URL=http://127.0.0.1:3000 E2E_API_URL=http://127.0.0.1:4000 \
E2E_MAILPIT_URL=http://127.0.0.1:8025 \
E2E_BREAK_GLASS_EMAIL=... E2E_BREAK_GLASS_PASSWORD=... \
pnpm --filter @watchtower/web test:e2e:fullstack
```

Notes for that mode: `BREAK_GLASS_EMAIL` / `BREAK_GLASS_PASSWORD` must be set for the `api`
service, and `APP_URL` / `API_URL` must be the URLs above (the api only accepts its own web
origin). The defaults `PORTAL_POW_DIFFICULTY_BITS=18` and `PORTAL_MIN_FILL_SECONDS=3` work but add a few
seconds to the portal submit; the AC-1 clock starts at the click, after the proof of work.
The suite writes data (tickets, a note, users for two clients): use a dev or demo instance, never
production. It deletes the Mailpit messages it caused.

## In CI (`.github/workflows/ci.yml`, T-014)

The `e2e` job runs both Playwright suites on an `ubuntu-latest` runner, in this order:

1. `pnpm test:e2e` (the UI tests in `../e2e/`, api mocked), then
2. `pnpm test:e2e:fullstack`, from source, exactly as in "Run it from source" above.

Its service containers are the same images as `docker-compose.yml` (`pgvector/pgvector:0.8.7-pg16-trixie`,
`redis:7.4-alpine`, `axllent/mailpit:v1.33.0`) on `127.0.0.1:5432`, `:6379`, `:1025` and `:8025`. MinIO is not
needed. The web build and the api/worker builds come from turbo (`dependsOn` in `turbo.json`).

- Chromium is downloaded in the job with `playwright install --with-deps chromium` (CI-time only; it is not part
  of the product or of any image). Locally keep using `PW_EXECUTABLE_PATH` / `PW_CHANNEL`.
- No repository secret is used. The stack generates its JWT secret, encryption key and break-glass password at
  run time (`tools/e2e-stack/up.mjs`) and never prints them.
- With `CI` set, both configs also write an HTML report (`playwright-report/`, `playwright-report-fullstack/`) and
  the traces go to `test-results*/`. The job uploads them, plus the api/worker/web logs of the stack
  (`E2E_KEEP_LOGS=1`), as the `playwright-<run>-<attempt>` artifact **only when it fails**, kept 7 days. Traces can
  contain the throwaway break-glass password of that run; the stack and its database are gone when the job ends.
- Retries are 1 for `../e2e/` and 0 here (AC-1 measures a time budget). `forbidOnly` is on.
- The same workflow has a `compose` job that builds the images, runs `docker compose up -d --wait` and probes
  `/health` on the published ports. It does not run these tests; to run them against it use the "docker compose up"
  section above.

## Mock integrations the stack provides (T-113, T-207)

Webhook secret of machine alerts, Discord application key pair and LINE channel secret are generated per run
(`tools/e2e-stack/up.mjs`); the tests read them from `E2E_*` variables, never from a file in the repo. The worker's
Discord bot is the in-memory fake wrapped to append every call it would make to `discord-calls.jsonl`
(`discordCalls()` in `support.ts`); a press of a button is posted to the real interactions endpoint, signed with the
private key of the run (`pressDiscordButton`). Linking a Discord account to a staff user is a direct write to the
throwaway database (`linkDiscordAccount`) until the app has a flow for it.

## Stage 3 auto-send (T-306b, ADR-025)

`stage3-autosend.e2e.ts` runs the same file three ways, each in a throwaway stack of its own (the file skips what does not
belong to the way it is run). `AI_AUTOSEND_ENABLED=true` exists only inside the stack of the flag-ON runs; it is never set
on a compose stack, a POC or production.

| Run                 | Environment                                             | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| flag OFF            | `E2E_AI_FAKE_LIVE_FILE=<json>` (no `E2E_AUTOSEND_FLAG`) | `/v1/autonomy` says the flag is off, a promotion request is 409 `autosend_flag_off`, an intent at stage 3 in the database acts as stage 2 (shadow rows with `effective_stage 2`, nothing sent, no `ai_auto` delivery anywhere), a stage 3 intent without shadow mode is not even evaluated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| flag ON             | `E2E_AUTOSEND_FLAG=on E2E_AI_FAKE_LIVE_FILE=<json>`     | boot audit rows of api and worker; the promotion door through the api (head asks, owner approves with a fresh sign-in and the typed key, owner applies); every condition met = `ai_auto` delivery held 120 s, sent in the thread with the footer, labelled in the UI; each failed condition (no replay, customer asks for a person, procedure `never`, procedure `require_human`, grader = drafter, unauthenticated sender, unverified contact) = held, reason in the evaluation and on the timeline, nothing sent; rollback on a policy violation (at once) and on 2 reopened replies among the last 20 (not on 1), `autonomy.rollback` notification to the head; the eval gate (no replay = report not green and the request refused, mock or failing replay does not count, passing replay measured, owner approval needs a session of the last 5 minutes) |
| flag ON, plain mock | `E2E_AUTOSEND_FLAG=on` (no fake file)                   | with `AI_PROVIDER=mock` the grade is flagged `mock` and the gate never lets it clear a send (`grade_mock`), whatever else holds: no `ai_auto` row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

```bash
# from apps/web, infra up (throwaway Postgres/Redis/Mailpit on ports of your own), after `pnpm turbo run build`
echo '{"drafterModel":"drafter-fixture","graderModel":"grader-fixture","score":0.95,"violations":[]}' > /tmp/ai.json
E2E_AI_FAKE_LIVE_FILE=/tmp/ai.json pnpm exec playwright test -c playwright.fullstack.config.ts stage3-autosend            # flag OFF
E2E_AUTOSEND_FLAG=on E2E_AI_FAKE_LIVE_FILE=/tmp/ai.json pnpm exec playwright test -c playwright.fullstack.config.ts stage3-autosend   # flag ON (about 12 minutes: real 120 s holds)
E2E_AUTOSEND_FLAG=on pnpm exec playwright test -c playwright.fullstack.config.ts stage3-autosend                                  # plain mock
```

Why a "fake live" provider: a grade made by a provider of kind `mock` can never clear an automatic send (`grade_mock`, by
design) and the dev mock's drafter cites whatever card comes first. `tools/e2e-stack/worker-runner.mjs` wraps the dev mock as
a provider of kind `anthropic` (no network, the loopback-only guard stays on), lets the grader's model and answer come from
the JSON file, answers the classifier with a confident intent, and has the drafter answer from the scenario's customer-facing
article. The gate, the grader call, `ai_run`/`ai_grade`, the dispatcher and the notification are the real code.

Not covered here (covered in-process, see the header of the spec): the owner's Google step-up itself (a dev stack falls back to
"the session is at most 5 minutes old"), a green gate report made of four weeks of real data (the report row is seeded), a real
grader model, LINE and the portal as channels of an automatic reply.

## Notes

- One worker, serial: the scenarios share one database, and AC-1 measures time.
- Addresses are random per run (`e2e-...@acme-logistics.example.com`), so repeated runs do not collide.
- Locators use roles and the English copy (the browser locale is `en-US`); `data-testid`/`data-*`
  hooks that already exist are used where there is no better handle (`data-ticket-key`, `data-sla`).
- If the stack does not start, the logs of api, worker and web stay in the temp directory printed by
  `[e2e-stack]` (`wt-e2e-stack-*`). Set `E2E_KEEP_LOGS=1` to keep them after a normal run too.
- Findings from these runs are in `docs/qa/bugs.md`.
