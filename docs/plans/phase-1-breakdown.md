# Phase 1 breakdown — ร่างโดย `architect` 2026-11-01 (รอ `po` ตรวจ scope ใน T-011)

> สถานะ: **ร่าง** · ทุกเลข migration, permission, retention, timeout ที่เสนอเป็น `[ASSUMED]` · main thread เป็นผู้ย้ายข้อที่ตกลงแล้วเข้า `docs/BACKLOG.md`
> ที่มา: อ่าน AGENTS, HANDOFF, BACKLOG, START-HERE, PRD §4.1–4.2, 4.4, 4.7, 4.9–4.10, 5.1–5.2, 6, 7, 8, 11, 12, `docs/04-ARCHITECTURE.md`, ADR-004/006, config, UI spec และโค้ดจุดชน (`migrator.ts`, `app.module.ts`, `worker.ts`, `shared/index.ts`, `rbac.ts`, `tickets.service.ts`)

## A. ข้อเท็จจริงที่มีผลต่อการทำงานขนาน (อ่านจากโค้ด)
- `migrator.ts` ยอมให้เลขเว้นช่องได้ แต่ห้ามเลขซ้ำ และ**ปฏิเสธ migration ที่เลขต่ำกว่าตัวล่าสุดที่ apply แล้ว** → การจองเลขอย่างเดียวไม่พอ main thread ต้องเรียงเลขตอน merge
- `tickets.service.ts` ผูกกับ Nest DI ทั้งหมดใน `apps/api` · worker import api ไม่ได้ จึงสร้าง ticket จากข้อความขาเข้าไม่ได้
- `PERMISSIONS` ที่ยังขาด `[ASSUMED]`: `inbound.read`, `outbox.manage`, `view.share`, `ai.emergency_switch`, `shift.note.write`, `handoff.ack`, `csat.read`, `ai.run.read`
- `channel_account.config_encrypted` มีแต่ยังไม่มีใครใช้ · `PARTITIONED_TABLES` อยู่ `apps/worker/src/processors/maintenance.ts`

## B. จุดชนไฟล์และวิธีกัน → T-123 scaffolding (wave 0, agent เดียว)
1. **Migrations** จองเลข: 0004 T-007 · 0005 T-123 · 0006 T-116 · 0007 T-122 · 0008 T-102 · 0009 T-103 · 0010 T-104 · 0011 T-106 · 0012 T-107 · 0013 T-105 · 0014 T-108 · 0015 T-110 · 0016 T-111 · 0017 T-112 · 0018 T-119 · 0019 T-121 · 0020 T-117 · main thread เปลี่ยนชื่อไฟล์ตอน merge ถ้าเลขต่ำกว่าตัวสูงสุดบน `main` (checksum คิดจากเนื้อไฟล์) · ห้ามแตะ `migrations/meta/`
2. **`packages/shared/src/index.ts`**: สร้างไฟล์ต่อ feature พร้อม export ไว้ก่อน (`inbound, outbound, gmail, line, discord, notifications, ai, kb, csat, shifts, autonomy, credentials, views`) · `AUDIT_ACTIONS`, `TICKET_EVENT_TYPES`, `QUEUE_NAMES` ประกอบจากไฟล์ของแต่ละ feature · `PERMISSIONS` ใส่ทั้งชุดใน 0005 (`po` ตรวจ matrix)
3. **`apps/api/src/app.module.ts`**: module เปล่าของทุก feature import ไว้ก่อน · `bootstrap.ts` เปิด `rawBody` (LINE/Discord) · public routes แยกเป็น `public-routes.ts` ต่อ module
4. **`apps/worker/src/worker.ts`**: registry `processors/index.ts` + `schedules.ts`
5. **i18n**: แยก `messages/{en,th}/<namespace>.ts` + test ว่า key สองภาษาตรงกัน · หลัง T-120 merge (T-123b `frontend-dev`)
6. **`.env.example` + config Zod**: เพิ่มตัวแปร Phase 1 ทั้งหมดครั้งเดียว ค่าว่าง = mock
7. `db/src/schema/index.ts` ใช้ไฟล์ schema ต่อ feature · `docker-compose.yml` แตะได้แค่ T-102 แล้ว T-118 · `composer.tsx` เจ้าของเดียว T-109c · `docs/04-ARCHITECTURE.md` main thread เท่านั้น
8. integration test ใช้ Postgres ร่วมกันได้ (DB ต่อไฟล์) · **e2e และ `pnpm dev` ใช้ port ตายตัว → รันทีละ worktree หรือตั้ง `E2E_PORT` ต่างกัน**

