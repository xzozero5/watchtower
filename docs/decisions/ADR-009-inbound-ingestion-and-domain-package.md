# ADR-009 — Inbound ingestion (webhook บางใน api → orchestration ใน worker) และ workspace ใหม่ `packages/domain` (T-122a)

- **Status:** Proposed
- **Date:** 2026-11-01 (เวลากรุงเทพ) · **ผู้ตัดสิน:** main thread (ร่างโดย `architect`) · แก้ matrix ของ ADR-002 (N10) จึงต้อง Accepted ก่อนเริ่ม T-122b
- **Context:**
  - PRD §4.2 (R-2.1–2.3, R-2.6–2.7, R-2.9, R-2.12), §5.1–5.2 และ §8.3 ต้องการให้ตอบ webhook 200 เร็ว, ประมวลผลแบบ async, ingestion แบบ at-least-once พร้อม idempotency key, ข้อความ noise ไม่สร้าง ticket แต่ต้องเห็นใน "Other mail", และเมื่อ LLM ล่มต้องใช้ rule fallback
  - ทุกวันนี้ logic เขียน ticket อยู่ใน `apps/api/src/tickets/tickets.service.ts` (1,070 บรรทัด) ซึ่งผูกกับ Nest DI (`AuditService`, `ContactsService`, `SlaService`, `WorkflowService`, `AssignmentService`, `TICKET_KEYS`, `PortalNotifier`) `[TESTED: อ่านโค้ด 2026-11-01]` · worker import api ไม่ได้ (ADR-002) จึงสร้าง ticket จากข้อความขาเข้าไม่ได้ (`docs/plans/phase-1-breakdown.md` §A, §C) · `docs/04-ARCHITECTURE.md` §9 เปิดเรื่องนี้ไว้ให้ "แยก `packages/domain` ด้วย ADR ใหม่"
  - ADR-006: api ไม่ต่อ BullMQ/Redis เพื่อใช้คิว และงานเบื้องหลังอยู่ใน worker (Cloud Run ลด CPU ของ api ช่วงที่ไม่มี request)

## Decision

### 1. ตัวรับ webhook บางใน `apps/api/src/inbound/`
- route `@Public()` ต่อ channel (`POST /v1/inbound/line/:channelAccountId`, `POST /v1/inbound/gmail/push`) ลงทะเบียนใน `public-routes.ts` + allow-list ของ `routes-policy.test.ts` · จำกัดขนาด body + rate limit ต่อ IP
- **ตรวจก่อนเขียน:** LINE = HMAC-SHA256 ของ **raw body** (`rawBody` จาก T-123a) เทียบ `x-line-signature` ด้วย `timingSafeEqual` · Gmail = Pub/Sub push OIDC JWT (ตรวจ `aud`, `email` ของ service account, `iss`, อายุ) `[VERIFY]` กับเอกสารทางการตอน T-102b · ตรวจไม่ผ่าน → 401 ไม่เขียนอะไร ไม่ log body
- parse ด้วย Zod schema จาก `packages/channels` (เช่น `line.parseWebhook`) · LINE หนึ่ง request มีหลาย event → **หนึ่งแถวต่อ event**
- **transaction เดียว:** `INSERT inbound_event … ON CONFLICT (channel_account_id, provider_event_id) DO NOTHING` + outbox job `ingest` (`jobId = inbound_event.id`) → commit → 200 · เจอแถวซ้ำ (redelivery) → 200 โดยไม่ทำอะไร · `provider_event_id` = LINE `webhookEventId` / Pub/Sub `messageId`
- api ไม่เรียก provider, ไม่เรียก AI, ไม่เขียน S3 ใน request นี้ เป้าคือตอบภายในหลักร้อย ms (LINE คาดหวัง response เร็ว ค่าจริง `[VERIFY]`)

