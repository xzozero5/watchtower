# Watchtower

Open-source, self-hosted **AI command center for technical support & tech operations teams** — ticketing, omnichannel inbox (Gmail, LINE, portal), alerting & incidents (GCP → Discord), investigation tools (logs, data, git), knowledge base, shift handoff, and an AI layer that pre-investigates every ticket and drafts replies for human approval — with a measured path to full autonomy per intent.

> Status: pre-Phase 0 (planning complete). See `docs/01-PRD.md` for the product spec and `docs/00-START-HERE.md` for how the project is built.

## Quick start (target — Phase 0)
```bash
cp .env.example .env
docker compose up -d
pnpm install && pnpm db:migrate && pnpm db:seed && pnpm dev
```

## Working on this repo with an AI agent
Start with `AGENTS.md` (rules, map of documents) → `HANDOFF.md` (current state). Claude Code users: `CLAUDE.md` + `/status`.

## License
Apache-2.0 (pending owner/company confirmation — see PRD §13).
