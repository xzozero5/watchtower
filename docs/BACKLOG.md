# BACKLOG — เรียงตามลำดับที่ควรทำ

สัญลักษณ์: `[ ]` ยังไม่ทำ · `[~]` กำลังทำ · `[x]` เสร็จ (DoD ผ่าน + STATUS อัปเดต) · `∥` ทำขนานกับงานอื่นได้ · agent = ผู้รับผิดชอบหลัก
ทุก task ต้องผ่าน DoD ใน `docs/00-START-HERE.md` · อ้าง requirement ด้วย `R-x.y`/`AC-x` จาก `docs/01-PRD.md`

## Phase 0 — Foundation (เป้า: 2–3 วันทำงานของ AI)
- [x] T-000 **main thread ทำก่อนอื่น** — `git init` (ถ้ายังไม่มี), ตรวจ `.gitignore` ครอบ `.env*`, `node_modules`, `dist`, `*.local`, `logs/` (ยกเว้น `logs/daily/`), เปิด hook `git config core.hooksPath tools/githooks`, commit แผนทั้งหมด `docs: แผน Watchtower + AGENTS/CLAUDE + agents` — remote/push `[ASK-HUMAN]` ข้อ 1
- [x] T-001 `architect` ยืนยัน ADR-001 กับโครงจริง, สร้างโครง monorepo (pnpm-workspace, turbo.json, tsconfig base, eslint/prettier shared), ร่าง `docs/04-ARCHITECTURE.md` (module map, boundary rules: `apps/*` ห้าม import ข้ามกันตรง ๆ, `packages/ai` ห้ามรู้จัก HTTP, `packages/channels` ห้ามรู้จัก DB), ESLint `no-restricted-imports` บังคับ boundary
- [x] T-002 `backend-dev` ∥ `apps/api` NestJS โครง (health, config module อ่าน env + validate ด้วย Zod, OpenAPI ที่ `/docs`, structured logger, OpenTelemetry), `packages/db` Drizzle + migration runner + `docker-compose.yml` (postgres+pgvector, redis, minio, api, worker, web, caddy) + `.env.example` — `docker compose up` แล้ว `GET /health` ตอบ
- [x] T-003 `frontend-dev` ∥ `apps/web` Next.js + Tailwind + shadcn/ui + design tokens เริ่มต้น (light/dark ตาม OS, density, severity ไม่ใช้สีอย่างเดียว) + layout three-pane เปล่า + ⌘K palette stub + Vitest/RTL + Playwright smoke
- [x] T-004 `backend-dev` auth: Google OIDC (domain restricted) + magic link สำหรับ client + break-glass local admin; session JWT/refresh; **RBAC** roles + permission strings ตาม PRD §2.2; **audit log** interceptor ทุก mutation (PRD §8.2); unit tests
- [x] T-005 `backend-dev` schema + modules: `organization`, `contact`, `user`, `sla_policy`, `business_calendar`, `intent` (seed starter taxonomy PRD §3.1 เป็น `examples/intents/`), `ticket`, `message`, `ticket_event` — status workflow R-1.2, SLA due calc R-1.6 (Bangkok calendar), assignment R-1.7 (manual + round-robin), merge R-1.5 (แบบง่าย), full-text search R-1.8; REST + WS events; integration tests กับ Postgres จริงใน compose
- [x] T-013 `backend-dev` follow-up จาก review T-005 (ทำก่อน T-007): audit `contact.create` ใน `findOrCreateByEmail` + audit/event ของ child ที่ย้ายตอน merge + test audit ของ assign/merge · `@AuditPiiRead` บน `GET /v1/tickets` · `q` ขั้นต่ำ 2–3 ตัว · ลบ queue/contact ที่ยังถูกอ้าง → 409 · migration `0003`: column-level grant ของ `message` (ไม่มี DELETE), index FK ที่ขาด · ADR outbox (at-least-once ของ after-commit enqueue, PRD §8.3) · `OPS-` prefix และ tier เป็น config/data แทน constant/CHECK `[ASSUMED]`
- [x] T-120 `frontend-dev` follow-up จาก review T-006 (ทำก่อน T-011): **ปุ่มปิด/เปลี่ยน single-key shortcut ใน preferences (WCAG 2.1.4, P1)** · ล้าง query cache + draft ตอน session หมดอายุเหมือน sign out และผูก query key กับ user (P2) · keyboard map กรองตาม permission · F6/Alt+1..3, `[`/`]`, g+key, Enter/O · tabs ที่ < 768 px · throttle live region ของ pill · rename status copy key เป็น camelCase · `aria-selected` ใน queue row — ยังไม่ทำ: remap shortcut (ทำได้แค่ปิด), `g o/b/h/n` (หน้ายังไม่มี)
- [ ] T-121 `backend-dev` + `frontend-dev` ops/admin: หน้า/endpoint ให้ head ดูและส่งซ้ำแถว `dead` ของ outbox + health check อายุแถว pending เก่าสุด (PRD §8.3 dead-letter visible to head) · API/UI จัดการ `org_tier` · seed `--allow-production` ใส่ได้เฉพาะข้อมูลอ้างอิง (ไม่สร้าง ticket/audit ปลอม) · placeholder `OPS-12` ใน i18n อ่านจาก prefix จริง — จาก review T-013
- [x] T-124 `frontend-dev` UI refresh ตามคำขอเจ้าของ 2026-11-01 ("ดู AI เกินไป" → ศึกษา 21st.dev): ทำตาม `docs/design/ui-refresh-2026-11.md` — nav rail + user menu, ไม่มี card/หัว UPPERCASE, properties panel แบบ inline combobox, queue row มี avatar, timeline bubble, composer กล่องเดียว · ใช้แค่แรงบันดาลใจ ไม่คัดลอกโค้ด (license) · ทำหลัง T-120 merge · ส่ง screenshot ให้เจ้าของ · ค้าง (ต้องมี API): snippet + read-state ใน queue, ticket เก่าในแท็บ Customer → T-119
- [x] T-006 `frontend-dev` three-pane จริง: queue (filters/saved views, J/K, "N new" pill), conversation timeline (public/internal, composer with templates), AI sidebar placeholder; ticket detail/edit; keyboard map `?`; realtime ผ่าน WS — ทดสอบกับ API จำลองเท่านั้น full-stack ที่ T-009 `[UNVERIFIED]`
- [x] T-007 `backend-dev` + `frontend-dev` portal channel (PRD §4.9 P0): public submit form (+ human-verification), confirmation email ผ่าน SMTP adapter (local = Mailpit ใน compose), tracking page ด้วย signed token, reply จาก portal เข้า timeline; email update เมื่อ public reply/status เปลี่ยน; แจ้งลูกค้าของ ticket ที่ถูก merge ว่า ticket หลักคือเลขใด (R-1.5) · human verification แบบ self-hosted (PoW + honeypot + rate limit) หลัง `HumanVerificationProvider` + ADR ก่อนเขียนโค้ด (UI spec §10, §17 Q5) · map status เป็นคำของลูกค้า ใช้ทั้ง portal และ client ใน workspace (review T-006)
- [x] T-008 `backend-dev` seed script: 3 orgs (tiers), contacts, 2 staff ทุก role, SLA policies, intents, 30 tickets ตัวอย่างหลายสถานะ, business calendar + วันหยุดไทย 2026–2027 จาก `examples/calendars/` (ข้อมูลตัวอย่าง `[VERIFY]` โหลดเฉพาะ seed dev, production เริ่มว่าง — po 2026-11-01 `[ASSUMED]`)
- [ ] T-009 `qa-engineer` e2e **AC-1 (portal path)**: submit → ticket พร้อม org/intent/SLA due ภายใน 10 s → agent reply → ลูกค้าเห็นใน tracking page → resolve → status email; e2e RBAC (client เห็นเฉพาะ org ตัวเอง)
- [~] T-010 `security-reviewer` review auth/session/RBAC/audit/secret handling/`.env`/compose exposure/webhook token design; findings → แก้ P0/P1 ก่อนปิด phase · จาก review T-013: ความลับของ magic link อยู่ใน `outbox.payload` ระหว่าง pending (หลุดกับ `pg_dump` ได้) · outbox row ต้องหมดอายุตาม TTL ของ magic link (relay retry ได้ ~2.5 ชม.) · ย้าย `bullmq` ใน api เป็น devDependency · ตรวจ ADR-006 · review 2026-11-01: P1 C-1 (dev-login + placeholder secrets), C-2 (secret ใน outbox) + P2/P3 C-3…C-14 → กำลังแก้ใน `wip/t-010-fixes` · checklist `docs/09-SECURITY.md`
- [ ] T-011 `po` review Phase 0 กับ PRD §15 exit criteria + N1–N10; เสนอปรับ BACKLOG Phase 1
- [ ] T-012 main thread `/handoff`, `CHANGELOG.md` 0.0.1 · tag `v0.0.1` **หลังเจ้าของตรวจ compose + integration + e2e บนเครื่องตัวเอง** `[ASK-HUMAN]`