### 2. Orchestration ใน `apps/worker/src/ingest/` (consumer ของ queue `ingest` ใน `QUEUE_NAMES`)
1. โหลด `inbound_event` → adapter ใน `packages/channels` normalise (Gmail: `history.list` → ดึงข้อความ; 404 → full sync ตาม R-2.1) → ได้ข้อความ 0..n ฉบับ
2. raw payload และไฟล์แนบ → S3/MinIO (`raw/<channel>/<account>/<yyyy>/<mm>/<id>`) · LINE media ดึงทันที (R-2.12)
3. tx สั้น: upsert `inbound_message` (`disposition = pending`) unique `(channel_account_id, provider_message_id)` (Gmail message id; RFC `Message-ID` เป็นคีย์รองตาม R-2.2) · ล้าง `inbound_event.payload` เป็น `{}` หลังเก็บ raw ลง S3 แล้ว (แนวเดียวกับ ADR-006)
4. **นอก transaction:** classifier จาก `packages/ai` (redact PII ก่อนเสมอ N4, บันทึก `ai_run` ผ่าน port) timeout 3 s `[ASSUMED]` · หมดเวลา/ล่ม/kill switch → rule fallback (header auto-reply R-2.6, sender/list rule R-2.7, ไม่รู้ → `triage`) · ห้ามถือ DB transaction ระหว่างเรียก LLM
5. tx: `domain.ingestInbound(tx, ctx, { inboundMessageId, classification })` ล็อกแถว `inbound_message` (`FOR UPDATE`) ถ้า disposition ไม่ใช่ `pending` แล้ว = no-op (job ซ้ำปลอดภัย) → คืน `RealtimeEvent[]` → worker publish ลง Redis หลัง commit
- retry ของ BullMQ ทำซ้ำขั้นไหนก็ได้เพราะทุกขั้น idempotent · แถว `dead` ของ outbox/คิวเห็นได้ที่ T-121 (PRD §8.3)

### 3. Workspace ใหม่ `packages/domain` (`@watchtower/domain`)
- **deps:** `@watchtower/db`, `@watchtower/shared`, `drizzle-orm` เท่านั้น · **ห้าม** HTTP (`@nestjs/*`, `ws`, client HTTP, global `fetch`), Redis/BullMQ, `@watchtower/ai`, `@watchtower/channels`
- **เนื้อหา (เขียนเท่านั้น):** `tickets` (create/append/reopen R-1.10/update/status/assign/merge/reply/note), `contacts` (resolve contact/org จาก domain/อีเมล/LINE id, `unverified` R-2.11), `ticketKeys`, `sla` (ใช้ pure function ใน `shared/sla.ts` + โหลด policy/calendar), `workflow`, `assignment`, `audit.recordInTx`, `outbox.enqueue` (ย้ายตรรกะ seal secret จาก `OutboxService` มา ใช้ `@watchtower/shared/secret-box`), `inbound.ingestInbound` (dedupe, thread match R-2.3: Gmail `threadId` → `In-Reply-To`/`References` → token `[OPS-n]` ใน subject, noise rule), `outbound.*` (ADR-010)
- **policy gate hook:** domain ประกาศ interface `PolicyGate` และเรียกทุกครั้งก่อนสร้างงานส่งถึงลูกค้า · implement ที่ T-112a (ข้อมูลอยู่ DB จึง implement ใน domain ได้) · ไม่มี gate = ปฏิเสธ (fail closed)
- **รูปแบบ API:** ฟังก์ชันรับ `(tx: DbTransaction, ctx: DomainContext, input)` คืน `{ value, events: RealtimeEvent[], audited: boolean }` · `DomainContext = { actor, auditMeta: { ip, requestId }, now: () => Date, config: { ticketKeyPrefix, reopenWindowDays, sealKey }, policyGate }` · ไม่อ่าน `process.env` (12-factor: app เป็นคน validate config แล้วส่งเข้า)
- **error:** throw `DomainError` ที่มี `code` (`not_found`, `conflict`, `invalid_transition`, `merge_not_allowed`, `ticket_not_open`, `bad_request`) + `details` · api แปลงเป็น HTTP error เดิมด้วยตาราง map เดียว (body/status ต้องเหมือนเดิมทุกตัว) · worker แปลงเป็น retryable/unrecoverable
- **อ่านเพื่อแสดงผล** (`ticket-reader`, `timeline`, `message-view`, search) ยังอยู่ใน api `[ASSUMED]` ย้ายเมื่อมีผู้ใช้คนที่สอง

