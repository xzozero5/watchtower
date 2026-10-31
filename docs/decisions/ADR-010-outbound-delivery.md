# ADR-010 — Outbound delivery ถึงลูกค้าแบบ at-most-once + undo-send ฝั่ง server + policy gate (T-122a, ใช้ใน T-122d)

- **Status:** Proposed
- **Date:** 2026-11-01 (เวลากรุงเทพ) · **ผู้ตัดสิน:** main thread (ร่างโดย `architect`) · implement หลัง T-112a (policy gate) ตาม BACKLOG T-122d
- **Context:**
  - ADR-006 ให้ outbox เป็น **at-least-once** และระบุว่า "consumer ของงานที่ซ้ำไม่ได้ (ตอบลูกค้า) ต้องทำ idempotency ของตัวเอง" · ข้อความถึงลูกค้าที่ส่งซ้ำ (อีเมลสองฉบับ, LINE สองครั้ง) เสียความน่าเชื่อถือและเปลือง quota มากกว่าการส่งไม่ออกแล้วมีคนเห็น
  - PRD §4.2 R-2.3 (ส่ง Gmail ใน thread เดิม), R-2.10 (reply token ฟรีแต่ใช้ครั้งเดียว ~1 นาที, push กิน quota, เตือน 80%), AC-2 (ack ด้วย reply token ภายใน 5 s, push ตัด quota), §5.1 ข้อ 3C/5, §6.4 + N3 (stage ≤ 2 ส่งเองได้เฉพาะ auto-ack template), §8.3 (retry + dead-letter ที่ head เห็น, LINE quota หมด → แนะนำอีเมล)
  - UI spec §5.3 + §17 Q1: undo 5 s **ฝั่ง server**, ตั้งได้ 0–30 s, auto-ack ไม่หน่วง · review T-006 ให้ทำ undo-send ฝั่ง server (BACKLOG T-102)
  - ปัจจุบัน `message.delivery_status` มี `not_applicable|pending|delivered|failed` และ channel ที่ไม่ใช่ portal ค้าง `pending` เพราะยังไม่มี dispatcher (`docs/04-ARCHITECTURE.md` §11)

## Decision

### 1. ขอบเขต
- **อยู่ใต้ ADR นี้ (at-most-once):** ข้อความในบทสนทนาที่ไปถึงลูกค้าทาง channel — reply ของ agent, draft AI ที่คนอนุมัติ, auto-ack, CSAT ทาง LINE, ข้อความ stage ≥ 3 (Phase 3) — บน Gmail, LINE, portal
- **คงตาม ADR-006 (at-least-once):** อีเมล transactional (magic link, แจ้ง status/reply ของ portal) และงานภายในทุกชนิด · ซ้ำได้เล็กน้อยและยอมรับแล้ว

### 2. ตาราง `outbound_delivery` (migration ของ T-122d) และ state machine
- คอลัมน์: `id` (= idempotency key), `ticket_id`, `message_id`, `channel_account_id`, `route` (`line_reply|line_push|gmail_thread|gmail_new|portal`), `origin` (`human|ai_approved|system_template|ai_auto`), `template_key`, `ai_run_id`, `approved_by`, `state`, `next_attempt_at`, `hold_seconds`, `attempts`, `lease_until`, `provider_message_id`, `error_code`, `outcome_unknown bool`, `created_by`, `cancelled_by`, `sent_at`, timestamps · **ไม่เก็บเนื้อความซ้ำ** อ่านจาก `message` ตอนส่ง (แก้ข้อความระหว่าง hold ไม่ได้ ต้อง cancel แล้วเขียนใหม่)
- index: partial unique `(message_id) WHERE state NOT IN ('failed','cancelled')` (หนึ่งข้อความมี delivery ที่ active ได้ตัวเดียว) · partial `(next_attempt_at) WHERE state = 'scheduled'` · partial `(lease_until) WHERE state = 'sending'` · FK index ทุกตัว · ไม่ partition
- `message.delivery_status` เพิ่ม `scheduled`, `cancelled` ใน CHECK · มุมมองของลูกค้า (portal tracking, client workspace) แสดงเฉพาะ `delivered`/`not_applicable` · staff เห็น cancelled แบบย่อ `[ASSUMED]`

