# ADR-006 — Transactional outbox สำหรับงานที่ต้อง enqueue หลัง commit (T-013)

- **Status:** Proposed (เขียนโดย `backend-dev` ใน T-013 · รอ `architect`/`security-reviewer` ตรวจ แล้ว main thread เปลี่ยนเป็น Accepted)
- **Date:** 2026-11-01 (เวลากรุงเทพ)
- **Context:** PRD §8.3 ต้องการ at-least-once สำหรับการส่งงานออก (อีเมล, ตอบ Gmail/LINE ใน Phase 1) · โค้ด T-005 ใช้ `uow.afterCommit(() => queue.add(...))` ซึ่งรันหลัง commit: ถ้า Redis ล่มพอดีหรือ process ตายระหว่าง commit กับ `add` งานหาย และข้อมูลใน DB บอกว่า "ควรมีงาน" โดยไม่มีใครส่ง (เช่น reply บน LINE ค้าง `delivery_status = pending` ตลอด) · review T-005 ตั้งเป็น T-013 · `docs/04-ARCHITECTURE.md` §2 และ §11 บันทึกไว้ว่ายังไม่มี outbox `[ASSUMED]`
- **ข้อจำกัด:** boundary ใน `docs/04-ARCHITECTURE.md` §3 (apps ห้าม import กัน; `packages/db` รู้จัก Postgres ไม่รู้จัก Redis/BullMQ; logic ที่ api กับ worker ใช้ร่วมต้องอยู่ใน package) · ADR-001 ให้ scheduler/งานเบื้องหลังอยู่ใน worker ไม่พึ่ง cron ของ OS · Cloud Run ลด CPU ของ container ที่ไม่มี request จึงไม่เหมาะกับ loop เบื้องหลังใน api

## Decision

**เขียนงานเป็นแถวในตาราง `outbox` ใน transaction เดียวกับการเปลี่ยนข้อมูล แล้วให้ relay ใน `apps/worker` ย้ายแถวไป BullMQ**

1. **Producer (api):** `OutboxService.enqueue({ queue, name, jobId, payload, options }, tx)` เขียนแถว `pending` (migration `0003`) · ไม่แตะ Redis เลย → request สำเร็จแม้ Redis ล่ม · งานมีอยู่ก็ต่อเมื่อการเปลี่ยนข้อมูลที่มันเป็นเจ้าของ commit · `EmailOutbox.send(job, jobId, tx)` เป็น facade ของอีเมล (magic link เขียน token และแถว outbox ใน transaction เดียว) · channel adapter ที่ส่งข้อความ (Phase 1) ใช้ `OutboxService` ตัวเดียวกัน
2. **Idempotency:** unique `(queue, job_id)` · `job_id` คือ BullMQ `jobId` · เขียนซ้ำ = ไม่เพิ่มแถว (`ON CONFLICT DO NOTHING`)
3. **Relay (worker):** loop ทุก `OUTBOX_POLL_INTERVAL_MS` (ค่าเริ่มต้น 1 s) เรียก `relayOutbox` จาก `@watchtower/db` · claim แถวที่ถึงเวลาด้วย `FOR UPDATE SKIP LOCKED` + lease 60 s (relay หลายตัวไม่ชนกัน, relay ที่ตายแล้ว lease หมดอายุเอง) · เรียก publisher ที่ worker ฉีดให้ (`queue.add(name, payload, { ...options, jobId })` พร้อม timeout 5 s) · สำเร็จ → `sent` · ล้มเหลว → `attempts + 1`, `next_attempt_at = now + min(1 s × 2^attempts, 5 min)` และ**หยุดรอบนั้นทันที** (Redis น่าจะล่ม ไม่เสีย timeout ทีละแถว) · ครบ 30 ครั้ง (ราว 2.5 ชม.) หรือเจอ error ถาวร (queue ไม่รู้จัก, options ไม่ผ่าน schema) → `dead` · ตรรกะ SQL อยู่ใน `packages/db/src/outbox.ts` (รู้จักแค่ Postgres) ส่วน BullMQ อยู่ใน `apps/worker/src/outbox-relay.ts`
4. **Options ของงาน** เก็บเป็น jsonb แต่ผ่าน `outboxJobOptionsSchema` (strict, รายการปิด) ก่อนส่งต่อให้ BullMQ
5. **Secret ใน payload (แก้ตาม T-010 C-2):** payload ที่มี secret ใช้ครั้งเดียว (magic link, tracking link ของ portal) **ไม่เก็บเป็น plaintext ใน Postgres หรือ Redis เลย** — รายละเอียดใน "Security: secret ใน outbox" ด้านล่าง · relay ยังล้าง payload เป็น `{}` เมื่อ `sent` หรือ `dead` · แถวที่เสร็จแล้วลบหลัง 7 วัน

### Security: secret ใน outbox (T-010 C-2) `[TESTED]`