## C. ที่อยู่ของโค้ดสร้าง ticket จากข้อความขาเข้า → ต้องมี ADR (N10, แก้ ADR-002 matrix)
- **ตัวรับ webhook อยู่ `apps/api`** (บาง): ตรวจ signature/OIDC → เขียน `inbound_event` (unique `(channel_account_id, provider_event_id)`) + outbox ใน tx เดียว → ตอบ 200 ทันที
- **orchestration อยู่ `apps/worker/src/ingest/`**: adapter (`packages/channels`) → raw ลง S3 → classifier (`packages/ai`) timeout 3 s `[ASSUMED]` ไม่ทันใช้ rule fallback → domain
- **logic เขียน ticket อยู่ workspace ใหม่ `packages/domain`** (deps: `db`, `shared` เท่านั้น): create/append/reopen, resolve contact/org, ticket keys, SLA, audit, outbox, policy gate · คืน `RealtimeEvent[]` ให้ผู้เรียก publish · ใช้ทั้ง api และ worker
- ตาราง `inbound_message` (disposition `pending|ticket|appended|noise|auto_reply|internal`) = ที่มาของ "Other mail"
- ทางเลือกที่ตัด: worker เรียก api ผ่าน HTTP ภายใน · api เป็น BullMQ consumer · ยัดใน `packages/db`
- เงื่อนไขของ T-122b: integration test เดิมของ api ต้องผ่านโดยไม่แก้ test

