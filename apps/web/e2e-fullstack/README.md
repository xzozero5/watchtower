# Full-stack e2e (T-009)

A real browser against the real web, api and worker with Postgres, Redis and Mailpit. Nothing is
mocked (the UI tests in `../e2e/` mock the api; these do not). It covers:

| File | Scenarios |
|---|---|
| `ac1-portal.e2e.ts` | AC-1, portal path: submit on the portal, ticket with org / intent / SLA due within 10 s (measured), confirmation email and tracking link, staff reply in the workspace, customer sees it on the tracking page, internal note never reaches the customer, staff resolve, customer gets the status email |
| `auth.e2e.ts` | Magic link end to end (login page, email read from Mailpit's HTTP API, link opened, signed in, link works once, sign out), no email for an unknown address, break-glass staff sign-in |
| `rbac.e2e.ts` | A client sees only their own organization (REST and UI), never an internal note, cannot use staff actions; checked for two clients of two organizations |

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

## Notes

- One worker, serial: the scenarios share one database, and AC-1 measures time.
- Addresses are random per run (`e2e-...@acme-logistics.example.com`), so repeated runs do not collide.
- Locators use roles and the English copy (the browser locale is `en-US`); `data-testid`/`data-*`
  hooks that already exist are used where there is no better handle (`data-ticket-key`, `data-sla`).
- If the stack does not start, the logs of api, worker and web stay in the temp directory printed by
  `[e2e-stack]` (`wt-e2e-stack-*`). Set `E2E_KEEP_LOGS=1` to keep them after a normal run too.
- Findings from these runs are in `docs/qa/bugs.md`.