ปัญหาเดิม: link ที่เป็น bearer token อยู่ใน `outbox.payload` เป็น plaintext ตลอดช่วง `pending` (นานได้ถึง ~2.5 ชม. เมื่อ Redis ล่ม) และอยู่ใน BullMQ job (และ failed-job history 1 ชม.) ผู้ที่อ่าน DB backup หรือ Redis ได้จึงเข้าระบบแทนลูกค้าได้

1. **Generic `secret` sub-object:** `OutboxService.enqueue({ payload, secret, expiresAt })` — `payload` คือส่วนที่ไม่ลับ (kind, to, locale ...) เก็บตามเดิม ส่วน `secret` เป็น map ของ string (`{ link }`, `{ trackingUrl }`) ถูกเข้ารหัสเป็นค่าเดียวเก็บที่ `payload.secret` · `EmailOutbox.send` แยกฟิลด์ด้วย `EMAIL_SECRET_FIELDS` (`link`, `trackingUrl`) จาก `emailJobSchema` ที่เดียว (`splitEmailSecrets` ใน `@watchtower/shared`)
2. **เข้ารหัส:** AES-256-GCM (`node:crypto`) ด้วย subkey ที่ derive จาก `APP_ENCRYPTION_KEY` ผ่าน HKDF-SHA-256 (label `watchtower/outbox/secret/v1` แยกจาก key ของ portal/audit) · nonce สุ่ม 96 bit ต่อค่า · **AAD = `watchtower/outbox/v1|<queue>|<jobId>`** ผูกค่ากับแถวของมัน คัดลอกไปแปะแถวอื่นแล้วเปิดไม่ได้ · รูปแบบ `v1.<iv>.<ciphertext>.<tag>` (base64url) · โค้ดอยู่ใน `@watchtower/shared/secret-box` (subpath export เพราะใช้ `node:crypto` และ `apps/web` import index ของ shared)
3. **เปิดเฉพาะตอนใช้:** worker (`processors/email.ts`) เปิดใน memory ก่อนเรียก SMTP เท่านั้น · เปิดไม่ได้ (key ผิด, job ผิด, ถูกแก้) หรือ payload ยังเป็นรูปแบบเก่าที่มี link เป็น plaintext → `UnrecoverableError` ทันที ไม่ retry · ข้อความ error/log ไม่มีค่าใน payload
4. **หมดอายุ:** `outbox.expires_at` (migration `0005_security`) — magic link = `MAGIC_LINK_TTL_SECONDS` (link หมดอายุแล้วส่งไปก็เปิดอะไรไม่ได้), อีเมล portal = 24 ชม. (`PORTAL_EMAIL_TTL_SECONDS`) · `relayOutbox` เริ่มทุกรอบด้วยการย้ายแถว `pending` ที่เลย `expires_at` เป็น `dead` พร้อมล้าง payload (ไม่เคยถึง Redis) และไม่ claim แถวที่หมดอายุ · relay ใส่ `notAfter` (epoch ms ของ `expires_at`) ลงใน BullMQ job data · worker เห็น `notAfter` ผ่านไปแล้ว → **ทิ้งโดยไม่ส่งและ complete job** (ไม่ทิ้ง failed job ค้าง) เช่น worker/Redis ล่มนานกว่าอายุ link
5. **Failed-job retention:** job ที่ค้างใน Redis (รวม `removeOnFail` 1 ชม.) เก็บเฉพาะ ciphertext · plaintext มีอยู่ใน memory ของ api ตอนสร้างและใน memory ของ worker ตอนส่งเท่านั้น
6. **Migration:** แถวอีเมลที่ยัง `pending` ตอน apply `0005` เป็น plaintext และเข้ารหัสใน SQL ไม่ได้ (key อยู่ในแอป) จึงถูกย้ายเป็น `dead` พร้อมล้าง payload — ลูกค้าขอ link ใหม่ได้ (ระบบยังไม่ release จึงไม่มี production ที่ได้รับผล) · down migration ไม่กู้แถวเหล่านั้น
7. **ที่ยังไม่ครอบคลุม `[ASSUMED]`:** `to` (อีเมลผู้รับ) ยังเป็น plaintext ใน payload ระหว่าง `pending`/ใน Redis — เป็น PII แต่ไม่ใช่ credential · การหมุน `APP_ENCRYPTION_KEY` ทำให้งานที่รออยู่เปิดไม่ได้ (ถูกทิ้ง) ยังไม่มี key versioning · ผู้ที่ได้ทั้ง DB และ `APP_ENCRYPTION_KEY` ยังอ่านได้ (ADR-004: เก็บ key แยกจาก backup)

