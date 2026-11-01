# Phase 2 breakdown — ร่าง `architect` 2026-11-02 (mock เท่านั้น)

> ตัวเลขและชื่อที่เสนอทั้งหมด `[ASSUMED]` · เลข migration main thread กำหนดตอน merge
> เจ้าของสั่ง 2026-11-01: ทำด้วย mock ให้มากที่สุด ให้ `po` ตัดสินแทน · ปลายทางจริงทุกตัว `[ASK-HUMAN]`

## A. ข้อเท็จจริงจากโค้ด

- compose ไม่มี service `pubsub` · `examples/metrics/` ว่าง · `ticket_channel_check` ไม่มี `internal`
- BACKLOG ไม่มี UI alert/incident ทั้งที่ AC-3 ต้องใช้ → เพิ่ม T-206d
- ledger T-108 ไม่นับคน ไม่แยก project · `tool_execution` ไม่ partition ขัด ARCH §7

## B. T-200 scaffolding (`backend-dev`, ก่อน W1)

workspace `packages/connectors` + `WORKSPACES` · ไฟล์ feature เปล่า · permission: `alert.read|ack|manage`, `service.manage`, `investigate.adhoc`, `metric.read|manage`, `org.health.read`, `dashboard.ops.read` · `ticket.channel` เพิ่ม `internal` · env ว่าง = mock, `STATUS_PAGE_PUBLIC=false`

## C. Tasks

**T-201 Alerts (AC-3)** · `[ASK-HUMAN]` GCP project, topic, notification channel

- a `integration-engineer` `connectors/alerts`: normalizer GCP Monitoring, log-based, Alertmanager + fingerprint · mock: fixture สังเคราะห์ตามเอกสารทางการ `[VERIFY]`
- b `backend-dev` migration `service`, `escalation_policy`, `alert`, `alert_event` · catalog CRUD + unmapped · partial unique `(fingerprint)` เฉพาะ alert ที่เปิด
- c `backend-dev` receiver ใช้ `push-verifier` เดิมกับ JWKS ที่สร้างตอน test (ไม่ใช้ emulator) + webhook HMAC → `domain.ingestAlert` · unique `(source, provider_event_id)`: redelivery ไม่บวก count · `closed` ไม่ปิด incident
- d `integration-engineer` escalation: sweep + `next_escalation_at` นาฬิกา DB เท่านั้น (บทเรียน T-122) · roster T-111 · ack conditional update + realtime
- e `backend-dev` correlation, snooze มี expiry, heartbeat, noise metrics

**T-202 Incident (AC-3)** · `[ASK-HUMAN]` bot token, public key

- a `backend-dev` migration `incident`, `incident_timeline` (partition), `deploy`, FK `ticket.incident_id` · deploy feed HMAC
- b `integration-engineer` `BotTransport` + fake (ปุ่ม, thread) · interactions Ed25519 keypair ตอน test, ack < 3 s, dedupe id · `discord_user_id` ไม่ map = ปฏิเสธ
- c `backend-dev` mass comms ผ่าน dispatcher ทีละ ticket ยืนยันจำนวนผู้รับ
- d `backend-dev` "what changed" จาก `deploy` + repo fake

**T-203 Tools (AC-5)** · `[ASK-HUMAN]` GCP/BigQuery/GitHub → T-208 live adapters

