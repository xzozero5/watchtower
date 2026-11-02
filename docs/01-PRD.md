# PRD — Tech Ops AI Command Center (codename: **Watchtower**)

| | |
|---|---|
| Version | 0.1 (draft for build kickoff) |
| Date | 2026-10-31 (Asia/Bangkok) |
| Owner | Project owner (product owner and final decision maker) |
| Status | Ready for Phase 0 implementation |
| License target | Apache-2.0 (open source) — see §13 |
| Audience | The AI coding session(s) that will build this, and future contributors |

> **How to read this document.** Statements are tagged where it matters:
> **[CONFIRMED]** = decided by the owner or verified against official docs.
> **[ASSUMED]** = reasonable default; verify with the owner before it becomes irreversible.
> **[VERIFY]** = fact taken from third-party sources during research; confirm against the official source before relying on it.
> Anything untagged in the requirements sections is a product decision by the owner.

---

## 0. Executive summary

Watchtower is built for B2B API/SaaS companies, including those serving regulated businesses. A typical Tech Operations team (support agents on shifts, a support lead, and the Head of Tech Ops) handles customer issues arriving by **email (Gmail)** and **LINE Official Account**, watches **GCP** for problems, investigates using **logs, database queries and the code repository**, and coordinates over **Discord**.

Today this work is spread across many tools. Watchtower is a single, self-hosted, open-source **command center** that:

1. Turns every inbound signal (email, LINE message, portal submission, GCP alert, usage anomaly) into a **ticket or incident** with an owner and an SLA.
2. Runs an **AI pre-investigation** on each ticket — searching the knowledge base, querying logs and data, and correlating recent deploys — and drafts a reply **for a human to approve**.
3. Runs the team's **shifts**, generates **daily briefs**, and enforces a **structured handoff** between shifts.
4. Gives the Head of Tech Ops an **ops dashboard** and a **CEO-ready weekly view**, including **product-usage health per customer**.
5. **Learns** from every human edit, grades its own work, and grows its knowledge base — so that autonomy can be raised **per intent** from "draft for approval" to "fully autonomous", with the explicit long-term goal of **100% AI-handled customer support**.

Phase 1 is a **web application** (PWA-capable). A **mobile app** follows once the API is stable (§12).

---

## 1. Goals, non-goals, success criteria

### 1.1 Goals
- **G1 — One pane of glass.** An agent on shift never needs to open Gmail, LINE OA Manager, GCP console, BigQuery console, GitHub or Discord to handle a routine ticket.
- **G2 — AI does the first 80% of every ticket** (classification, investigation, draft) from day one; humans do the last 20% (judgment, approval).
- **G3 — Measurable path to autonomy.** Every intent has an autonomy stage, and the data to justify raising it (§6).
- **G4 — Nothing is lost between shifts.** Structured handoff with acknowledgment.
- **G5 — Customer-visible professionalism.** Public ticket portal, status page, CSAT loop.
- **G6 — Enterprise-grade from the start**: RBAC, audit log, PII handling, backup — so it can run inside ISO 27001 certified organizations that handle sensitive personal data.
- **G7 — Open source and self-hostable** via Docker Compose.

### 1.2 Non-goals (Phase 1–2)
- Not a general CRM or sales tool.
- No website chat widget, Slack, phone/IVR channels (channel architecture must allow adding them later).
- Not a replacement for GCP Monitoring/Logging itself — we consume them.
- Not forking Chatwoot/Zammad. We build new and borrow patterns (§14).
- Native mobile apps are out of scope until Phase 4.

### 1.3 Success criteria (first 90 days after go-live) [ASSUMED targets — owner to set]
| Metric | Target |
|---|---|
| Tickets auto-created from email/LINE without manual entry | ≥ 95% |
| Tickets with an AI investigation report attached within 2 min | ≥ 90% |
| AI draft acceptance rate (sent with ≤ 20% edit) | ≥ 60% by day 90 |
| First-response SLA compliance | ≥ 95% |
| Shift handoffs with 100% pending-item acknowledgment | 100% |
| Agents using the command center for all ticket work (no side tools) | 100% |

---

## 2. Users, roles, permissions

### 2.1 Personas
| Role | Who | Needs |
|---|---|---|
| **Head of Tech Ops** (`head`) | Owner of this product; reports to CTO | Whole-picture view, stats, user & integration management, everything other roles can do and more, a personal AI assistant, a weekly CEO report |
| **Support Lead** (`lead`) | Runs the agent team | Everything an agent can do + roster management, per-agent performance, approving KB articles, raising/lowering AI autonomy within limits |
| **Support Agent** (`agent`) | Works shifts | Clock in/out, daily brief, handle queue, review AI drafts, read LINE/email/alerts/system status, leave notes for the next shift |
| **Developer** (`dev`) | Engineers who fix what support escalates (T-137) | See every ticket with personal data masked, take a ticket handed to dev (`waiting_on_dev`), write internal notes, link an incident or deploy, run the read-only investigation; never talk to the customer |
| **Client user** (`client`) | Employee of a customer organization | Submit tickets via public link, get email updates, track status, see their org's tickets, subscribe to the status page |
| **System / AI** (`system`) | Automations and AI agents | Act with scoped, auditable service identities |

### 2.2 Permission matrix (summary)
| Capability | agent | lead | head | dev | client |
|---|---|---|---|---|---|
| View/handle tickets in own queue | ✔ | ✔ | ✔ | ✘ | own org only |
| View all tickets | ✔ | ✔ | ✔ | ✔ masked | ✘ |
| Reply to customer (email/LINE/portal) | ✔ | ✔ | ✔ | ✘ | reply on own ticket |
| Write internal notes | ✔ | ✔ | ✔ | ✔ (read and write masked) | ✘ |
| Approve/edit/reject AI drafts | ✔ | ✔ | ✔ | ✘ | ✘ |
| Run investigation tools (read-only) | ✔ | ✔ | ✔ | ✔ (templates only, no ad-hoc query) | ✘ |
| Create/close incidents, status page posts | ✔ (create) | ✔ | ✔ | ✘ (may link a ticket to an incident or deploy) | ✘ |
| File a ticket by hand (phone, walk-in, chat) | ✔ | ✔ | ✔ | ✘ | ✘ |
| Move a ticket between `open` and `waiting_on_dev` | ✔ (to `waiting_on_dev` needs a note) | ✔ | ✔ | ✔ (only these two; back to `open` needs a note) | ✘ |
| Pick a ticket up as dev owner | ✘ | ✘ | ✘ | ✔ (self only) | ✘ |
| Clock in/out, write handoff | ✔ | ✔ | ✔ | ✘ | ✘ |
| Manage roster, shift swaps | ✘ | ✔ | ✔ | ✘ | ✘ |
| View per-agent performance | own | ✔ | ✔ | ✘ | ✘ |
| Approve KB articles | ✘ | ✔ | ✔ | ✘ | ✘ |
| Change AI autonomy stage per intent | ✘ | up to stage 3 | all | ✘ | ✘ |
| Manage integrations, AI provider, API keys | ✘ | ✘ | ✔ | ✘ | ✘ |
| Manage users/orgs/SLA policies | ✘ | orgs/contacts | ✔ | ✘ | ✘ |
| View audit log | ✘ | ✘ | ✔ | ✘ | ✘ |
| CEO view / exports | ✘ | ✔ | ✔ | ✘ | ✘ |

