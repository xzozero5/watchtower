# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Not merged yet: the AI assistant and AI-written summaries with evidence links (`wip/t-134`), the rest of
the less-text UI pass (T-133).

## [0.1.0] - 2026-11-02 — MVP

First release. Every integration is tested against fakes and fixtures only: none has been connected to a
real Gmail, LINE, Discord, GCP or AI account. See the README section "What is real today".

### Added
- Omnichannel inbox: Gmail (OAuth of one mailbox, or a service account with domain-wide delegation;
  Pub/Sub push, bounded full sync), LINE Messaging API (signed webhook, reply-before-push, quota
  tracking, an automatic acknowledgement from a safe template), the customer portal, and tickets a
  person opens by hand (phone, walk-in, chat). Admin screens and a CLI to connect channel accounts;
  integration credentials stored encrypted, never shown again.
- Outbound delivery through one pipeline with a policy gate and at-most-once sends.
- AI layer (`mock` or `anthropic`): triage, investigation with read-only tools, reply drafts grounded on
  the knowledge base, per-intent autonomy stages 0–2 enforced in the database, an emergency switch and a
  kill switch, PII redaction before any model call, `ai_run` audit with cost, and daily caps.
- Knowledge base with review by someone other than the author, chunking and search (embeddings are
  mock only).
- CSAT, Discord webhook notifications, in-app notifications, shifts, clock-in, handoff with
  acknowledgement and a daily brief.
- Phase 2: alert ingest (GCP Pub/Sub push and signed webhooks), dedup and correlation, a service
  catalog, heartbeats, incidents with mass communication, a status page (off by default), usage metrics
  with anomaly tickets, Client Health Score, and investigation tools (logs, metrics, repo, data) with a
  shared rate budget, read-only.
- Head console (users, orgs, SLA and calendars, intents, queues, audit log, AI controls), an Ops
  dashboard, an outbox screen to resend dead letters, org tiers, a masked `dev` role, one-click
  investigation buttons.
- GCP deployment design (ADR-014), Terraform skeleton and a staging runbook (never applied); a
  credential runbook for the owner.
- E2E with no outbound network for the Gmail and LINE paths (AC-1, AC-2).

### Known issues
- Gmail sends no automatic acknowledgement (B-003); a LINE ticket doesn't show that the sender is
  unverified (B-002); an accessibility issue on the critical banner (B-004). See `docs/qa/bugs.md`.
- The redactor doesn't remove LINE user ids, JWTs or IP addresses in tool output, and a name it doesn't
  know can reach the model.
- No e2e yet for AC-3, AC-4, AC-5, AC-7; the Phase 1 and Phase 2 security and QA passes (T-114, T-207)
  are not done.

## [0.0.1] - never tagged

Phase 0 — Foundation. Rolled into 0.1.0.