## Phase 1 — Inbox + AI stage 0–2 + Shifts (เป้า: 3–5 สัปดาห์) — แตก task ละเอียดตอนจบ Phase 0 โดย `po` + `architect`
- [x] T-101 `ux-designer` `docs/06-UI-SPEC.md`: three-pane spec, AI sidebar (report/evidence/draft A-E-R + reason codes), alert discipline, focus mode, shift brief/handoff screens, portal, copy TH/EN — เขียนล่วงหน้าตอน Phase 0 (2026-11-01), คำถาม §17 ตัดสินโดย `po` `[ASSUMED]`
- [ ] T-102 `integration-engineer` ∥ Gmail adapter: watch + daily renew, Pub/Sub push receiver (local = Pub/Sub emulator), history sync + 404 full sync, dedupe, thread matching, send in-thread, attachments → MinIO, auto-reply/noise detection, heartbeat (R-2.1–2.8); contract tests ด้วย recorded fixtures · composer "Send via" + แนบไฟล์ + undo-send ฝั่ง server (review T-006, UI spec §17 Q1) · migration ใหม่ grant `UPDATE(external_id, thread_key)` บน `message` + consumer idempotent ตาม ADR-006
- [ ] T-103 `integration-engineer` ∥ LINE adapter: webhook + signature + redelivery dedupe, reply-token vs push router + quota counter, identity link (LINE Login / link code), media download, mark-as-read `[VERIFY]`, rich menu config (R-2.9–2.14)
- [ ] T-104 `integration-engineer` Discord: webhook notify channels + bot (ack button, `/ack`), rate-limit handling (R-3.17)
- [ ] T-105 `backend-dev` notifications: in-app realtime, Web Push (VAPID), focus mode batching, per-user prefs (R-3.16) · event realtime มี queue/channel/org เพื่อให้ pill "N new" นับตาม filter · P1 sticky banner (review T-006)
- [ ] T-106 `ai-engineer` `packages/ai`: provider abstraction (Anthropic/Vertex), model tiers, PII redaction, tool registry + per-intent allow-list, `ai_run` audit, cost metering; classifier (stage 0) + summarizer; prompts versioned ใน `packages/ai/prompts/`
- [ ] T-107 `backend-dev` KB: articles + versions + visibility, pgvector chunks/embeddings, hybrid search, external URL crawl (R-4.1–4.3)
- [ ] T-108 `ai-engineer` + `backend-dev` investigator: runbook per intent → KB search, similar tickets, org context, **read-only tool stubs** (GCP Logs, BigQuery, repo — mock mode ก่อนมี credential), evidence cards, investigation report; drafter + `ai_draft` A/E/R + diff/edit-distance (R-5.1–5.3 mock, §6.2, §6.5 ข้อ 1)
- [ ] T-109 `frontend-dev` AI sidebar จริง + evidence cards + draft A/E/R + reason codes; "Other mail" view; LINE quota indicator
- [ ] T-110 `backend-dev` CSAT (R-10.1–10.5) + reopen rules (R-1.10)
- [ ] T-111 `backend-dev` + `frontend-dev` shifts (+ round-robin เลือกเฉพาะคนที่ clock-in, R-1.7 load-balanced / stay-with-last-handler): definitions, roster, clock in/out, shift notes, structured handoff + acknowledgment, daily brief (AI summarizer) (R-7.1, 7.3–7.8) · endpoint รายชื่อ assignee สำหรับ agent ที่ไม่มี `user.read` · server ส่งเวลาที่เหลือของ SLA แบบ business time · seed กะตาม po #7 (08–17, 13–22, on-call 22–08)
- [ ] T-112 `ai-engineer` autonomy stage model per intent (0–2 เท่านั้นใน phase นี้) + emergency switch (§6.4)
- [ ] T-113 `qa-engineer` e2e AC-2, AC-4, AC-7 + scenario §5.1, §5.2 ด้วย mock adapters
- [ ] T-114 `security-reviewer` channels (signature, token storage), AI (redaction, allow-list, audit)
- [ ] T-115 `po` review + `[ASK-HUMAN]` ต่อ credential จริงครั้งแรก → pilot กับทีมจริง 1 สัปดาห์
- [ ] T-116 `backend-dev` + `frontend-dev` credential store + หน้า admin ของ integration ตาม ADR-004 (ทำก่อน T-115): `head` เท่านั้น, อ่านกลับไม่ได้, envelope encryption, audit, ปุ่มทดสอบ, environment ชนะ DB, วิธีหมุนกุญแจ
- [ ] T-117 `backend-dev` job ใน worker ลบ session, refresh token, magic-link token ที่หมดอายุ (จาก ADR-005)
- [ ] T-118 `architect` + `backend-dev` ADR deploy บน GCP + IaC skeleton + runbook staging (public HTTPS endpoint สำหรับ Gmail Pub/Sub push และ LINE webhook) — **ไม่ apply / ไม่สร้าง resource จริง** (`[ASK-HUMAN]` credential + เงิน) · ทำก่อน T-115 (po 2026-11-01 `[ASSUMED]`)
- [ ] T-119 `backend-dev` + `frontend-dev` bulk actions + saved views ฝั่ง server (R-1.8), linked tickets แบบ duplicate/related (R-1.1) — จาก review T-005 · view SLA at risk / Triage / Waiting on customer + server filter, sort ตาม SLA, ปุ่ม merge ใน bulk bar