Implementation: RBAC with roles above plus fine-grained permission strings (`ticket.read`, `ticket.reply`, `ai.autonomy.set`, …) so roles can be adjusted without code changes. **[CONFIRMED]** Five human roles (agent, lead, head, developer, client; `system` is the sixth identity, not a person); **[ASSUMED]** exact matrix above.

**The `dev` role (T-137, `po` decision [ASSUMED]).** A developer holds `ticket.read.masked`, not `ticket.read`: every route that returns a ticket answers a developer with email and phone masked, names reduced to initials, and message text, subjects, AI brief and evidence passed through the same redactor that runs before the LLM (N4); custom fields and attachment names are left out and text search is refused (a ticket number works), so the hidden data cannot be found by guessing. The realtime feed gives a developer the ticket key instead of the subject. A route a developer can reach but that has no masked output answers 403 (a test walks every route and fails when a new one becomes reachable). A developer never replies to a customer and never approves an AI draft (N3). An agent hands a ticket to dev with `waiting_on_dev` and a mandatory note; the queue and the assignee stay with the agent (AC-7); a developer picks it up for themselves in `dev_owner_id` and hands it back with a note. The customer sees "In progress" for `open` and `waiting_on_dev` alike and is told nothing of the move. `dev` is not a staff role for routing: tickets are never assigned to a developer and a developer has no shift, handoff or on-call duty.

**Tickets filed by hand (T-136).** An agent, lead or head can file a ticket for a request that arrived by phone, in person or in a chat that is not connected (`phone`, `walk_in`, `chat`, `other`). It needs an organization, a contact (an existing one, or a new one that is created unverified), a subject, what was said and the channel; the SLA clock starts when it is filed, never earlier. `internal` is only for a ticket with no customer. The customer gets the automatic "we received your request" email by default when the contact already existed; for an address that is new here the person must tick the box. These channels have no outbound adapter, so a public reply on them is refused with `channel_no_outbound` [ASSUMED]: what was said on the phone is recorded as an internal note. No satisfaction survey is owed for them [ASSUMED].

### 2.3 Authentication
- Staff: **Google Workspace SSO (OIDC)** restricted to the company domain, plus break-glass local admin. [ASSUMED — company uses Google Workspace since Gmail is the mail system]
- Clients: **email magic link** and/or **LINE Login**; a client user belongs to exactly one `organization`. Org membership is established by invitation from staff or by verified email domain allow-list.
- All sessions: short-lived JWT + refresh, device list, forced logout by head.

---

## 3. Domain context (reference deployment)

Watchtower is domain-neutral. Examples, intents and queries assume a generic B2B API platform; a deployment replaces them with its own in the instance DB, never in this repo (§13).

- Customers integrate via API/SDK/webhooks; many run production flows end-users depend on in real time → **latency and failure spikes are customer-visible within minutes**.
- Deployments may handle sensitive personal data under ISO 27001 and PDPA → PII rules in §8.2 are non-negotiable.

### 3.1 Starter intent taxonomy [ASSUMED — each deployment refines it after its first 2 weeks of real tickets]
| Intent key | Description | Typical evidence needed |
|---|---|---|
| `processing_failure` | End-users failing a core processing step | logs for session IDs, failure rate per org vs baseline, recent deploys |
| `upstream_timeout` | Third-party dependency timeouts or mismatches | upstream latency metrics, vendor status |
| `webhook_not_received` | Client did not receive callback | webhook delivery logs, retries, client endpoint responses |
| `api_error` | 4xx/5xx from the product API | error logs by org/API key, deploy correlation |
| `workspace_config` | Product configuration question/bug | configuration version history |
| `result_dispute` | Customer disputes an automated result | decision logs, rule or data version |
| `account_access` | Dashboard login, user management, API keys | auth logs |
| `billing_report` | Usage report / invoice questions | usage query |
| `feature_question` | How-to / documentation | KB |
| `incident_inquiry` | "Is something down?" | open incidents |
| `other` | Fallback → human triage | — |

Each intent carries: default priority, SLA policy, investigation runbook, allowed tools, autonomy stage, reply templates.

---

## 4. Functional requirements

Each module lists requirements (**R-x.y**) and key acceptance criteria (**AC**). Priorities: **P0** = Phase 1 must-have, **P1** = Phase 2, **P2** = later.

### 4.1 Ticketing core (P0)

- **R-1.1** Ticket has: id (`OPS-1234`), subject, org, requester contact, channel of origin, intent, priority (P1–P4), status, assignee, team queue, SLA policy, due timestamps (first response, resolution), tags, linked incident, linked tickets (duplicate/related/parent), attachments, custom fields per intent.
- **R-1.2** Status workflow: `new → triage → open → waiting_on_customer → waiting_on_dev → resolved → closed`, plus `merged`. Transitions are configurable; SLA clock pauses in `waiting_on_customer`.
- **R-1.3** Conversation timeline mixes: customer messages (any channel), public replies, **internal notes** (never sent), AI events (classification, investigation, drafts), system events (SLA warnings, assignment), with per-entry source channel.
- **R-1.4** Reply composer sends through the ticket's channel by default (email thread / LINE push / portal), can switch channel, supports templates with variables, attachments, canned macros, and "reply & set status".
- **R-1.5** Merge/duplicate detection: suggest existing tickets from same org with same intent in last 72h; merge keeps both conversations, customer of merged ticket is notified of the primary ticket.
- **R-1.6** SLA policies per org tier (e.g. Gold/Silver/Standard) × priority: first-response and resolution targets with business-hours calendar (Bangkok, Thai public holidays) and 24×7 option for P1.
- **R-1.7** Assignment: manual, round-robin among on-shift agents, load-balanced (open tickets per agent), or "stay with last handler". Reassignment keeps history.
- **R-1.8** Bulk actions, saved views/filters, full-text search across tickets, messages and attachments text.
- **R-1.9** Every ticket change is written to the audit log (§8.2).
- **R-1.10** Reopen: customer reply or CSAT < 3 after resolve reopens automatically within 7 days; counted in reopen rate.

**AC-1**: An email creates a ticket with correct org, intent and SLA due time within 10 s of Gmail push; replying from the composer lands in the same Gmail thread; merging two tickets keeps both message histories visible.

### 4.2 Omnichannel inbox (P0: Gmail, LINE, Portal)

Channel abstraction: `Channel` → `ChannelAccount` (a specific mailbox / LINE OA / portal) → `Message` with `external_id`, `direction`, `raw payload`, normalized body, attachments, delivery status. New channels implement one adapter interface (`ingest`, `send`, `markRead`, `capabilities`).

**Gmail**
- **R-2.1** Receive via Gmail API **push** (`users.watch` → Pub/Sub). Renew the watch **daily** (expires in 7 days; failure is silent). Fetch deltas with `users.history.list`; on HTTP 404 (`historyId` too old) run a full sync. [CONFIRMED — Gmail docs]
- **R-2.2** Dedupe inbound on RFC `Message-ID` and Gmail message id (Pub/Sub delivers at-least-once).
- **R-2.3** Thread matching by Gmail `threadId`, then `In-Reply-To`/`References`, then a `[OPS-1234]` token in subject; outbound sets `threadId`, `In-Reply-To`, `References`, same subject.
- **R-2.4** Mailbox access: shared support mailbox via service account with **domain-wide delegation** scoped to `gmail.readonly` + `gmail.send` (least privilege, T-102 review) [ASSUMED], or OAuth from a dedicated support user. Send-as alias support.
- **R-2.5** Attachments stored in object storage, images passed to vision model for OCR/description before classification; HTML sanitized; inline images preserved.
- **R-2.6** Auto-reply / bounce / out-of-office detection (`Auto-Submitted`, `X-Autoreply`, `Precedence: bulk`) → never creates a ticket, never triggers an auto-ack loop.
- **R-2.7** Noise handling: newsletters, machine notifications and spam classified as `noise` → labeled, visible in an "Other mail" view, no ticket; one-click "this is a ticket" converts and feeds the classifier.
- **R-2.8** Heartbeat: if no inbound mail is observed for a configurable window during business hours, raise an internal alert ("Gmail watch may have expired").

