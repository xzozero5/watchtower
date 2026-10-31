# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Phase 1 scaffolding: per-feature files in `packages/shared`, api modules, worker processor
  registry, Phase 1 environment variables (empty = mock mode), a test network guard, and the
  Phase 1 permission set (migration `0006`).

## [0.0.1] - unreleased (pending owner verification on a local machine; not tagged yet)

Phase 0 — Foundation.

### Added
- Monorepo (pnpm + Turborepo) with enforced module boundaries (ADR-002).
- `apps/api` (NestJS): health, Zod-validated config, OpenAPI at `/docs`, structured logging,
  OpenTelemetry hooks.
- Authentication: Google OIDC with PKCE (mock mode for development), magic links for customers,
  break-glass local admin; rotating refresh tokens, CSRF protection, `__Host-` cookies (ADR-005).
- RBAC deny-by-default with a permission table, and an append-only, partitioned audit log.
- Ticket core: organizations, contacts, SLA policies with business calendars, intents (examples in
  `examples/intents/`), tickets, messages and events; status workflow, SLA due dates with pauses,
  manual and round-robin assignment, simple merge, duplicate suggestions, trigram search for Thai
  and English text, REST API and WebSocket realtime events scoped per organization.
- Transactional outbox with a relay in the worker (ADR-006); secret fields encrypted at rest.
- Client portal: submit form with self-hosted human verification (proof-of-work, honeypot, rate
  limits; ADR-007), tracking links, replies, and customer emails through SMTP.
- Web app (Next.js): three-pane workspace with nav rail, inline ticket properties, timeline,
  composer, keyboard map and shortcuts (can be turned off), realtime queue, login, PWA shell,
  TH/EN, light/dark themes; portal pages.
- Demo seed (`pnpm db:seed`) with fictional organizations, staff, SLA policies and 30 tickets.
- Docker Compose stack (Postgres + pgvector, Redis, MinIO, Mailpit, api, worker, web, Caddy).
- Tests: unit, integration against real Postgres/Redis, Playwright e2e with a mocked API, and a
  full-stack e2e of the portal path (AC-1), magic link and RBAC.
- GitHub Actions CI: lint, typecheck, unit, integration, e2e, full-stack e2e, and Compose
  build/up/health.

### Security
- Phase 0 security review (T-010) findings C-1…C-16 fixed; see `docs/09-SECURITY.md`.
