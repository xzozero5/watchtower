# @watchtower/db

Drizzle schema, the migration runner, the transactional outbox (ADR-006) and the development seed.
Postgres 16 with `pgvector`. The package knows Postgres only: no HTTP, no Redis (docs/04-ARCHITECTURE.md section 3).

## Migrations

```bash
pnpm db:migrate     # apply pending migrations (as the schema owner), then create the app login role
pnpm db:rollback    # revert the newest migration (every migration has a .down.sql)
pnpm db:status
```

SQL lives in `migrations/NNNN_name.sql` with a matching `.down.sql`. A migration that has been
applied is checksummed: never edit it, add the next number. `MIGRATION_DATABASE_URL` (or
`DATABASE_URL`) must be the schema owner.

## Seed: development and demo data (T-008)

```bash
pnpm db:migrate
pnpm db:seed                                  # from the repository root
pnpm --filter @watchtower/db db:seed -- --examples /path/to/examples
```

What it loads, all neutral and fictional (N1: `example.com/.org/.net`, invented company names,
people named "Demo"):

| Part | Content | Source |
|---|---|---|
| Business calendars | `Bangkok office hours` (Mon-Fri 09:00-18:00, `Asia/Bangkok`, Thai public holidays 2026-2027) and `24x7` | `examples/calendars/` |
| SLA policies | Gold, Silver, Standard (PO decision 8, `[ASSUMED]`) | `examples/sla/` |
| Intents | the 11 starter intents, autonomy stage 2 (N3) | `examples/intents/` |
| Organizations | Acme Logistics (gold), Borealis Foods (silver), Cedar Retail (standard), 2-3 contacts and a portal client user each | `src/seed/demo-data.ts` |
| Staff | 2 heads, 2 leads, 4 agents (`*@example.com`), team queues Support, Integrations, Billing | `src/seed/demo-data.ts` |
| Tickets | 30, in every status (new, triage, open, waiting on customer with a paused SLA clock, waiting on dev, resolved, closed, merged), Thai and English, public replies and internal notes | `src/seed/demo-data.ts` |

Tickets are played the way the API would work them: events, audit rows, the SLA pause and resume and
the due dates all follow the same rules (`src/seed/tickets.ts`; the integration test recomputes every
due date with `computeSlaDueDates`). Rows are dated backwards from the moment you run the seed,
never before the oldest monthly partition of `ticket_event` / `audit_log`.

**The holidays are `[VERIFY]` example data.** `examples/calendars/th-public-holidays-2026-2027.json`
was not read from the official Cabinet announcement; lunar-calendar dates and substitution days are
`[UNVERIFIED]`. Check them against the source named in the file before they drive a real SLA.

Rules:

- **Idempotent and additive.** Run it as often as you like: a second run creates nothing. Rows are
  found by a natural key (user and contact address, organization/queue/calendar/policy name, the
  `seed-demo-NN` provider id of a ticket's first message) and an existing row is never overwritten,
  so edits made since survive. One transaction: a failure leaves the database as it was. Every
  example file is read and validated before the first write.
- **Refuses `NODE_ENV=production`** unless you pass `--allow-production` (for example a staging
  copy). A production instance starts empty; its admin enters the real holidays and policies.
- **Writes only to the database.** No email, LINE, Discord, Gmail or GCP call is made.
- **Which role:** `MIGRATION_DATABASE_URL`, else `DATABASE_URL` (the restricted application role
  works too).
- **Examples path:** defaults to the repository's `examples/`. The api image does not ship
  `examples/`, so inside a container pass `--examples <dir>` or set `SEED_EXAMPLES_DIR`
  (a directory with `intents/`, `calendars/` and `sla/`).
- `TICKET_KEY_PREFIX` (default `OPS`) is used for the ticket keys written into merge events.

Sign-in: the seeded staff and client users exist so that mock-mode dev login and the portal have
people to work with. A real deployment replaces them with its own users.

## Outbox

`enqueueOutbox(tx, job)` writes a row in the caller's transaction; `relayOutbox(db, publish)` moves
due rows through a publisher the caller supplies (the worker's BullMQ adapter). See
`docs/decisions/ADR-006-outbox.md`.

## Tests

```bash
pnpm --filter @watchtower/db test               # unit: seed validation and the ticket planner
pnpm --filter @watchtower/db test:integration   # needs docker compose postgres
```