**LINE Official Account**
- **R-2.9** Webhook receiver with signature verification; respond 200 immediately, process async; dedupe on `webhookEventId`; enable redelivery. [CONFIRMED — LINE docs]
- **R-2.10** **Cost-aware reply routing** [CONFIRMED — LINE docs on reply tokens; pricing VERIFY]: a reply token is free but single-use and must be used within ~1 minute of the event. Push messages consume the monthly quota (Thai free plan 300/month; Basic ฿1,280 for 15,000; Pro ฿1,780 for 35,000 — **[VERIFY]** on LINE for Business TH). Therefore:
  - The system's **instant auto-ack** (and, at higher autonomy stages, the AI's instant answer) uses the reply token.
  - Human replies minutes/hours later use **push**; the UI shows remaining quota and warns at 80%.
  - Show LINE "loading animation" while AI drafts for stage ≥ 3 instant answers.
- **R-2.11** Identity: LINE `userId` is per-provider and anonymous. Map it to a `contact` + `organization` through (a) LINE Login on the client portal, (b) staff manually linking, or (c) a one-time verification code sent to the contact's registered email. Unlinked users are `unverified` → policy restricts what information can be disclosed (§6.6).
- **R-2.12** Media: download images/files from the content endpoint immediately (retention is limited) and store in object storage. Support stickers (ignore), location (store).
- **R-2.13** Mark-as-read via `markAsReadToken` when an agent opens the conversation [VERIFY API availability for the OA plan].
- **R-2.14** Rich menu: "Report an issue", "Check my tickets", "System status" (deep-links into the portal with LINE Login).
- **R-2.15** Group chats: if the OA is in a customer group chat, messages are threaded per group → org mapping [P1].

**Client portal** (see §4.9) is the third P0 channel.

**AC-2**: A LINE text message from an unlinked user creates a ticket, receives a reply-token ack within 5 s, and the ticket shows `unverified`; linking via LINE Login merges the identity and the agent's later reply goes out as a push with quota decremented in the UI.

### 4.3 Alerting, monitoring & incident management (P0 ingest/notify; P1 full incident mgmt)

**Ingest sources**
- **R-3.1** GCP **Cloud Monitoring alert policies** and **uptime checks** → notification channel Pub/Sub → Watchtower subscriber. Parse incident payload (policy name, condition, resource labels, state open/closed).
- **R-3.2** GCP **log-based alerts** via the same Pub/Sub path.
- **R-3.3** Generic **webhook alert endpoint** (Alertmanager-compatible payload) and email-to-alert (machine emails from vendors classified by the inbox as `machine_alert`).
- **R-3.4** **Usage anomaly detector** (§4.8) emits internal alerts (e.g. "org X API failure rate 3× baseline").

**Processing (borrowed from Keep / Grafana OnCall patterns)**
- **R-3.5** **Fingerprint dedup**: alerts with the same fingerprint (policy + resource + condition) within a window update the existing alert instead of creating a new one; count occurrences.
- **R-3.6** **Correlation**: rules group related alerts into one `incident` (same service within N minutes; same org; same deploy window). Head/lead can define rules in YAML-like config in the UI.
- **R-3.7** **Service catalog**: `service` (name, owner team, runbook URL, dashboard URL, GCP resource selectors, repos). Every alert resolves to a service → owner → runbook. Unknown service → "unmapped" bucket surfaced weekly.
- **R-3.8** **Escalation chain**: alert severity → notify on-shift agent → if not acknowledged in T1 → lead → if not acknowledged in T2 → head. Uses the roster (§4.7) to know who is on shift/on-call. Ack from web, Discord button, or `/ack` slash command.
- **R-3.9** **Snooze/suppress** with mandatory expiry and reason; suppressed alerts appear in the shift handoff.
- **R-3.10** **Heartbeat / dead-man's switch**: expected periodic signals (e.g. a monitoring heartbeat, Gmail inbound) that trigger an alert when missing.
- **R-3.11** **Noise metrics**: actionable-alert ratio per rule; weekly "noisiest rules" report to head.

**Incident management (P1)**
- **R-3.12** Incident: severity (SEV1–SEV4), status (`investigating → identified → monitoring → resolved`), commander, affected services, affected orgs (manual + inferred from linked tickets), timeline (auto-collected: alerts, ticket links, deploys, status posts, chat), linked tickets, root cause, postmortem doc (template, due in 5 business days for SEV1–2).
- **R-3.13** **Discord thread per incident**: created automatically, title/status synced, key timeline entries mirrored, `/incident status|update|resolve` commands, buttons for ack/assign.
- **R-3.14** **Mass customer communication**: from an incident, draft one update and send to all linked tickets' customers via their channels; post to the status page.
- **R-3.15** **"What changed" correlation**: incident view shows deploys/merged PRs/releases in the configurable window before the first alert (§4.5).

**Notifications**
- **R-3.16** In-app real-time (WebSocket/SSE) to online users with role/queue filters; browser **Web Push** for background tabs; sound only for P1/P2 or SEV1/2; per-user **focus mode** batching P3/P4 into a digest every N minutes.
- **R-3.17** Discord: webhook posts for tickets/alerts to configurable channels; bot for interactive actions. Respect `X-RateLimit-*` headers; global 50 req/s per bot; interactions acknowledged within 3 s. [CONFIRMED — Discord docs]

**Status page (P1)** — §4.6.

**AC-3**: A Cloud Monitoring alert firing twice in 5 min yields one alert with count 2; unacknowledged for T1 it escalates to the lead in Discord with an Ack button; acking in Discord updates the web within 2 s.

### 4.4 Knowledge base (P0 read/RAG; P1 authoring loop)

- **R-4.1** Articles: title, body (Markdown), intent tags, org visibility (internal / all clients / specific orgs), language (TH/EN), version history, author, reviewer, status (`draft → in_review → published → deprecated`), "last verified" date, linked sources (tickets, incidents, commits, runbooks).
- **R-4.2** Semantic search (pgvector embeddings) + keyword search; chunking with citations down to section level.
- **R-4.3** External sources ingestion: product developer docs / help center URLs (crawl on schedule), Google Docs folder [P1], Git repo Markdown [P1].
- **R-4.4** **AI-drafted articles**: when a ticket is resolved and the grader finds no cited article answered it, the AI drafts an article from the resolution → `in_review` for lead approval. Never auto-publishes.
- **R-4.5** **Golden answers**: a human reply can be marked "golden" → stored as a Q/A pair with intent, used for few-shot retrieval and eval set.
- **R-4.6** **Coverage & freshness metrics**: % of tickets with ≥1 cited article; articles older than their linked service's last deploy flagged "possibly stale"; gap report = intents with high volume and low coverage.
- **R-4.7** Runbooks are a KB article type with structured steps (optionally executable tool steps — §6.3).

**AC-4**: Searching "webhook retry" returns the article with a section-level citation; resolving a ticket with no citations produces a draft article in the review queue within 5 min.

### 4.5 Investigation workbench (P0 tools; P1 full UI)