- a `integration-engineer` `connectors`: `LogsClient`, `MetricsClient`, `DataQueryClient`, `RepoClient` + fake + contract test · ไม่มี live
- b `backend-dev` `rate_budget_window` atomic upsert · รวม 55/นาที, AI ≤ 30 · ย้าย ledger T-108 · load test: fake ตอบ 429 เกิน 60/นาที
- c `backend-dev` DB แยก `product_mock` · read-only tx, `statement_timeout`, row cap, PII allow-list · ad-hoc head/lead · `EXTERNAL_QUERY` ปิด (po #2)
- d `backend-dev` human run + template ต่อ intent + evidence card + status panel API
- e `frontend-dev` ปุ่ม one-click ใน sidebar

**T-204 Status page** · `[ASK-HUMAN]` เปิดสาธารณะ, custom domain

- a `backend-dev` migration `status_component`, `status_post`, `status_maintenance`, `status_subscription` · publish จาก incident + public API
- b `frontend-dev` `/status`, ปิด = 404
- c `backend-dev` email double opt-in, unsubscribe, rate limit · mock: Mailpit

**T-205 Usage** · `[ASK-HUMAN]` product DB จริง, น้ำหนัก score

- a `backend-dev` migration `usage_metric_def`, `usage_metric_point` (partition, PK `(metric_id, ts, dims_hash)`, คอลัมน์ `org_id`) · `examples/metrics/*.sql` + seed `product_mock` มี anomaly
- b `backend-dev` scheduler ผ่าน `DataQueryClient`, upsert idempotent
- c `backend-dev` anomaly (ข้อมูล < 7 วันไม่ fire) → alert + ticket `internal`, dedupe + เพดานต่อรอบ · draft ผ่าน T-108
- d `backend-dev` migration `org_health_snapshot(org_id, day, score, components, formula_version)` · ข้อมูลไม่พอแสดง "ไม่พอ" (N5)

**T-206 Dashboard**

- a `ux-designer` spec (`dataviz` ก่อนเขียน chart)
- b `backend-dev` read model §9.1
- c `frontend-dev` SVG ใน `packages/ui` ไม่เพิ่ม dependency
- d `frontend-dev` alert, incident, service admin

**T-207** `qa-engineer` e2e AC-3 (2 s), AC-5, §5.3 + assert ไม่มี network ออก → `security-reviewer` → `po` → `/handoff`

## D. Waves (≤ 3 worktree)

- W0: merge T-108 → T-109 → T-105 → ADR → T-200 · T-113/T-114 ถ้าโควตาพอ ไม่งั้นรวมใน T-207
- W1: T-201a–c ∥ T-203a–b ∥ T-202a
- W2: T-201d + T-202b (agent เดียว) ∥ T-203c–d + T-202d ∥ T-205a
- W3: T-201e + T-202c ∥ T-204a,c ∥ T-205b–d
- W4: T-206a → T-206b ∥ T-206d + T-204b + T-203e ∥ T-206c
- W5: T-207

จุดชน: `rbac.ts`, `.env.example` (T-200 เท่านั้น) · `shared/features/index.ts`, `db/schema/index.ts`, `processors/index.ts`, `schedules.ts`, `features.module.ts`, `public-routes`, `PARTITIONED_TABLES`, `domain/index.ts` (แก้ตอน merge) · `messages/*` แยก namespace · e2e port แยก

## E. Scope cuts

ตัด: live adapter · Pub/Sub emulator · external MCP · log sink · correlation editor (ใช้ API + seed) · postmortem เหลือ field · session sample drill-down · ผล tool ฉบับเต็ม (เก็บ excerpt + hash) · LINE subscription, private page · weekly noisy report · §9.1 ส่วนที่ต้องมี grader

เสร็จ = AC-3, AC-5 ผ่านบน fake **ไม่ใช่ exit ของ Phase 2** เพราะ "first incident" ต้องใช้คนจริง

ขึ้นกับ Phase 1: T-108 บล็อก T-203b, T-205c · T-109 บล็อก T-203e · T-105 ช้าได้ · T-122f F-1 ต้องปิดก่อน mass comms บน LINE จริง

## F. N1–N10 เฉพาะ phase นี้

- N2: `connectors` ไม่มี method เขียน · budget เดียวต่อ project · ทุก run ลง `tool_execution` · scheduler ใช้ guardrail เดียวกัน
- N3: status post, mass comms, proactive notice เป็น draft · เผยแพร่ต้องคนกด + test
- N4: fixture log ใส่ PII ปลอม พิสูจน์ `redactToolOutput` · `alert.payload` เก็บ key allow-list · params เก็บ HMAC · Discord ห้ามชื่อ org/เนื้อความลูกค้า
- Metrics: รับเฉพาะ dims ที่ประกาศ · ค่า dim ผ่าน redactor · bind parameter · แก้ template = head + audit
- Status page: DTO allow-list ไม่มี orgs, commander, root cause · เฉพาะ `public=true` + post ที่ publish
- Health Score: ตารางแยก · client role ไม่เห็นทุก route (test) · ไม่มี benchmark ข้าม org · กรอง `org_id` ด้วย `orgScopeCondition`

## G. ADR ที่ต้องเขียน

1 Alert ingest + escalation clock · 2 Discord bot + identity map · 3 `packages/connectors` แก้ matrix ADR-002 + shared budget + partition `tool_execution` · 4 Data query + usage + Health Score v1 · 5 Status page boundary

## H. ยังไม่ยืนยัน

T1/T2, 55/30, น้ำหนัก score `[ASSUMED]` · payload GCP `[VERIFY]` · Google managed MCP เลื่อนไป T-208 `[ASSUMED]`