## Phase 2 — Reliability + Usage — แตก task ตอนจบ Phase 1
- [ ] T-201 GCP Monitoring/Logging ingest via Pub/Sub, fingerprint dedup, correlation rules, service catalog, escalation chain, snooze/heartbeat, noise metrics (R-3.1–3.11)
- [ ] T-202 Incident mgmt + Discord thread + mass comms + "what changed" (R-3.12–3.15, R-5.3–5.4)
- [ ] T-203 Investigation tools จริง: Logs rate budget, BigQuery/EXTERNAL_QUERY guardrails, metrics tool, service status panel (R-5.1–5.7)
- [ ] T-204 Status page + subscriptions (R-6.x)
- [ ] T-205 Usage metric definitions + scheduler + anomaly → proactive ticket + Client Health Score (R-8.x)
- [ ] T-206 Ops dashboard (§9.1) — ใช้ skill `dataviz` ก่อนเขียน chart
- [ ] T-207 QA/security/po review + `/handoff`

## Phase 3 — Autonomy + Learning — แตก task ตอนจบ Phase 2
- [ ] T-301 Grader + verified/contained/assumed resolution (§6.2, §6.4)
- [ ] T-302 Eval set + replay runner + golden answers + KB author (§6.5, R-4.4–4.6)
- [ ] T-303 Procedures (natural-language → steps) + simulation (§6.3)
- [ ] T-304 Stage 3 gating + auto-rollback + "ready for promotion" report
- [ ] T-305 CEO view + AI weekly brief + exports (§9.2), cost dashboard, roster planner (R-7.2)
- [ ] T-306 Review + pilot stage 3 กับ 2–3 intent

## Post-MVP / Phase 4
- React Native app, org-private status page, LINE group chat (R-2.15), Helm chart, additional channels, Terraform ฉบับสมบูรณ์ (ADR deploy ย้ายไป T-118), generic OIDC issuer ผ่าน discovery สำหรับองค์กรที่ไม่ใช้ Google (po 2026-11-01 `[ASSUMED]`)