Read-only, auditable tool layer used both by humans (UI) and AI (tool calls). Every execution is logged with who/what/why (ticket id) and result hash.

- **R-5.1** **GCP Logs tool**: query templates per intent with parameters (org id, session id, time window); raw Logging filter editor for head/lead; results paginated; **rate budget** (Logging `entries.list` is capped at 60 req/min/project and cannot be raised [CONFIRMED]) enforced by a token bucket shared across AI and humans, AI priority lower than humans. Optional: route heavy analysis to a BigQuery log sink.
- **R-5.2** **Data query tool** (BigQuery, incl. `EXTERNAL_QUERY` to Cloud SQL Postgres): saved query templates per intent; ad-hoc SQL for head/lead only; **guardrails**: read-only role, `statement_timeout`, row limit, cost: `maximum_bytes_billed` for native tables (note: **not supported for federated queries** [CONFIRMED] → enforce limits on the Postgres side, prefer a read replica), result size cap, PII columns masked by default via an allow-list.
- **R-5.3** **Repo / change tool**: list commits, merged PRs, releases/tags and deployments (GitHub Deployments API or CI webhook) for a service in a time window; show diff summary; link to PR. Host: GitHub assumed [ASSUMED — verify GitHub vs GitLab/Bitbucket]. Read-only app token.
- **R-5.4** **Deploy feed**: CI/CD posts deploy events (service, version, env, actor, time) to Watchtower via webhook so "what changed" works even without repo API access.
- **R-5.5** **Monitoring metrics tool**: read Cloud Monitoring time series for a service (error rate, latency p95, request count) for a window — used for system status panel and for AI evidence.
- **R-5.6** **Evidence attachments**: every tool run can be pinned to a ticket/incident as an evidence card (query, time, result summary, link to full result).
- **R-5.7** **Service status panel** (ops view): per service from the catalog: current alert state, error rate/latency sparkline (last 24h), last deploy, open incidents.

**AC-5**: From a `webhook_not_received` ticket, one click runs the intent's log template for the org and attaches an evidence card; AI runs cannot exceed the shared Logging rate budget (verified by a load test).

### 4.6 Status page & client-facing comms (P1)

- **R-6.1** Public status page (optional custom domain) listing components (from service catalog, flagged public), current status, incident posts, scheduled maintenance, 90-day history.
- **R-6.2** Subscriptions by email (and LINE for linked users); org-specific private status pages [P2].
- **R-6.3** Posting from an incident with templates; AI drafts customer-safe wording (no internal details) for approval.

### 4.7 Shift management & handoff (P0)

- **R-7.1** **Shift definitions** (e.g. 08:00–17:00, 13:00–22:00, 22:00–08:00, Bangkok time, configurable) and **roster**: who works which shift which day; on-call flag per shift.
- **R-7.2** **AI pre-roster**: given constraints (coverage rules per hour, agent availability/leave, max consecutive nights, fairness), AI proposes next period's roster; lead edits and publishes. Agents see their schedule; swap requests require lead approval; overrides recorded.
- **R-7.3** **Clock in/out**: agent clocks in (timestamp, device, optional location consent); late/no-show creates an alert to lead; clock-out blocked until handoff record is complete (lead can override).
- **R-7.4** **Daily brief at clock-in** (AI-generated, personalized): open incidents, my assigned tickets by SLA risk, tickets carried over to me, alerts snoozed, deploys in last 24h, customer watch items, KB changes, notes left for me. Rendered in the UI and optionally sent to Discord DM.
- **R-7.5** **Handoff record** (structured, I-PASS inspired):
  1. Shift id, outgoing/incoming people, timestamps
  2. Open incidents ranked by severity: status, owner, next action, ETA
  3. **Pending items** carried over: each with ticket/incident link, next action, due time
  4. SLA-at-risk tickets
  5. Deploys during shift; alerts snoozed/suppressed with expiry
  6. Customer watch items (e.g. "Customer X go-live tonight")
  7. Free-text situational notes + **messages left for the next shift** (R-7.7)
  AI pre-fills 2–6 from data; outgoing agent edits 7 and confirms.
- **R-7.6** **Receiver acknowledgment**: the incoming agent must acknowledge each pending item (accept / reassign / question). Unacknowledged items after 30 min alert the lead. Items stay "carried over" with a count of how many shifts they have crossed (surfaced in dashboards).
- **R-7.7** **Shift notes**: any user can leave a message addressed to "next shift", a specific person, or a date/time; shown in the recipient's brief and inbox; must be marked read.
- **R-7.8** **Per-agent performance** (lead/head): tickets handled, FRT/TTR, CSAT, AI acceptance, escalations, handoff completeness, punctuality. Agents see their own.

**AC-7**: An agent cannot clock out with an open assigned P1 ticket that has no handoff entry; the incoming agent sees it in their brief and must acknowledge; the lead's dashboard shows 0 unacknowledged items after acknowledgment.

### 4.8 Product-usage dashboard & proactive support (P1)

- **R-8.1** **Metric definitions** (configured by head, since the product schema is not known to this PRD): name, description, SQL template (BigQuery / EXTERNAL_QUERY), dimensions (org, flow, step, env), unit, refresh interval, baseline method (7-day same-hour median), anomaly rule (e.g. > 3× baseline and > N absolute). Starter set: core transactions per org per hour, success/fail per processing step, API error rate per org, webhook delivery success rate, p95 latency per endpoint, active flows per org.
- **R-8.2** **Ops view**: per-org usage cards (today vs baseline), top movers, step-level failure heatmap, drill-down to session samples (PII-masked) → one click to run the matching log template.
- **R-8.3** **Anomaly → proactive ticket**: when an anomaly rule fires for an org, create an internal ticket with intent inferred from the step, run pre-investigation, and (at autonomy stage ≥ 2) draft a proactive notice to the org's primary contact for approval.
- **R-8.4** **Client Health Score** per org (0–100): weighted from ticket volume vs baseline, SLA breaches, CSAT, incidents affecting the org, usage anomalies. Used in CEO view (§9.2) and ticket sidebar.
- **R-8.5** Metric queries run on a schedule by the worker with the same guardrails as §4.5; results cached in Watchtower's own DB (time-series table) so dashboards never hit BigQuery on page load.

### 4.9 Client portal (P0 submit/track; P1 org views)

- **R-9.1** Public submission link (per org or generic) with form fields: email, org (auto if from allow-listed domain), category, description, attachments, affected session/API request IDs, urgency. Human-verification (Turnstile/hCaptcha) on the generic link.
- **R-9.2** On submit: ticket created, confirmation email with ticket number and tracking link (signed token). Email updates on every public reply and status change; reply by email appends to the ticket.
- **R-9.3** Tracking page: status, timeline of public messages, add a reply/attachment, rate on resolve.
- **R-9.4** Logged-in org view (magic link / LINE Login): all tickets of my org, filters, export CSV, manage org contacts (org admin), notification preferences, status-page subscription.
- **R-9.5** Branding: logo/colors configurable; TH/EN.

### 4.10 CSAT (P0 email; P1 LINE, analytics)

- **R-10.1** Trigger: ticket → `resolved`; send after a configurable delay (default 1 h) unless the ticket is reopened before sending.
- **R-10.2** Email with one-click 1–5 rating links (signed, single-use per ticket) → landing page in the portal to add an optional comment and "was this resolved?" yes/no.
- **R-10.3** Channel-aware: tickets originating from LINE receive the survey as a LINE message (push, counts toward quota; configurable to skip when quota < 10%).
- **R-10.4** Rules: one reminder after 48 h if unanswered; max one survey per contact per 7 days; per-org opt-out; never for internal/machine tickets; stop and void if reopened.
- **R-10.5** Results feed: CSAT metrics (overall, per agent, per intent, AI-handled vs human), the grader (§6.4), and reopen logic (score ≤ 2 or "not resolved" → reopen + lead notification).