### 4. Nest DI ห่อ domain
- `apps/api/src/domain/domain.module.ts` (global) provide token `DOMAIN` ด้วย `useFactory: (config) => createDomain({ ticketKeyPrefix, sealKey: deriveSubkey(APP_ENCRYPTION_KEY, …), policyGate, now })`
- `TicketsService`, `ContactsService`, `OutboxService`, `EmailOutbox`, `PortalNotifier` **คง class และ method signature เดิม** แต่ข้างในเรียก domain: `const r = await this.domain.tickets.create(uow.tx, ctxFrom(cmd.actor), cmd); r.events.forEach((e) => uow.emit(e)); if (r.audited) AuditScope.set({ persisted: true }); return r.value` · `ctxFrom` อ่าน ip/requestId จาก `AuditScope` (AsyncLocalStorage อยู่ฝั่ง api เท่านั้น) · controller และ test ไม่ต้องรู้ว่ามี domain
- worker สร้าง `createDomain(...)` ครั้งเดียวตอน boot จาก config ของ worker (Zod) · `TICKET_KEY_PREFIX` และ `APP_ENCRYPTION_KEY` ต้องตรงกันทั้งสอง process — config test ของทั้งคู่ตรวจว่าประกาศตัวแปรเดียวกัน

### 5. ตาราง (migration ของ T-122c, เลขให้ main thread กำหนด)
- **`inbound_event`**: `id`, `channel_account_id` FK, `provider_event_id`, `received_at`, `payload jsonb` (ล้างหลังประมวลผล), `status` (`pending|processed|failed`), `error_code` · **UNIQUE `(channel_account_id, provider_event_id)`** · partial index `WHERE status = 'pending'` · ลบหลัง 7 วัน `[ASSUMED]` · ไม่ partition (unique ต้องไม่มี partition key — เหตุผลเดียวกับ `message` ใน `04-ARCHITECTURE` §7)
- **`inbound_message`**: `id`, `channel_account_id`, `inbound_event_id`, `provider_message_id`, `rfc822_message_id`, `thread_key`, `from_address`, `subject`, `received_at`, `raw_object_key`, `classification jsonb` (`type`, `intentKey`, `confidence`, `source: ai|rules`, `aiRunId`), **`disposition` CHECK `pending|ticket|appended|noise|auto_reply|internal`**, `ticket_id`/`message_id` FK nullable, `disposition_by`/`disposition_at`, `converted_from` · **UNIQUE `(channel_account_id, provider_message_id)`** · index `(disposition, received_at DESC) WHERE disposition IN ('noise','auto_reply','internal')` = ที่มาของ "Other mail" (T-109b) · index FK ทุกตัว · retention noise 90 วัน `[ASSUMED]`
- "This is a ticket" (UI spec §7): `domain.inbound.convert` เปลี่ยน `noise → ticket` + audit `inbound.converted` + classifier feedback · ทุกการเปลี่ยน disposition ลง `audit_log` ใน tx เดียว
- permission `inbound.read` (T-123a) สำหรับ "Other mail"

### 6. การเปลี่ยน boundary (ADR-002, `tools/eslint/boundaries.mjs`)
```js
// MODULE_GROUPS: แยก Redis ออกมาเป็นกลุ่มของตัวเอง; persistence = database ∪ redis เหมือนเดิม
redis: { label: 'Redis or BullMQ', modules: ['ioredis', 'redis', 'bullmq'] },
// WORKSPACES
'apps/api':        { allow: ['@watchtower/db', '@watchtower/domain', '@watchtower/ai', '@watchtower/channels', SHARED], forbid: [] },
'apps/worker':     { allow: ['@watchtower/db', '@watchtower/domain', '@watchtower/ai', '@watchtower/channels', SHARED], forbid: [] },
'packages/domain': { name: '@watchtower/domain', allow: ['@watchtower/db', SHARED], forbid: ['http', 'redis'], forbidHttpGlobals: true },
```
- `boundaryConfigs` เปลี่ยนเงื่อนไข `dir === 'packages/ai'` เป็น flag `forbidHttpGlobals` (ตั้งให้ทั้ง `ai` และ `domain`) และข้อความใช้ `${dir}`
- package อื่นทั้งหมด (`web`, `ui`, `shared`, `db`, `ai`, `channels`) **ห้าม** import `@watchtower/domain` (ได้อัตโนมัติจาก allow-list)
- `boundaries.test.mjs` เพิ่มเคส: domain → `@watchtower/ai`/`@watchtower/channels`/`bullmq`/`ioredis`/`@nestjs/common`/`fetch` ถูกปฏิเสธ · domain → `drizzle-orm`/`@watchtower/db` ผ่าน · `db` → domain และ `web` → domain ถูกปฏิเสธ · worker → domain ผ่าน
- อัปเดตตาราง §3 ใน `docs/04-ARCHITECTURE.md` และ module map §1 (main thread)