## D. Breakdown (owner · ต้องรอ)
- **T-123** a `backend-dev` B1–B4, B6–B7 + 0005 + helper `disableNetConnect` (รอ T-007) · b `frontend-dev` B5 (รอ T-120)
- **T-122 ingest/outbound core** a `architect` ADR · b `backend-dev` `packages/domain` ย้าย logic จาก api (รอ a) · c 0007 `inbound_event`/`inbound_message` + `domain.ingestInbound` (dedupe, thread match R-2.3, noise rule) + queue `ingest` + fake channel (รอ b) · d outbound dispatcher at-most-once ถึงลูกค้า + undo-send 5 s + endpoint ยกเลิก + ADR outbound (รอ c)
- **T-116** a 0006 `integration_credential` (AES-256-GCM, wrapped DEK, `key_version`), env ชนะ, ไม่คืนค่าลับผ่าน HTTP, audit, CLI rotate · b test-connection ต่อ adapter (mock; live `[ASK-HUMAN]`) · c admin UI (§12)
- **T-102 Gmail** a `channels/src/gmail/` transport + fake + MIME normalizer (ไทย, inline image, sanitize) + auto-reply/bounce + thread keys (ไม่ต้องรอ) · b push receiver (Pub/Sub OIDC; mock = emulator) + compose `pubsub` profile · c history sync, 404 → full sync, renew watch, heartbeat R-2.8, attachments → S3 · d ส่ง in-thread ผ่าน dispatcher · e 0008 grant `UPDATE(external_id, thread_key)` + state ต่อ account · b–e รอ T-122c, T-112a, T-116a (live)
- **T-103 LINE** a `channels/src/line/` signature, normalize, transport+fake (reply token 60 s, quota), router reply-vs-push (ไม่ต้องรอ) · b webhook raw body + dedupe `webhookEventId` · c media → S3, auto-ack ด้วย reply token ตรงจาก ingest job (เป้า 5 s AC-2), quota counter · d identity: contact `unverified`, link code, LINE Login (fake IdP) · e mark-as-read/rich menu หลัง flag ปิด (po #5) · f ตรวจราคา LINE จากเอกสารทางการ (po #20) · 0009
- **T-104 Discord** a webhook + rate-limit bucket + fake · b interactions endpoint Ed25519, deferred ack < 3 s, `/ack` · c fan-out ตาม channel map (po #6) · 0010
- **T-106 AI core** a ADR AI layer + ports (`LlmProvider`, `EmbeddingProvider`, `AiRunSink`, `ToolRegistry`, `SettingsSource`) + `shared/ai.ts` (ปลดบล็อก T-107/T-108) · b provider mock deterministic / anthropic / vertex ผ่าน Vercel AI SDK, ฉีด `fetch` เล่น fixture · c PII redaction (เลขบัตรประชาชนไทย checksum, phone, email, ชื่อจาก dictionary) + mapping + branded type `RedactedText` ให้ compiler บังคับ N4 · d 0011 `ai_run` partition + immutable + recorder + cost/day caps + เตือน 80% + kill switch · e classifier (stage 0) + summarizer, prompts versioned · f API settings ของ provider (secret ผ่าน T-116)
- **T-107 KB** a 0012 article/version/chunk/`embedding_index` · b chunker + embedding job · c hybrid search trgm + vector + RRF · d crawler ใช้ fixture เท่านั้น · e UI ขั้นต่ำ
- **T-108** a tools `kb_search`, `similar_tickets`, `org_context` + stub GCP Logs/BigQuery/repo จาก `examples/` + 0014 `tool_execution` + rate budget + role DB `watchtower_ai_ro` SELECT บน view allow-list (N2) · b investigator → report + evidence · c drafter: citations, disclosure, ภาษาลูกค้า, `ai_draft` A/E/R, edit distance, reason codes 9 รหัส · d job async (p95 < 120 s) + progress event
- **T-109** `frontend-dev` a AI sidebar/evidence/draft A/E/R · b Other mail + convert · c composer (Send via, upload presigned, undo 5 s, LINE quota, แทรก draft) · d autonomy badge + emergency switch UI
- **T-105** a 0013 `notification` + prefs + event มี queue/channel/org · b focus digest · c Web Push (mock เท่านั้น ดู F) · d notification center, P1 banner, เสียง
- **T-110** a 0015 `csat_survey` + scheduler · b token ใช้ครั้งเดียว + landing · c ส่งทาง LINE เมื่อ quota ≥ 10% · d reopen R-1.10 ใน domain
- **T-111** a 0016 schema + seed po #7 · b clock in/out + handoff gate AC-7 + lead override · c handoff prefill + ack ทีละ item · d daily brief · e assignment เฉพาะคน clock-in / load / stay-with-last + endpoint รายชื่อ assignee + SLA business time · f หน้าจอ §9
- **T-112** a 0017 ประวัติ stage + pin + สอง switch (po #23) + DB CHECK stage ≤ 2 ใน Phase 1 + policy gate (auto-ack template ปลอดภัยเท่านั้น) — ทำก่อน auto-ack ของ T-102/T-103 · b พฤติกรรม stage 0/1/2 + test พิสูจน์ว่าไม่มีทางส่ง AI ถึงลูกค้าโดยไม่มีคนอนุมัติ (N3)
- **T-117** `processors/cleanup.ts` + index `expires_at` (0020) + outbox magic link หมดอายุตาม TTL
- **T-118** a ADR deploy GCP · b `infra/terraform/` skeleton **ไม่ apply** · c runbook staging · d worker health บน `$PORT`
- **T-119** a 0018 saved views server + filter + sort · b bulk + audit · c linked dup/related · d bulk bar
- **T-121** a outbox dead-letter API/UI · b org_tier CRUD · c seed production เฉพาะข้อมูลอ้างอิง · d placeholder i18n จาก prefix จริง · 0019
- **T-113** e2e AC-1, AC-2, AC-4, AC-7, §5.1, §5.2 + assert ว่า mock ไม่ยิง network · **T-114** security · **T-115 STOP `[ASK-HUMAN]`**

## E. Mock / contract test
- ทุก adapter มี transport interface สองตัว (fake ในหน่วยความจำ, live) · contract test ชุดเดียวรันกับ fake เสมอ, กับ live เฉพาะ `CONTRACT_LIVE=1` (`[ASK-HUMAN]`)
- fixture สังเคราะห์ด้วย `example.com` (N1) · LINE/Discord สร้าง secret/keypair ตอนรัน test · Pub/Sub emulator รองรับ push หรือไม่ `[VERIFY]` · Web Push = fake push server บนเครื่อง · AI mock เลือกคำตอบตาม (prompt id, input hash)

## F. ปลายทาง network ที่ต้องติดป้าย
1. **Web Push** — push service ของเจ้าของ browser ไม่อยู่ใน PRD §11 → Phase 1 mock เท่านั้น · live `[ASK-HUMAN]`
2. **KB crawl R-4.3** — URL ใดก็ได้ → fixture เท่านั้น · live `[ASK-HUMAN]` · กัน SSRF (RFC1918, link-local, metadata 169.254.169.254)
3. **Vercel AI SDK** — ไม่น่ามี telemetry ส่งออกเอง `[UNVERIFIED 75%]` · ปิด `experimental_telemetry`
4. **google-auth-library ADC** probe metadata server → mock ต้องไม่สร้าง client
5. **Embedding** นอก Vertex/Anthropic หรือ model ดาวน์โหลด = `[ASK-HUMAN]`
6. **สแกน attachment** ClamAV (`database.clamav.net`) = `[ASK-HUMAN]` → เลื่อน
7. **Dev-time** `terraform init` ต้องดาวน์โหลด registry → ทำแค่ `fmt` หรือ `[ASK-HUMAN]`
8. egress allow-list ที่อยู่ใน PRD แล้ว: `api.line.me`, `api-data.line.me`, `access.line.me`, `gmail/oauth2/pubsub.googleapis.com`, Google certs, `discord.com`

## G. ADR ที่ต้องเขียน
1 ingestion + `packages/domain` + `inbound_message` · 2 outbound delivery (at-most-once, undo-send, reply-vs-push, quota) · 3 Gmail access + Pub/Sub auth · 4 AI layer · 5 KB storage/retrieval · 6 autonomy policy gate + emergency switches · 7 contact identity linking · 8 notifications + Web Push egress · 9 GCP deployment (T-118) · 10 แก้ ADR-004 (`integration_credential`, key rotation)

## H. Waves
- **W0** (ปิด Phase 0): T-007 → T-123a · T-120 → T-123b · ADR G1, G2, G4 · T-009–T-012
- **W1** (worktree ละงาน): T-122b→c · T-116a · T-102a ∥ T-103a ∥ T-104a · T-106a→b→c · T-117 · T-118 · T-121a–c
- **W2**: T-112a ก่อน → T-122d · T-102b–e ∥ T-103b–e · T-104b–c · T-106d–f · T-107a–c · T-105a–c · T-111a,b,e · T-119a–c · T-110a,d
- **W3**: T-108 · T-112b · T-111c–d · T-110b–c · frontend สองสาย: (i) T-109 + T-105d · (ii) T-111f + T-116c + T-119d + T-121a/d + T-107e
- **W4**: T-113 → T-114 → แก้ P0/P1 → **T-115 STOP**

## I. ส่งต่อ `po`
- AC-4 ครึ่งหลัง (resolve ไม่มี citation → draft article ใน 5 นาที) คือ R-4.4 ที่ BACKLOG วางไว้ T-302 แต่ exit ของ Phase 1 ต้องผ่าน AC-4 → ตัด AC-4 ใน Phase 1 เหลือ search+citation หรือเพิ่ม KB-author ขั้นต่ำใน T-108
- เป้า 5 s ของ AC-2 ผ่าน relay ที่ poll 1 s ทันไหม `[UNVERIFIED 70%]` → วัดใน T-113
- รองรับหลายกล่องเมล (po #4) ต้องมี T-116a ก่อน