### 4.11 AI layer — see §6 (P0 stages 0–2; P1 stage 3; P2 stage 4)

### 4.12 Administration (P0)
- Users, roles, organizations, contacts, SLA policies, business hours/holidays, intents, channels/integrations (OAuth flows, keys, test buttons, health), AI provider settings (§6.7), templates, service catalog, metric definitions, notification routing, feature flags, audit log viewer, data retention settings, backup status.

---

## 5. Reference scenarios

### 5.1 An email arrives (unknown type)
1. **Ingest** (T+0): Pub/Sub push → fetch history → new message → dedupe → store raw → build PII-redacted copy for LLM.
2. **Identify** (T+1 s): thread match → existing ticket (go to B); sender → org/contact via domain/contact table; unknown → `unverified`.
3. **Classify** (T+2 s, always runs): type ∈ {noise, reply_to_existing, new_customer_issue, internal_or_machine, triage}, intent, priority, confidence.
   - **A noise** → label, "Other mail" view, no ticket; agent can convert → feedback.
   - **B reply** → append; reopen if resolved; SLA clock resumes; AI updates summary; notify assignee.
   - **C new issue** → create ticket; check open incidents matching intent/window → link; assign per roster (or on-call ping if nobody on shift); **auto-ack** (template with ticket number, portal link, SLA ETA — allowed at any stage); notify in-app + Discord thread.
   - **D internal/machine** → internal ticket or alert pipeline.
   - **E low confidence** → `triage` queue for a human; no guesses.
4. **Pre-investigation** (T+5 s → ~2 min, async): run the intent runbook: KB + similar tickets → org context → log template → data template → "what changed" → cross-org pattern check (propose incident if several orgs affected). Attach **Investigation Report** (summary, evidence cards with citations, hypotheses with confidence, open questions) + **draft reply**.
5. **Human review** (stage 2 default): three-pane view; **A** approve / **E** edit / **R** reject (reason code); send through Gmail in-thread; diff draft→final stored; escalate or `waiting_on_dev` if needed.
6. **After**: `waiting_on_customer` pauses SLA → customer reply → B; resolve → CSAT → grader → KB draft/golden answer; unresolved at shift end → handoff pending item.
7. **Edge cases**: screenshots → vision OCR before classify; many orgs reporting the same thing during an incident → merge + mass update; Gmail watch expired → heartbeat alert; LLM provider down → rule-based fallback creates ticket + plain auto-ack, investigation retried later; `unverified` sender → disclosure policy blocks sensitive details in drafts.

### 5.2 A LINE message arrives
Same as 5.1 with differences: respond via reply token within seconds (auto-ack or stage-3 instant answer); identity via LINE Login/link code; later human replies via push (quota); loading animation while AI drafts; media fetched immediately.

### 5.3 A GCP alert fires
Pub/Sub → parse → fingerprint → dedupe/correlate → resolve service/owner/runbook → notify on-shift (in-app + Discord) → escalation timers → agent acks → AI pre-investigation on the alert (logs around the window, metrics, "what changed") → if customer impact likely, propose incident + draft status post → agent decides. Alert auto-resolves when GCP sends `closed`; incident does not auto-resolve.

### 5.4 Shift change at 22:00
Outgoing agent opens handoff → AI pre-fills → edits notes → confirms → clock-out allowed. Incoming agent clocks in → daily brief (includes handoff) → acknowledges each pending item → lead dashboard shows handoff complete; unacknowledged after 30 min → lead alerted.

### 5.5 Head's Monday morning
Opens CEO view → AI-drafted weekly brief with WoW numbers, client health ranking, top root causes, AI progress, decisions needed → edits → exports PDF / Google Doc → sends to CEO. Reviews "noisiest alert rules" and "intents ready for autonomy promotion" recommendations.

---

## 6. AI architecture

### 6.1 Principles
- **Human approval by default; autonomy earned per intent with evidence.**
- **Evidence over confidence numbers**: show sources and tool calls, not just a score.
- **Every AI action is a first-class, auditable event** (prompt version, model, tools called, inputs hash, outputs, cost, latency).
- **Read-only tools only** for investigation; any write action (sending, changing status, posting status page) requires policy approval or human click.
- **Provider-agnostic**: Anthropic Claude (Messages API / Agent SDK) or Google Vertex AI (Gemini) selected by head (§6.7).