```
scheduled ──cancel (state = scheduled เท่านั้น)──────────────► cancelled
scheduled ──policy re-check ไม่ผ่าน────────────────────────────► cancelled (error_code = policy_denied)
scheduled ──claim (CAS)──► sending ──provider รับแล้ว────────────► sent
                           sending ──ไม่ถึงแน่นอน + retry ได้────► scheduled (backoff)
                           sending ──ไม่ถึงแน่นอน หมด retry / 4xx─► failed
                           sending ──ไม่รู้ผล (timeout หลังส่ง, lease หมด)► failed (outcome_unknown) หรือ retry เฉพาะ route ที่มี idempotency key
```

### 3. การส่ง (dispatcher ใน `apps/worker/src/processors/outbound.ts`, logic ใน `packages/domain/outbound`)
1. **Schedule (ใน tx ของ reply/approve):** `domain.outbound.schedule` → policy gate (§5) → เขียน `message` (`delivery_status = scheduled`) + `outbound_delivery` (`next_attempt_at = now + hold`) + outbox job queue `outbound` (`jobId = delivery:<id>:<attempt>`, **`notBefore = next_attempt_at`** — เพิ่ม field optional ใน `enqueueOutbox` ที่เขียน `outbox.next_attempt_at` ทำให้ relay ไม่ส่งถึง Redis ก่อนหมด hold) + audit `outbound.scheduled`
2. **Claim:** `UPDATE outbound_delivery SET state='sending', attempts=attempts+1, lease_until=now()+120 s WHERE id=$1 AND state='scheduled' AND next_attempt_at<=now() RETURNING *` · 0 แถว = no-op (ยกเลิกแล้ว/ส่งแล้ว/trigger ซ้ำจาก at-least-once ของ outbox) · ใน tx เดียวกัน: **policy gate ซ้ำ** (switch อาจเปลี่ยนระหว่าง hold) และจอง quota LINE
3. **Provider call นอก tx** ผ่าน transport ของ `packages/channels` (fake ใน mock mode, ไม่ยิง network) · ส่ง idempotency key = `id` ทุกที่ที่ provider รองรับ
4. **Result tx:** `sent` + `provider_message_id` + `message.delivery_status = delivered` (+ `external_id`/`thread_key`) + `first_response_at` ของ SLA คิดที่ **เวลาส่งจริง** ไม่ใช่เวลากด + `ticket_event` + audit + `RealtimeEvent[]`
- **Auto-ack fast path (AC-2 5 s):** ingest job (ADR-009) schedule ด้วย hold 0 แล้วเรียก claim+send ทันทีใน process เดียวหลัง commit · trigger จาก outbox ที่ตามมาเจอ state ไม่ใช่ `scheduled` → no-op

### 4. Undo-send
- hold = setting ระดับ instance `outbound.undo_send_seconds` (0–30, ค่าเริ่มต้น 5) — UI spec Q1 เรียก "org setting" ตีความว่าองค์กรผู้ติดตั้ง ไม่ใช่ organization ลูกค้า `[ASSUMED]` · `system_template` (auto-ack) = 0 เสมอ
- **Cancel endpoint:** `POST /v1/tickets/:ref/messages/:messageId/cancel-send` · `@RequirePermission` เดียวกับการ reply + ต้องเป็นผู้ส่งเองหรือ lead/head `[ASSUMED]` · `UPDATE … SET state='cancelled' WHERE state='scheduled'` → 200 · ถ้าเลย `scheduled` แล้ว → 409 `already_sending` (UI แจ้งว่า "ส่งไปแล้ว") · audit `outbound.cancelled` + realtime · ยิงซ้ำได้ (idempotent)
- status ที่ตั้งพร้อม reply (เช่น `waiting_on_customer`) มีผลทันทีตอน schedule; undo ยกเลิกเฉพาะข้อความ `[ASSUMED]` ให้ `po` ยืนยันตอน T-122d
- portal ใช้ hold เดียวกัน (ข้อความโผล่ในหน้า tracking เมื่อ `delivered`) · test เดิมของ T-007 ที่คาดว่าเห็นทันที ให้ตั้ง hold = 0 ใน fixture และระบุทุกจุดที่แตะใน STATUS (behavior เปลี่ยนโดยตั้งใจ ต่างจากกฎ T-122b)

