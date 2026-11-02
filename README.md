<p align="center"><img src="docs/brand/watchtower-logo.png" alt="Watchtower" width="240"></p>

# Watchtower

Open-source, self-hosted **AI command center for technical support and tech operations teams**: ticketing, an omnichannel inbox (Gmail, LINE, customer portal), alerts and incidents, read-only investigation tools, a knowledge base, shift handoff, and an AI layer that pre-investigates tickets and drafts replies for a person to approve.

> **Status: MVP (`v0.1.0`), not production-proven.** Every test ran against mocks and fixtures. No integration has been connected to a real Gmail, LINE, Discord, GCP or AI account yet, so expect the first real connection to find problems. See [What is real today](#what-is-real-today).

## Try it in five minutes (no accounts needed)

You need Docker with Compose, plus Node and pnpm for the demo data. Nothing leaves your machine: mail goes to Mailpit and the AI is a deterministic mock.

```bash
cp .env.example .env
docker compose up -d --wait --build
pnpm install
pnpm db:seed
```

| Open | For |
|---|---|
| http://localhost:3000 | The app. Choose a role on the login page (dev login) |
| http://localhost:3000/portal | The customer portal |
| http://localhost:8025 | Mailpit: mail the system "sent" |
| http://localhost:4000/docs | OpenAPI |

Stop with `docker compose down`, and add `-v` to delete the data too.

## Running with real accounts

Follow [`docs/runbooks/credentials.md`](docs/runbooks/credentials.md), which lists each credential, who can create it and how. Keep your env file outside the repo and start with `docker compose --env-file <path> up -d --wait --build`. To deploy on GCP: [`docs/runbooks/staging-gcp.md`](docs/runbooks/staging-gcp.md) and [ADR-014](docs/decisions/ADR-014-gcp-deployment.md).

Before you connect anything real:

- **Use a test mailbox and a test LINE Official Account first.** A connected LINE account acknowledges each new conversation automatically, with a safe template and no person involved. Replies a person approves go to whoever wrote in.
- **Connecting Gmail imports the last 7 days**, up to 500 messages (`GMAIL_FULL_SYNC_DAYS`, `GMAIL_FULL_SYNC_MAX_MESSAGES`). With a real AI provider, each one costs money until the daily cap stops it.
- **Gmail push and LINE webhooks need a public HTTPS address.** On `localhost`, sign-in, the Gmail connection, AI, Discord and SMTP can work, but new mail and LINE messages won't arrive by themselves.
- **The AI never answers customers on its own.** Every intent stays at autonomy stage 2 or lower (draft for approval), enforced in the database.
- **Personal data is redacted before it reaches a model, as far as patterns and known names allow.** A name typed into free text that the system doesn't know can get through. Decide whether you accept that before turning on a real provider.

## What is real today

| Area | State |
|---|---|
| Tickets, queues, SLA and business calendars, RBAC, audit log, realtime workspace, TH/EN, light/dark, PWA | Built, tested with real Postgres and Redis |
| Customer portal, tracking links, CSAT, manual tickets, masked `dev` role | Built, tested |
| Gmail (OAuth or delegation), LINE Messaging API, Discord webhook, SMTP | Code complete, tested against fakes, **never run against the real service** |
| AI: triage, investigation, drafts, grounded on the knowledge base (`mock` or `anthropic`) | Tested on the mock. **The Anthropic path has never made a real call** |
| Knowledge base | Works, but search uses mock embeddings, so it isn't semantic search yet |
| Alerts, incidents, status page (off by default), usage metrics, Client Health Score | Built, tested with simulated input |
| Investigation tools (logs, metrics, repo, data) | Read-only. Logs, metrics and repo read fixtures; data can read a database you point it at |
| Ops dashboard, head console, shifts and handoff | Built, tested |

**Not in this release:** the AI assistant bubble and AI-written briefs with evidence links (backend only, on branch `wip/t-134`, with its last security fixes not yet re-reviewed), real embeddings, Vertex AI, LINE Login, Web Push, autonomy stage 3 and everything else in Phase 3.

## Develop

```bash
pnpm install
docker compose up -d --wait postgres redis minio minio-init mailpit
pnpm db:migrate && pnpm db:seed
pnpm dev
pnpm lint && pnpm typecheck && pnpm test
pnpm test:e2e
```

TypeScript monorepo (pnpm + Turborepo): `apps/web` (Next.js), `apps/api` (NestJS), `apps/worker` (BullMQ), `packages/db` (Drizzle, Postgres 16 + pgvector), `packages/ai`, `packages/channels`, `packages/connectors`, `packages/domain`, `packages/shared`, `packages/ui`.

## Documentation

- [`docs/01-PRD.md`](docs/01-PRD.md): the product spec
- [`docs/decisions/`](docs/decisions/README.md): architecture decisions
- [`docs/09-SECURITY.md`](docs/09-SECURITY.md): security checklist
- [`CHANGELOG.md`](CHANGELOG.md): what changed

## Working on this repo with an AI agent

Start with [`AGENTS.md`](AGENTS.md) (rules and a map of the documents), then [`HANDOFF.md`](HANDOFF.md) (current state). Claude Code users: `CLAUDE.md` and `/status`.

## License

Apache-2.0.