### 6.2 Agents (logical)
| Agent | Trigger | Output |
|---|---|---|
| **Classifier** | every inbound message/alert | type, intent, priority, org/contact hints, language, confidence |
| **Investigator** | ticket created / major update / alert | Investigation Report + evidence cards |
| **Drafter** | after investigation, or on agent request | customer reply draft (in customer's language), internal note draft |
| **Summarizer** | on demand, on handoff, on brief | ticket summary (intent, timeline, open questions, next action, sentiment), shift brief, weekly brief |
| **Grader** | after resolution, sampled during conversation at stage ≥ 3 | verified/contained/assumed resolution, policy violations, quality score, KB gap flag |
| **KB Author** | grader flags gap / golden answer marked | draft article |
| **Roster Planner** | lead requests | roster proposal with constraint report |
| **Personal Assistant** (head/lead/agent) | chat sidebar, ⌘K | answers over tickets/KB/metrics with tools; can prepare actions for one-click confirmation |

All agents share one tool registry (§6.3) with per-agent and per-intent allow-lists.

### 6.3 Tools, procedures and the MCP boundary
- Watchtower backend exposes its capabilities as **MCP tools** (tickets, KB search, log/data templates, metrics, roster) over an authenticated MCP server. Internal agents, external AI clients (e.g. Claude Code, Claude Desktop for the head) and future mobile app reuse the same surface.
- External MCP servers may be used where they exist (e.g. Google's managed BigQuery MCP [VERIFY availability/region], GitHub MCP) but each is wrapped so allow-listing, rate budgets and audit logging are enforced by Watchtower.
- **Procedures** (per intent, authored in natural language by lead/head, compiled to a step list; versioned): investigation steps, disclosure rules, reply guidelines, when to escalate, what the AI may do at each stage. Procedures can be **simulated** against past tickets before publishing.

### 6.4 Autonomy stages (per intent)
| Stage | Behaviour | Gate to advance |
|---|---|---|
| **0 Observe** | classify, summarize, investigate; no customer-facing draft | classification accuracy ≥ 90% on labeled set (≥ 50 samples) |
| **1 Suggest** | drafts only when an agent asks | acceptance ≥ 50%, edit distance trending down over 2 weeks |
| **2 Draft-for-approval** *(default for new intents once stage 0 passes)* | every reply drafted; human approves; auto-ack allowed | ≥ 30 approvals with ≤ 20% edit, 0 policy violations in eval replay |
| **3 Auto-send with threshold** | auto-send when grader score ≥ threshold **and** intent allow-listed **and** customer verified; else stage 2; customers may be told it is an automated answer (configurable) | verified-resolution ≥ human baseline, CSAT parity, reopen ≤ human, over ≥ 4 weeks |
| **4 Autonomous** | full handling incl. read-only tools and status updates; write actions still policy-gated | continuous sampled grading with auto-rollback to stage 2 on violation or metric regression |

Promotion/demotion recorded with reason; head can pin a stage; emergency "all intents → stage 2" switch.

### 6.5 Learning loop
1. Store every draft → final **diff**; compute normalized edit distance; reason codes on reject.
2. Human replies marked **golden** → retrieval examples + eval set.
3. **Eval set** per intent (real anonymized tickets + expected outcome) replayed automatically on every prompt, procedure or model change; results gate deployment of the change.
4. Grader flags → **KB Author** drafts → lead approves → coverage rises.
5. Weekly **"ready for promotion"** report per intent with the gate metrics.
6. Optional later: fine-tuning/few-shot packs per intent from golden answers (no customer PII in training data).

### 6.6 Guardrails
- **PII redaction** (Thai national ID patterns, phone, email, names where possible, images of documents) before any LLM call; mapping kept server-side to re-insert only into human-visible views.
- **Disclosure policy**: AI never reveals end-user data, internal URLs, or incident root causes to `unverified` contacts; customer-safe wording for status posts.
- **Citations required** for factual claims in drafts; uncited claims are highlighted for the reviewer.
- **Tool allow-list per intent and per stage**; all tools read-only; rate budgets.
- **Independent grader** model (may be a different provider/model) checks outbound auto-sent messages at stage ≥ 3 before sending.
- **Kill switch** and budget caps (tokens/day, cost/day) with alerts at 80%.
- **Audit log** of every AI action (§8.2).

### 6.7 Provider configuration (head only)
- Providers: `anthropic` (API key or Vertex-hosted Claude), `vertex` (Gemini). Per-agent model selection (e.g. small model for classifier, large for investigator/drafter, different vendor for grader).
- Embeddings provider selectable (Vertex text embeddings or other); stored dimension recorded per index.
- Secrets stored encrypted (envelope encryption with a KMS key or local master key), never logged.
- Cost tracking per agent/intent/ticket; cost per ticket metric.
- Implementation via a thin provider abstraction (e.g. Vercel AI SDK) so adding OpenAI-compatible endpoints later is trivial.

---

## 7. Data model (core entities)

```
organization(id, name, tier, sla_policy_id, domains[], line_group_ids[], health_score, primary_contact_id, notes)
contact(id, org_id, name, emails[], line_user_id, phone, verified_at, role_in_org, notification_prefs)
user(id, email, name, role, permissions[], status, shift_preferences, discord_user_id)
team_queue(id, name, members[])

ticket(id, number, org_id, requester_contact_id, channel_account_id, intent_id, priority, status,
       assignee_id, queue_id, sla_policy_id, first_response_due_at, resolution_due_at,
       first_responded_at, resolved_at, closed_at, incident_id, parent_ticket_id, tags[],
       custom_fields jsonb, autonomy_stage_at_creation, ai_handled bool, reopen_count, csat_score)
message(id, ticket_id, channel_account_id, direction, external_id, thread_key, sender_contact_id|user_id,
        body_text, body_html, body_redacted, attachments[], visibility (public|internal), delivery_status, created_at)
ticket_event(id, ticket_id, type, actor (user|system|ai), payload jsonb, created_at)

intent(id, key, name, default_priority, sla_policy_id, runbook_article_id, allowed_tools[], autonomy_stage,
       procedure_version_id, reply_templates[])
sla_policy(id, name, tier, targets jsonb {priority: {first_response_min, resolution_min, calendar}})
business_calendar(id, timezone, hours jsonb, holidays[])

channel_account(id, type (gmail|line|portal|discord|webhook), config_encrypted, health, quota_used, quota_limit)

alert(id, fingerprint, source, service_id, severity, state, first_seen, last_seen, count, payload jsonb,
      incident_id, acked_by, acked_at, snoozed_until, snooze_reason)
incident(id, number, severity, status, commander_id, services[], orgs[], started_at, resolved_at,
         root_cause, postmortem_article_id, discord_thread_id, status_page_visible)
incident_timeline(id, incident_id, type, actor, payload, created_at)
service(id, name, owner_team, runbook_article_id, dashboard_url, gcp_selectors jsonb, repos[], public bool)
deploy(id, service_id, version, env, actor, source (ci|github), started_at, finished_at, url)
escalation_policy(id, steps jsonb)

kb_article(id, slug, title, body_md, lang, status, intent_tags[], visibility, version, author_id, reviewer_id,
           last_verified_at, sources[], embedding_index_id)
kb_chunk(id, article_id, section, text, embedding vector)
golden_answer(id, intent_id, question, answer, ticket_id, approved_by)

shift_definition(id, name, start_time, end_time, timezone, is_oncall)
roster_entry(id, shift_definition_id, date, user_id, status (planned|published|swapped|override))
shift_session(id, user_id, roster_entry_id, clock_in_at, clock_out_at, device, handoff_record_id)
handoff_record(id, shift_session_id, incoming_user_id, structured jsonb, notes_md, confirmed_at, acknowledged_at)
handoff_item(id, handoff_record_id, ref_type, ref_id, next_action, due_at, ack_status, ack_by, carried_count)
shift_note(id, author_id, audience (next_shift|user|datetime), body, read_by[])

ai_run(id, agent, ticket_id|incident_id|null, provider, model, prompt_version, procedure_version,
       tools_called jsonb, input_hash, output jsonb, confidence, cost_usd, latency_ms, created_at)
ai_draft(id, ticket_id, ai_run_id, body, citations[], status (pending|approved|edited|rejected|auto_sent),
         final_body, edit_distance, reject_reason, reviewer_id, reviewed_at)
eval_case(id, intent_id, input jsonb, expected jsonb, source_ticket_id)
eval_result(id, eval_case_id, prompt_version, model, passed bool, score, details)
tool_execution(id, tool, actor, ticket_id, params jsonb (redacted), result_hash, rows, bytes, duration_ms, created_at)

csat_survey(id, ticket_id, channel, sent_at, reminder_sent_at, token, score, resolved_flag, comment, responded_at, voided)
usage_metric_def(id, name, sql_template, dimensions[], unit, refresh_sec, baseline_method, anomaly_rule jsonb)
usage_metric_point(metric_id, ts, dims jsonb, value)   -- time-series, partitioned
status_component(id, service_id, name, public), status_post(id, incident_id, body, visibility, posted_at)
audit_log(id, actor_type, actor_id, action, target_type, target_id, before jsonb, after jsonb, ip, created_at)
notification(id, user_id, type, payload, read_at, delivered_channels[])
```

Postgres 16 + `pgvector`; time-series tables partitioned by month; attachments in S3-compatible object storage; Redis for queues/real-time pub/sub.

---

## 8. Non-functional requirements

### 8.1 Deployment
- `docker compose up` brings up: `web`, `api`, `worker` (queues, schedulers, ingestion), `postgres` (pgvector), `redis`, `minio` (S3), `caddy`/`nginx` (TLS), optional `mcp` endpoint (can live in `api`).
- Config via env + admin UI; secrets encrypted at rest; `.env.example` complete; one-command seed with demo data.
- Health endpoints, structured JSON logs, OpenTelemetry traces/metrics, Prometheus endpoint.
- Backups: nightly `pg_dump` + object storage sync to GCS bucket; documented restore drill.
- Upgrades: versioned migrations, zero-data-loss rollbacks for last 2 versions.

### 8.2 Security & compliance
- RBAC (§2.2); every mutation and every data read of PII-bearing records in **audit log** (immutable, exportable, retention ≥ 1 year).
- Encryption in transit (TLS) and at rest (DB volume + application-level for secrets/tokens).
- PII minimization: attachments scanned for ID documents → stored in a restricted bucket with expiry; redaction for LLM; masked views by default; export requires `head`.
- PDPA (Thailand): data retention policy per entity (default: tickets 3 years, attachments 1 year, LINE media 90 days [ASSUMED]); data subject export/delete for a contact.
- Rate limiting, CSRF, CSP, dependency scanning, SBOM; no secrets in logs; signed webhooks (LINE, GitHub, Discord interactions, CI).
- Least-privilege GCP service accounts: `roles/logging.viewAccessor` on a log view (not `privateLogViewer`), `bigquery.user` + `dataViewer` on specific datasets, read-only Postgres role on a replica, Monitoring viewer.

### 8.3 Performance & reliability
- Inbound message → ticket visible in UI: p95 < 10 s. AI report: p95 < 120 s.
- Real-time updates < 2 s; UI interactions < 200 ms for queue navigation (local cache + optimistic updates).
- At-least-once ingestion with idempotency keys; retry with backoff; dead-letter queue visible to head.
- Degraded modes: AI provider down → rule-based classification + templates; GCP API down → cached status + alert; LINE quota exhausted → email fallback suggestion.

### 8.4 Internationalization
- UI in Thai and English; customer communications in the customer's language (detected); dates in Asia/Bangkok with user override.

---

## 9. Dashboards & reporting

### 9.1 Ops view (head, lead; agents see a reduced version)
Volume & channel · Speed & SLA (FRT, TTR median/p90, breach rate, at-risk now, aging) · Quality (CSAT, reopen, escalation, % to dev) · Reliability (incidents by SEV, MTTA/MTTR, affected orgs, alert noise ratio, change-related failure rate) · AI (stage per intent, acceptance, edit distance, verified vs assumed, % no-touch, cost per ticket, KB coverage/freshness) · Team (per-agent, coverage vs gaps, carried-over items, LINE quota) · **Product usage** (§4.8) · **Service status panel** (§4.5).

### 9.2 CEO view (head, lead)
One page, weekly cadence, WoW deltas:
1. Are customers OK? — CSAT, SLA compliance, ticket volume trend
2. Is the platform stable? — incidents, MTTR, customer-impacting minutes
3. Which customers are at risk? — **Client Health Score** ranking, top 5 with reasons
4. AI progress — % AI-resolved, **automation savings** (hours/week, cost per ticket vs last month), intents promoted
5. Top 5 root causes this week (AI-clustered) → product/engineering asks
6. Decisions needed
Generated as an AI-drafted brief the head edits; export to PDF and Google Docs; schedulable email.
External inputs the system does not compute (platform uptime from monitoring, revenue/churn) are shown as pluggable tiles fed by API/CSV.

---

## 10. UX principles (8-hour-shift product)

- **Three-pane command center**: queue | conversation | AI sidebar (report, evidence, draft with A/E/R). Keyboard-first: ⌘K command palette, J/K navigation, single-key actions, `?` shows shortcuts.
- **Progressive disclosure**: summary first; evidence and raw logs on expand; never dump raw JSON by default.
- **Alert discipline**: one primary queue; P1/SEV1 sticky banner; everything else a counted badge; sound only for P1/P2; focus mode batching; "N new" pill instead of list reflow under the cursor.
- **Severity never by color alone** — icon + label; WCAG 2.x AA (4.5:1 body text, 3:1 UI/large text); dark and light themes following the OS, user override; reduced-motion support.
- **AI trust UI**: show sources and tool calls; highlight uncited claims; make edit frictionless and capture the diff; reject requires a reason code; show the intent's autonomy stage on every draft.
- **Density settings** (comfortable/compact); font size setting; 14–15 px base [ASSUMED].
- **Latency honesty**: skeletons and "investigating… (step 3/6: querying logs)" progress; never a silent spinner > 2 s.
- **Mobile-ready layouts** from Phase 1 (PWA): queue and conversation stack; approve/edit/reject reachable with thumbs; push notifications.

---

## 11. Integration constraints checklist

| Integration | Must-know constraints (as of 2026-10) |
|---|---|
| Gmail API | `users.watch` expires ≤ 7 days → renew daily; notifications carry only `historyId`; 404 on history → full sync; grant `gmail-api-push@system.gserviceaccount.com` Publisher on the topic; threading headers on send. [CONFIRMED] |
| LINE Messaging API | Webhook signature + redelivery + `webhookEventId` dedupe; reply token single-use, ~1 min; push counts toward plan quota; media download promptly; loading animation 5–60 s; mark-as-read token [VERIFY]; Thai plan prices [VERIFY]. |
| Discord | Webhook for one-way; bot for interactions; honor `X-RateLimit-*`; 50 req/s global; 3 s interaction ack; thread per incident. [CONFIRMED] |
| GCP Cloud Logging | `entries.list` 60 req/min/project, not raisable → shared rate budget; `_Default` retention 30 d; log views + `viewAccessor` for least privilege; log-based alerts → Pub/Sub. [CONFIRMED] |
| GCP Cloud Monitoring | Alert policies → Pub/Sub notification channel; uptime checks; Monitoring API for time series (quota applies). [CONFIRMED pattern; VERIFY quotas] |
| BigQuery / Cloud SQL Postgres | `EXTERNAL_QUERY` read-only, Postgres dialect, unsupported types must be cast; `maximum_bytes_billed` not supported for federated queries → Postgres-side limits + read replica; cross-region federated cap 1 TB/project/day. [CONFIRMED] |
| GitHub (assumed host) | GitHub App read-only; commits/PRs/releases/deployments APIs; webhook for deploy events. [ASSUMED host] |
| Google Workspace SSO / Docs export | OIDC; Docs API for CEO brief export. [ASSUMED] |
| AI providers | Anthropic Messages API (tool use) / Vertex AI (Gemini function calling); embeddings; cost metering. |

Re-checked against official docs on 2026-11-01 (T-102a/T-103a; full tables with URLs in `packages/channels/src/{gmail,line}/README.md`):
- LINE: `x-line-signature` = HMAC-SHA256 of the raw body; reply token single-use, valid ~1 min (may change without notice); `X-Line-Retry-Key` UUID valid 24 h for push/multicast/narrowcast/broadcast only (409 on repeat); quota via `GET /v2/bot/message/quota[/consumption]`, reply messages not counted, push counted per recipient, 429 over quota; mark-as-read `POST /v2/bot/chat/markAsRead`. Thai OA plans (lineforbusiness.com/th, prices excl. 7% VAT): Free 300 msgs/month; Basic ฿1,280 for 15,000 (extra ฿0.1); Pro ฿1,780 for 35,000 (extra ฿0.06). [CONFIRMED 2026-11-01] · reply-token exact lifetime, `Retry-After` on 429, quota reset time zone, mark-as-read availability per plan [VERIFY]
- Gmail OAuth of the support mailbox (T-102e, the default way; service account with delegation is an option): hosts reached are `accounts.google.com` (the browser is redirected there), `oauth2.googleapis.com` (code exchange, refresh, revoke) and `gmail.googleapis.com` (`users.getProfile` to learn which address granted, same host as the Gmail transport); scopes exactly `gmail.readonly` + `gmail.send`; a refresh token of an External consent screen in "Testing" expires in 7 days (`invalid_grant`). Details and links in `packages/channels/src/gmail/README.md`. [CONFIRMED 2026-11-01] · PKCE accepted for a Web application client, revoke endpoint [VERIFY]
- Gmail: watch renewal ≤ 7 days, history 404 → full sync, push payload base64url `{emailAddress, historyId}`, threading needs `threadId` + `References`/`In-Reply-To` + matching subject. [CONFIRMED 2026-11-01] · caller-supplied `Message-ID` kept on send [VERIFY]

---

## 12. Architecture & stack recommendation

[ASSUMED — the build session may propose alternatives via an ADR in `docs/decisions/`]

- **Monorepo** (pnpm + Turborepo), TypeScript end-to-end:
  - `apps/web` — Next.js (App Router), React, Tailwind, shadcn/ui, TanStack Query, WebSocket client, PWA.
  - `apps/api` — NestJS (modular: auth, tickets, channels, alerts, kb, ai, shifts, metrics, admin), REST + WebSocket gateway, MCP server endpoint, OpenAPI spec.
  - `apps/worker` — BullMQ workers: ingestion (Gmail/LINE/Pub/Sub), AI runs, schedulers (watch renewal, SLA timers, CSAT, metric refresh, briefs), notifications.
  - `packages/db` — Drizzle ORM schema + migrations (Postgres 16 + pgvector).
  - `packages/ai` — provider abstraction (Vercel AI SDK), agents, tools registry, prompts (versioned files), eval runner.
  - `packages/channels` — adapters (gmail, line, portal, discord, webhook).
  - `packages/ui` — shared components/design tokens.
- **Infra**: Docker Compose (dev/prod profiles), Caddy TLS, MinIO, Redis, Postgres; optional Helm chart later.
- **Why not fork Chatwoot/Zammad**: Rails monoliths; Chatwoot's AI lives under its enterprise license; neither has shifts, investigation tools or per-intent autonomy. We borrow their channel and AI-admin patterns instead (§14).
- **Mobile (Phase 4)**: React Native/Expo consuming the same API + MCP; push via FCM/APNs; PWA covers the gap until then.

---

## 13. Open source & licensing

- Repository public under **Apache-2.0** [CONFIRMED 2026-10-31]. The repo stays organization-neutral: companies adopt it by forking and adding their own data in their instance.
- No customer data, secrets, or any adopting organization's name or internal procedures in the repo; procedures/intents/metric SQL live in the instance DB, with generic examples in `examples/`.
- Contribution guide, code of conduct, security policy, ADRs.

---

## 14. Comparable products & what we borrow (research summary, 2026-10)

| Product | Status | Borrow |
|---|---|---|
| Chatwoot (MIT core; AI "Captain" enterprise) | active | channel/inbox model incl. native LINE; copilot sidebar; FAQ-gap detection |
| Zammad 7.0 (AGPL) | active (Mar 2026) | AI with free choice of provider; every AI action logged in ticket history; AI summary structure |
| Libredesk (AGPL, Go) | active | lean single-binary ops; SLA model |
| Keep (keephq) | active, open-core | alert fingerprint dedup, correlation, YAML workflows |
| Grafana OnCall OSS | **archived Mar 2026** | design only: escalation chains, schedules, heartbeat |
| Peppermint | **archived Jul 2026** | — |
| Intercom Fin / Zendesk / Sierra / Decagon / Ada / Plain / Pylon | commercial | procedures as unit of autonomy; simulation/replay; human-in-the-loop approval steps; supervisor/grader; verified vs assumed resolution; runbooks with human-stepped mode |
| Parlant (Apache-2.0) | active | guideline/journey style behaviour control; candidate library for the procedure engine |

**Gaps none of the open-source tools fill (= this product's core):** pre-investigation with GCP/BigQuery/Git tools; deploy correlation; shift roster/handoff/briefs; per-intent autonomy dial with eval gates; learning loop with edit diffs and golden answers; verified-resolution grading; alert→ticket pipeline with Discord threads; LINE cost-aware routing; product-usage health and proactive tickets; CEO view.

---

## 15. Phase plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Foundation** (weeks 1–3) | Monorepo, Docker Compose, auth (Google SSO + magic link), RBAC, orgs/contacts, ticket core, audit log, design system, three-pane UI shell, CI | Create/assign/reply (portal) tickets end-to-end in Docker |
| **1 — Inbox + AI stages 0–2** (weeks 4–8) | Gmail + LINE adapters, portal submission/tracking, auto-ack, classifier, investigator (KB + logs + data + repo tools, read-only), drafter with A/E/R, KB with RAG, CSAT email, Discord notifications, in-app real-time, shifts: roster, clock in/out, brief, handoff, notes | Team runs a full shift in the tool; AC-1, AC-2, AC-4, AC-7 pass |
| **2 — Reliability + usage** (weeks 9–13) | GCP Monitoring/Logging alert ingest, dedup/correlation, escalation, service catalog, incidents + Discord threads, status page, deploy feed/"what changed", product-usage metrics + anomaly → proactive tickets, Client Health Score, ops dashboard | AC-3, AC-5 pass; first incident handled start-to-finish in tool |
| **3 — Autonomy + learning** (weeks 14–20) | Grader, eval sets & replay, golden answers, KB author, procedures with simulation, autonomy stage 3 for first 2–3 intents, cost dashboard, CEO view with AI weekly brief, roster planner | First intent at stage 3 passes gate metrics for 4 weeks |
| **4 — Mobile + scale** | React Native app, org-private status pages, group-chat LINE, additional channels, Helm chart | App store release; one external deployment of the open-source project |

---

## 16. Open questions for the owner (answer before/at Phase 0)

1. Repo host and CI (GitHub? GitLab?) and whether Watchtower may have a read-only GitHub App installed on product repos.
2. Is the product DB on Cloud SQL Postgres? Can a read replica + read-only role be provisioned? Is BigQuery already used (log sink / exports)?
3. Which GCP projects/environments are in scope (prod only? staging?). Existing alert policies to migrate?
4. Support mailbox address(es), whether domain-wide delegation is allowed by the Workspace admin.
5. LINE OA plan in use and current monthly message volume; is the OA already used by other teams (sales/marketing)?
6. Discord server structure; is Discord the official internal chat or a side channel?
7. Team size, shift pattern, 24×7 or business hours + on-call?
8. Customer tiers/SLAs that exist contractually today.
9. (closed 2026-10-31: public under Apache-2.0, organization-neutral, §13)
10. AI provider preference and budget (Claude via Anthropic API vs Vertex AI; data-residency constraints?).

---

## 17. How this project is run (pointer)

The working method — session cold-start order, roles/sub-agents, Definition of Done, handoff and daily-log rules, claim tags, `[ASK-HUMAN]` stops — lives in **`AGENTS.md`** (model-agnostic) and **`docs/00-START-HERE.md`** (phases, agents, DoD). `CLAUDE.md` is only a pointer to those. Current state is always in **`HANDOFF.md`** and **`docs/STATUS.md`**; ordered work in **`docs/BACKLOG.md`**; decisions in **`docs/decisions/ADR-xxx.md`**.

Rules that also apply to this document:
1. This PRD is the product source of truth. When an **[ASSUMED]** or **[VERIFY]** item becomes confirmed, change the tag here (and record where it was confirmed) — do not keep a private copy.
2. Phase 0 implementation order: schema (§7) → auth/RBAC → ticket core → portal channel → three-pane UI shell → audit log → Docker Compose → seed script → e2e test for AC-1 (portal path).
3. Every module ships with: OpenAPI docs, unit tests for domain logic, one e2e scenario from §5, a `CHANGELOG.md` entry.
4. Never commit real credentials, customer data or any adopting organization's internal procedures; use `examples/` for sample intents, metric SQL and procedures.