### 5. Policy gate (N3, PRD §6.4) — ทุกการส่งที่ AI มีส่วน
- `PolicyGate.checkOutbound({ origin, intentId, templateKey, approvedBy, contactVerified })` implement ใน T-112a · ประเมินตอน schedule **และ** ตอน claim · gate error/ไม่มี gate = ปฏิเสธ (fail closed) + audit `outbound.policy_denied`
- `human` → ผ่าน · `ai_approved` → ผ่านเมื่อมี `approved_by` ที่เป็นคนจริง (บันทึกผู้อนุมัติ, UI spec Q6) · `system_template` → ผ่านเฉพาะ `template_key` ใน allow-list ของ template ปลอดภัย (auto-ack ที่มีแค่เลข ticket, ลิงก์ portal, ETA ของ SLA) ทุก stage · `ai_auto` → ต้อง stage ≥ 3 + gate + contact verified · **Phase 1 มี DB CHECK stage ≤ 2 จึงถูกปฏิเสธเสมอ** (test ของ T-112b พิสูจน์ว่าไม่มีทางส่งข้อความ AI ถึงลูกค้าโดยไม่มีคนอนุมัติ)
- switch "จำกัดทุก intent ≤ stage 2" ไม่กระทบ auto-ack · kill switch "หยุด AI ทั้งหมด" หยุด `ai_*` ทั้งหมด แต่ auto-ack แบบ template ที่ไม่ใช้ AI ยังส่ง (PRD §5.1 ข้อ 7: provider ล่ม → plain auto-ack) `[ASSUMED]` T-112a ยืนยัน