## Options considered
- **A — คงไว้: enqueue หลัง commit (`afterCommit`)** — ง่ายสุด แต่ผิด PRD §8.3: งานหายเมื่อ Redis ล่มหรือ process ตายระหว่างสองขั้น
- **B — enqueue ใน transaction (ก่อน commit)** — ถ้า commit ล้มเหลวทีหลังจะมีงานที่ไม่มีข้อมูลรองรับ (ส่งอีเมลของ token ที่ไม่มีจริง) และผูก request กับความพร้อมของ Redis
- **C — outbox ใน DB + relay ใน api process** — ทดสอบง่ายกว่า แต่ api บน Cloud Run ถูกลด CPU เมื่อไม่มี request งานค้างจึงไม่ถูกส่ง และ api ต้องรู้จัก BullMQ เพิ่ม
- **D (เลือก) — outbox ใน DB + relay ใน worker** — worker เป็นโปรเซสที่รันค้างอยู่แล้วเพื่อ consume คิว; api ไม่ต้องพึ่ง Redis สำหรับคิวเลย
- **E — Postgres `LISTEN/NOTIFY` หรือ logical replication (CDC)** — latency ต่ำกว่า polling แต่ซับซ้อนกว่า (connection ค้าง, ต้องมี fallback polling อยู่ดี) · เลื่อนไว้ถ้า latency 1 s ไม่พอ

## Consequences
- **At-least-once ไม่ใช่ exactly-once:** ถ้า relay ตายระหว่าง `queue.add` กับ `UPDATE … sent` แถวจะถูกส่งซ้ำ · `jobId` กันซ้ำได้ตราบที่ job เดิมยังอยู่ใน Redis · อีเมลใช้ `removeOnComplete: true` ดังนั้นถ้า job แรกส่งเสร็จและถูกลบก่อนส่งซ้ำ ผู้รับอาจได้ 2 ฉบับ (หน้าต่างเล็กมาก ยอมรับสำหรับ magic link) · consumer ของงานที่ซ้ำไม่ได้ (ตอบลูกค้า) ต้องทำ idempotency ของตัวเองด้วย `external_id`/`delivery_status`
- **Latency เพิ่ม** ≤ `OUTBOX_POLL_INTERVAL_MS` (ปกติไม่ถึง 1–2 s) · AC ที่กำหนดเวลา (AC-1: ticket ภายใน 10 s) ไม่กระทบเพราะ ticket ไม่ผ่านคิว
- **worker หยุด = งานค้างใน DB** ไม่หาย · มี `outboxBacklog()` สำหรับ log/alert (relay เขียน warning ทุกนาทีขณะส่งไม่ได้) · health check ที่ดูอายุแถวเก่าสุดยังไม่ทำ `[ASSUMED]` ทำพร้อม metrics ใน phase ถัดไป
- **แถว `dead` ต้องมีคนดู** (log ระดับ error; แถวที่หมดอายุ log ระดับ warn) ยังไม่มี UI/endpoint กู้ · เพราะ payload ถูกล้าง การเล่นซ้ำคือการทำ action เดิมใหม่ (ขอ magic link ใหม่) ไม่ใช่ replay แถว
- **อีเมลที่มี link ต้องมี `expiresAt` เสมอ** (`EmailOutbox.send` บังคับ `ttlSeconds`) · ถ้าเพิ่มงานชนิดอื่นที่พก secret ให้ใช้ `secret` + `expiresAt` ของ `OutboxService` ห้ามใส่ secret ใน `payload` (`payload.secret` เป็นชื่อที่สงวน)
- api ไม่ต้องต่อ BullMQ อีก — `bullmq` ใน `apps/api/package.json` เป็น devDependency แล้ว (ใช้เฉพาะ test harness, T-010 C-12)
- เพิ่มตารางเขียนหนักเล็กน้อย (หนึ่งแถวต่องาน) ลบหลัง 7 วัน · `outbox_due_idx` เป็น partial index เฉพาะ `pending`
- ถ้าเพิ่ม queue ใหม่ ต้องเพิ่มชื่อใน `QUEUE_NAMES` (ไม่งั้น `OutboxService` ปฏิเสธ) และ consumer ใน worker
- ต้องตรวจซ้ำ: เมื่อมี consumer ที่ต้อง exactly-once จริง (ส่งข้อความลูกค้า) · เมื่อ latency polling เริ่มไม่พอ · key versioning ก่อนมีการหมุน `APP_ENCRYPTION_KEY` จริง (T-116)

## Links
- PRD §8.3 (at-least-once, idempotent ingestion) · `docs/04-ARCHITECTURE.md` §2, §3, §11 · BACKLOG T-013
- โค้ด: `packages/db/migrations/0003_followups_outbox.sql`, `0005_security.sql`, `packages/db/src/outbox.ts`, `packages/shared/src/secret-box.ts`, `apps/worker/src/processors/email.ts`, `apps/api/src/queue/queue.module.ts`, `apps/worker/src/outbox-relay.ts`
- Test: `packages/db/src/outbox.integration.test.ts`, `apps/worker/src/outbox-relay.integration.test.ts`, `apps/api/src/queue/outbox.integration.test.ts`
- BullMQ `jobId` เป็น idempotency key: https://docs.bullmq.io/guide/jobs/job-ids (ยังไม่ได้ตรวจเอกสารปัจจุบันซ้ำ `[VERIFY]` · พฤติกรรม "add jobId ที่มีอยู่ = ไม่สร้างซ้ำ" ทดสอบจริงแล้วใน `outbox-relay.integration.test.ts` `[TESTED]`)