### 7. การย้ายโค้ด (T-122b) — **integration test เดิมของ api ต้องผ่านโดยไม่แก้ test**
1. สร้าง workspace + boundary + test ก่อน (commit แยก) 2. ย้ายของที่พึ่งกันน้อยก่อน: `ticket-keys` → `workflow` → `sla` → contacts → outbox → tickets ทีละ method (strangler: class เดิมเรียก domain)
3. หลังทุกขั้น: `pnpm --filter @watchtower/api test && pnpm --filter @watchtower/api test:integration` และ `git diff --stat main -- 'apps/api/**/*.test.ts' 'apps/api/src/testing/**'` ต้องว่าง · test ใหม่ของ domain อยู่ `packages/domain` (`createTestDatabase()`)
4. ถ้าต้องแก้ test เดิมเพื่อให้ผ่าน = behavior เปลี่ยน → หยุดและส่งกลับ main thread ไม่แก้เอง

## Options considered
- **A — worker เรียก api ผ่าน HTTP ภายใน** — ไม่ต้องย้ายโค้ด / ต้องมี service-to-service auth, ingestion ล่มตาม api, latency สองต่อ, Cloud Run cold start, ตัดออก
- **B — api เป็น BullMQ consumer เอง** — ใช้ logic เดิมได้ทันที / ขัด ADR-006 (api ไม่พึ่ง Redis queue, CPU ถูกลดบน Cloud Run), scale api กับงานเบื้องหลังปนกัน, ตัดออก
- **C — ยัด logic ลง `packages/db`** — ไม่ต้องมี workspace ใหม่ / db กลายเป็น domain ที่มี audit/policy/SLA ปน schema, ทุกอย่างที่ใช้ db ได้ business rule ไปด้วย, ตัดออก
- **D — worker เขียนตารางเองแยกจาก api** — เร็ว / logic ซ้ำสองที่ (N6) และ audit/SLA เพี้ยนกัน, ตัดออก
- **E — ประมวลผลทั้งหมดใน webhook request** — ง่าย / ขัด R-2.9 (200 ทันที), timeout ของ AI/Gmail fetch ทำให้ provider ส่งซ้ำ, ตัดออก
- **F (เลือก) — webhook บาง + worker orchestration + `packages/domain`** — logic ชุดเดียวใช้ทั้งสอง process, boundary ตรวจได้ด้วย lint / ต้องย้ายโค้ดก้อนใหญ่และดูแล workspace เพิ่ม

## Consequences
- api และ worker เขียน ticket ด้วยโค้ดชุดเดียว · worker ต้องมี config ของ domain (ticket prefix, encryption key) และ publish realtime เอง
- **ความเสี่ยง:** (1) regression จากการย้าย service ขนาดใหญ่ → กันด้วยกฎ test ไม่แก้ + ย้ายทีละ method (2) `AuditScope.persisted` ไม่ถูก set → audit ซ้ำ 2 แถว: test เดิมของ T-013 จับได้ (3) domain โตเป็น god package → แยก sub-module ต่อเรื่อง, ไม่รับโค้ดอ่านเพื่อแสดงผล, review ตอน T-122b (4) error body เปลี่ยนโดยไม่ตั้งใจ → map เดียว + test เดิม (5) latency AC-1 p95 < 10 s (relay poll 1 s + classify ≤ 3 s + tx) `[UNVERIFIED 80%]` วัดใน T-113 (6) `inbound_event.payload` มี PII ระหว่าง pending → ล้างหลังใช้ + ลบ 7 วัน ให้ T-114 ตรวจ
- ตรวจซ้ำเมื่อ: domain ต้องการ I/O อื่น (เช่น S3) — ห้ามเพิ่มโดยไม่มี ADR · ย้ายโค้ดอ่านเข้า domain · latency ingestion ไม่ผ่านเป้า (พิจารณา `LISTEN/NOTIFY` ตาม ADR-006 option E)

## Links
- PRD §4.2 (R-2.1–2.3, 2.6–2.7, 2.9–2.12), §5.1–5.2, §6.6, §8.3 · BACKLOG T-122, T-102, T-103, T-112, T-121 · `docs/plans/phase-1-breakdown.md` §A, §C, §D · `docs/04-ARCHITECTURE.md` §2, §3, §9, §11 · ADR-002, ADR-006, ADR-010
- LINE Messaging API webhook signature/redelivery และ Pub/Sub push authentication: ต้องตรวจเอกสารทางการปัจจุบันตอน T-102b/T-103b และบันทึกลิงก์+วันที่ `[VERIFY]`