### 6. Router และ idempotency ต่อ provider
- **LINE:** ใช้ reply token ถ้ามีและยังไม่หมดอายุ ณ ตอน claim (เก็บ sealed ใน `inbound_message` พร้อม `reply_token_expires_at = received + 50 s` `[ASSUMED]` เผื่อจาก ~1 นาที; ใช้ครั้งเดียวด้วย UPDATE แบบมีเงื่อนไข `… IS NOT NULL RETURNING` ที่ล้างค่าทิ้งในคำสั่งเดียว) ไม่งั้น push · push ส่ง header **`X-Line-Retry-Key: <delivery id>`** ทำให้ retry หลัง timeout/5xx ปลอดภัย และ 409 = ส่งไปแล้ว → `sent` `[VERIFY]` (พฤติกรรม, อายุ key ~24 ชม., ใช้ได้เฉพาะ push ไม่ใช่ reply) · reply token ใช้ไม่ได้ (invalid/expired = ไม่ถึงแน่นอน): ข้อความของคน → push ต่อใน attempt เดียวกัน; auto-ack → `failed` ไม่ push ตาม `[ASSUMED]` (ack ช้าไม่คุ้ม quota)
- **LINE quota:** ตาราง `channel_quota_usage (channel_account_id, period 'YYYY-MM', used, limit, reconciled_at)` · จองตอน claim, คืนเมื่อ fail แบบไม่ถึงแน่นอน · limit ค่าเริ่มต้น 300 (po #5, `[VERIFY]` ราคาไทย) · ≥ 80% → UI เตือน + confirm (Q1) · เต็ม → push ถูกปฏิเสธ `failed (quota_exhausted)` + แนะนำอีเมล (PRD §8.3) · reconcile ทุกชั่วโมงกับ quota API ของ LINE `[VERIFY]`
- **Gmail:** `users.messages.send` พร้อม `threadId` + header `In-Reply-To`, `References`, subject เดิม (R-2.3) · `Message-ID` สร้างเองจาก delivery id (`<wt.<id>@<APP_URL host>>`) `[VERIFY]` ว่า Gmail คงค่าไว้ · Gmail ไม่มี idempotency key → **ไม่ retry อัตโนมัติเมื่อไม่รู้ผล** · ก่อน retry ด้วยมือ ตรวจ Sent ด้วย `rfc822msgid:` `[VERIFY]`
- **Retry อัตโนมัติ** เฉพาะ "ไม่ถึงแน่นอน" (connect ไม่ได้ก่อนส่ง body, 429 ตาม `Retry-After`) หรือ route ที่มี idempotency key · สูงสุด 5 ครั้ง backoff 2^n s ≤ 5 นาที `[ASSUMED]` · 4xx อื่น = `failed`

### 7. Failure, alerting, audit
- `failed` → `message.delivery_status = failed` + `ticket_event message.delivery_failed` + realtime ถึง assignee + แถบใน timeline มีปุ่ม Retry (สร้าง delivery ใหม่ของ message เดิม; ถ้า `outcome_unknown` ต้อง confirm "อาจซ้ำ")
- sweeper ใน worker (`schedules.ts`) ทุก 30 s: `sending` ที่ `lease_until` หมด → `failed(outcome_unknown)` หรือกลับ `scheduled` เฉพาะ LINE push · `scheduled` ที่เลย `next_attempt_at` > 2 นาทีโดยไม่ถูก claim → log error + enqueue trigger ใหม่ (กันแถว outbox `dead`)
- alert ภายใน: `failed` ≥ 3 ครั้งต่อ channel account ใน 15 นาที หรือมี `outcome_unknown` → แจ้ง in-app (P2) + Discord notify (T-104) `[ASSUMED]` · ตัวเลข backlog/failed ต่อ channel อยู่ในหน้า ops ของ T-121
- audit (ใน tx, `AUDIT_ACTIONS` จาก `shared/outbound.ts`): `outbound.scheduled|cancelled|sent|failed|policy_denied` metadata = delivery id, route, origin, template, approver, `ai_run_id` (N4), attempts, error_code · **ห้ามมีเนื้อความ, reply token, หรือ header ดิบ**

## Options considered
- **A — ส่งผ่าน outbox + BullMQ ตรง ๆ (ADR-006)** — ใช้ของเดิม / at-least-once ทำให้ลูกค้าได้ซ้ำ, undo ต้องลบ job, ตัดออก
- **B — BullMQ delayed job เป็นตัว hold แล้ว `job.remove()` ตอน undo** — latency ดี / Redis ไม่ใช่ source of truth, race ระหว่าง remove กับ job ที่เริ่มแล้ว, Redis ล่ม = undo ล้ม, ตัดออก
- **C — hold ใน browser (`setTimeout`)** — ง่ายสุด / ปิดแท็บแล้วข้อความหายหรือส่งโดยไม่ตั้งใจ, ขัด UI spec Q1, ตัดออก
- **D — dispatcher poll `outbound_delivery` เองไม่ใช้ outbox** — ไม่พึ่ง relay / สร้างกลไก claim/backoff/dead ซ้ำกับ ADR-006, ตัดออก
- **E (เลือก) — `outbound_delivery` เป็น source of truth + outbox เป็นแค่ trigger (`notBefore`) + claim แบบ CAS** — ลูกค้าได้ไม่เกินหนึ่งครั้ง, undo เป็น UPDATE เดียว, ใช้ relay เดิม / ไม่รู้ผลบน Gmail ต้องให้คนตัดสิน, latency เพิ่ม ≤ poll 1 s

## Consequences
- **ADR-006 ยังถูกต้อง:** outbox at-least-once สำหรับงานภายในและเป็นตัว trigger · CAS บน `outbound_delivery` ทำให้ผลถึงลูกค้าเป็น at-most-once · แก้ข้อความใน ADR-006 ข้อ 1 ประโยคสุดท้าย ("channel adapter ใช้ `OutboxService` ตัวเดียวกัน") ให้ชี้มาที่ ADR นี้
- ยอมเสีย: บางกรณีข้อความไม่ถึงและต้องให้คนกด Retry (ดีกว่าส่งซ้ำ) · เวลาตอบแรก (SLA) เลื่อนตาม hold 5 s
- ต้องทำ: migration (`outbound_delivery`, `channel_quota_usage`, CHECK ของ `delivery_status`, reply token ใน `inbound_message`), `notBefore` ใน `enqueueOutbox`, queue `outbound` ใน `QUEUE_NAMES`, permission ของ cancel, contract test ของ router (fake transport) รวมเคส crash ระหว่าง `sending`, test ว่า trigger ซ้ำไม่ส่งซ้ำ, test N3 ของ T-112b
- ตรวจซ้ำเมื่อ: เปิด stage 3 (Phase 3: grader ก่อนส่ง §6.6) · LINE/Gmail เปลี่ยนพฤติกรรม idempotency · latency AC-2 ไม่ผ่าน (`[UNVERIFIED 70%]` วัดใน T-113)

## Links
- PRD §4.2 (R-2.3, R-2.10, AC-2), §5.1–5.2, §6.4, §6.6, §8.3, §11 · BACKLOG T-122d, T-102, T-103, T-112, T-121, T-104 · UI spec §5.3, §17 Q1/Q6 · ADR-006, ADR-009
- LINE Messaging API: reply token, push, `X-Line-Retry-Key`, quota API · Gmail API `users.messages.send` + threading — ต้องตรวจเอกสารทางการปัจจุบันและบันทึกลิงก์+วันที่ตอน T-102d/T-103c `[VERIFY]`
