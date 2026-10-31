# ADR-011 — Autonomy stage ต่อ intent, policy gate, และสวิตช์ฉุกเฉิน (T-112a)

- **Status:** Accepted 2026-11-01 · `security-reviewer` 2 รอบ: A-1 (P1 search_path) แก้และยืนยันด้วยการโจมตีบน DB แยก · follow-up A-2/A-3/A-4 → T-122d/T-108/T-106, A-6 → T-106d, A-9…A-11 → T-125
- **Date:** 2026-11-01 (เวลากรุงเทพ) · **ผู้ตัดสิน:** main thread (ร่างโดย `ai-engineer`) · ใช้โดย T-122d (outbound), T-102/T-103 (auto-ack), T-106/T-108 (AI runs), T-112b
- **Context:**
  - N3: AI ตอบลูกค้าเองได้เฉพาะ intent ที่ stage ≥ 3 และผ่าน gate · default ทุก intent = stage 2 · auto-ack จาก template ปลอดภัยส่งได้ทุก stage · **การยก intent ใดเป็น stage ≥ 3 ห้าม agent ทำ** (เจ้าของตัดสิน)
  - PRD §6.4 (ตาราง stage, "head pin stage ได้", "emergency all intents → stage 2"), §6.6 (kill switch), UI spec §6.4–6.5, po decision #23 (สองสวิตช์: "จำกัดทุก intent ≤ stage 2" ที่ cap + pin และไม่ยก 0/1 ขึ้น, กับ kill switch "หยุด AI ทั้งหมด"; เปิดและปิดต้อง confirm + เหตุผล + audit), po #19 (T-112 จำกัด stage ≤ 2)
  - ADR-010 §5: policy gate ประเมินตอน schedule **และ** ตอน claim · gate error/ไม่มี gate = ปฏิเสธ (fail closed)
  - ก่อนงานนี้: `PolicyGate` เป็นแค่ interface ใน `packages/domain` (T-122b) ที่ปฏิเสธเสมอเมื่อไม่ได้ตั้ง · `intent.autonomy_stage` มี CHECK 0..4 และ default 2

## Decision

### 1. Policy gate = ฟังก์ชันบริสุทธิ์ + ตัวโหลดสถานะ (`packages/domain/src/autonomy/`)
- `decide(input, safeTemplates)` ไม่แตะ DB/เวลา: รับ **origin × actor type × intent (none | missing | found+stage) × switches × template × approver** คืน `{ allowed, reason }` โดย `reason` เป็น code คงที่ (`GATE_REASONS`) — UI แมปเป็นข้อความ, audit เก็บเป็น code
- `createPolicyGate({ db })` โหลด stage ของ intent + สองสวิตช์ **สดทุกครั้ง (ไม่ cache)** แล้วเรียก `decide` · api สร้างใน `DomainModule` แล้ว · **worker ยังไม่ได้สร้าง gate** (ยังไม่มี `createDomain` ใน worker) — T-122d/T-102/T-103/T-106 ต้องเรียก `createPolicyGate` ด้วย handle DB ของ worker เอง เพื่อให้สอง process ใช้กฎเดียวกัน (review A-8)
- origin 5 แบบ (ตรงกับ ADR-010 §5 เพิ่ม `ai_internal`) และ actor ที่แต่ละแบบต้องเป็น — ไม่ตรง = `actor_origin_mismatch`:

| origin | actor | ผล Phase 1 |
|---|---|---|
| `human` | user | **allow** `human_staff` ทุก stage ทุกสวิตช์ (สวิตช์เกี่ยวกับ AI ไม่ใช่เรื่องของพนักงาน) |
| `ai_approved` (AI ร่าง คนอนุมัติแล้วกดส่ง) | user (= `approvedBy`) | allow `ai_draft_human_approved` เมื่อ stage ≥ 1 · stage 0 → `stage_0_no_customer_draft` · ไม่มี approver หรือ approver ≠ actor → `approval_missing` · ไม่มี intent → `intent_unknown` · intent id ไม่มีจริง → `intent_not_found` |
| `system_template` (auto-ack) | system | allow `safe_template_auto_ack` เฉพาะ `templateKey` ใน allow-list (`SAFE_AUTO_ACK_TEMPLATES`) ทุก stage · ไม่อยู่ใน list → `template_not_allowlisted` · ไม่ระบุ → `template_missing` |
| `ai_auto` | ai | **deny เสมอ** `ai_auto_send_disabled_phase1` ไม่ว่า stage/สวิตช์ใด (stage ≤ 2 = draft-for-approval เท่านั้น) |
| `ai_internal` (classify, summarize, investigate, note) | ai | allow `ai_internal_allowed` ทุก stage รวมถึงตั๋วที่ยังไม่มี intent (classification คือวิธีที่ตั๋วได้ intent) · kill switch เปิด → `kill_switch_on` · intent id ไม่มีจริง → `intent_not_found` |

- ทุก actor ที่ไม่ตรงตาราง (รวม `anonymous`) = deny · stage ที่เก็บไว้ไม่อยู่ใน 0–4 ถูกปฏิเสธบนเส้นทาง AI (`invalid_stage`) · แถวสวิตช์หายจากตาราง = ถือว่า **เปิด** (fail closed)
- **ทุก denial ลง audit** `autonomy.policy_denied` (outcome `denied`, metadata = reason, origin, channel, intent, template, stage, สถานะสวิตช์ — **ไม่มีเนื้อความ**, N4) · เขียนผ่าน connection ของ gate เอง ไม่ใช่ tx ของ request เพราะ denial มักทำให้ request ล้มและ rollback — แถว audit ต้องอยู่รอด · เขียน audit ไม่สำเร็จ = gate throw = ปฏิเสธ
- `requireCustomerSend` (ส่งถึงลูกค้า) และ `requireAiAction` (งานภายใน) เป็นตัวบังคับที่ domain ใช้ · ไม่มี gate = `no_policy_gate`
- **[ASSUMED] kill switch ไม่หยุด auto-ack จาก template** (po #23: "auto-ack templates continue"; PRD §5.1 ข้อ 7: provider ล่ม → plain auto-ack) และ **ไม่หยุดคนที่ส่ง draft เก่าที่ตนอ่านและอนุมัติแล้ว** (`ai_approved`) เพราะการตัดสินใจส่งเป็นของคน · ถ้าเจ้าของต้องการเข้มกว่านี้ เปลี่ยนที่ `decide()` ที่เดียว
- allow-list template: ชุดเล็กในโค้ด (`auto_ack.received`, `auto_ack.received_with_sla` `[ASSUMED]`) **แก้ไม่ได้ตอนรัน** (set ที่ `add/delete/clear` throw + frozen) และ factory จริงไม่รับ override — มีเฉพาะ `createPolicyGateForTest` ที่ไม่ export จากแพ็กเกจ (review A-7) · ข้อความต้องคงที่ มีแค่เลข ticket, ลิงก์ portal, เป้า SLA ของ first response · เพิ่ม key = เปลี่ยนที่เกี่ยวกับความปลอดภัย ต้องมีผู้ตรวจคนละคน (N7)

### 2. Stage ceiling Phase 1 และ Phase 3 จะปลดอย่างไร
- migration 0007: `CHECK (autonomy_stage BETWEEN 0 AND 2)` (`intent_autonomy_phase1_check`) แทน 0..4 เดิม · ค่าคงที่ `PHASE_MAX_AUTONOMY_STAGE = 2` ใน `shared` ใช้ที่ domain และ api ด้วย — **สามชั้น (DB, domain, api) ต้องปฏิเสธ stage ≥ 3 พร้อมกัน**
- api ตอบ **403 `autonomy_stage_requires_owner`** พร้อมข้อความว่าต้องเป็นการตัดสินใจของเจ้าของ ทั้ง lead และ head · ไม่มี role ใดยก ≥ 3 ได้ผ่านระบบนี้
- **การปลด ceiling (Phase 3, T-304)** ทำได้ก็ต่อเมื่อ: (1) เจ้าของตัดสินใจเปิด stage 3 เป็นลายลักษณ์อักษร (2) ADR ใหม่ supersede หัวข้อนี้ (3) migration **ใหม่** drop `intent_autonomy_phase1_check` แล้วเพิ่ม check ที่กว้างกว่า + แก้ `set_intent_autonomy()` (4) แก้ `PHASE_MAX_AUTONOMY_STAGE` และเพิ่มกฎ `ai_auto` ใน `decide()` ที่ต้องมี grader + intent allow-list + contact verified (PRD §6.4, §6.6) พร้อม test ใหม่ที่พิสูจน์ว่า stage ต่ำกว่ายังส่งเองไม่ได้ · agent ห้ามทำข้อใดข้อหนึ่งเอง

### 3. ข้อมูล (migration `0007_autonomy_gate`)
- `intent.autonomy_pinned boolean` · `intent_autonomy_history` (append-only: `intent_id, change ∈ {stage,pin,unpin}, from_stage, to_stage, pinned, reason, changed_by, changed_at`; trigger `reject_mutation` + `REVOKE INSERT/UPDATE/DELETE/TRUNCATE` จาก app role; FK `ON DELETE RESTRICT` เพื่อไม่ให้ลบ intent ทิ้งประวัติ; ไม่มี FK ที่ `changed_by` เหมือน `audit_log.actor_id`)
- `ai_switch (key PK ∈ {ai_stage_cap_pinned, ai_kill_switch}, is_on, reason, changed_by, changed_at)` seed สองแถวปิด · app role **อ่านอย่างเดียว** — พลิกสวิตช์ได้ทางเดียวคือ `set_ai_switch(key, on, actor, reason)` (SECURITY DEFINER เช่นเดียวกัน บังคับ actor + reason ไม่ว่าง ล็อกแถว เขียนเฉพาะเมื่อค่าเปลี่ยน คืนค่าเดิม) เพราะ `UPDATE` ตรงอาจพลิกโดยไม่มีเหตุผล/ผู้กระทำ (review A-5) · ฝั่ง DB fail closed: แถว `ai_stage_cap_pinned` หายถือเป็น **เปิด** (`COALESCE(…, true)`) · ประวัติของสวิตช์อยู่ใน `audit_log` (append-only อยู่แล้ว)
- **least privilege:** app role ถูกถอน `UPDATE` ระดับตารางบน `intent` แล้วให้เฉพาะคอลัมน์อื่นที่ไม่ใช่ `autonomy_stage`/`autonomy_pinned` → ทางเดียวที่เปลี่ยน stage ได้คือฟังก์ชัน `set_intent_autonomy(intent, stage, pinned, actor, reason)` (`SECURITY DEFINER`, `search_path` ตรึง, `EXECUTE` เฉพาะ app role) ที่ล็อกแถว, เขียน history และ update ใน statement เดียว · ฟังก์ชันบังคับเองด้วย: ต้องมี reason + actor, pinned แล้วเปลี่ยน stage ไม่ได้ (`WT001`), ยก stage ขณะ cap switch เปิดไม่ได้ (`WT002`) · คอลัมน์ใหม่ของ `intent` ใน migration ถัดไปต้อง `GRANT UPDATE` เอง (ล้มดังแทนที่จะหลุดเงียบ) · `INSERT` ระดับตารางยังเปิด (drizzle ระบุทุกคอลัมน์) แต่ CHECK ≤ 2 กันไว้ และ default = 2
- **hardening ของ SECURITY DEFINER (review A-1, P1):** ฟังก์ชันที่รันด้วยสิทธิ์เจ้าของต้อง `SET search_path = pg_catalog, pg_temp` (ห้ามมี `public` และ `pg_temp` ต้องอยู่ท้าย) และ **อ้างทุก object พร้อม schema** (`public.intent`, `public.ai_switch`, `public.intent_autonomy_history`, `public.intent%ROWTYPE`, `pg_catalog.*`) — ไม่งั้น app role สร้าง TEMP table ชื่อเดียวกันมาบังได้ ข้าม cap, เบี่ยง history, หรือรัน trigger ใน `pg_temp` ด้วยสิทธิ์เจ้าของ (reviewer ทดสอบได้จริง) · กฎนี้ใช้กับ SECURITY DEFINER ทุกตัวในอนาคต · migration 0007 ตรวจ 0000–0006 แล้ว: SECURITY DEFINER ตัวเดียวที่เหลือ (`ensure_monthly_partitions`) ถูก harden อยู่แล้ว · trigger function ที่รันด้วยสิทธิ์ผู้เรียก (`reject_mutation`, `enforce_unique_array_elements`, `ticket_reject_parent_cycle`) ตรึง search_path เดียวกัน และ `ticket_reject_parent_cycle` ถูกแทนด้วยเวอร์ชันที่อ้าง `public.ticket` (ผ่าน `CREATE OR REPLACE` ใน 0007 ไม่แก้ไฟล์ที่ apply แล้ว; down คืนของเดิม) · ชั้นที่สอง: `provisionAppRole` ถอน `TEMPORARY` จาก PUBLIC บน database (ไม่มีโค้ดใดใช้ TEMP table) · test ใน `packages/db/src/autonomy.integration.test.ts` พิสูจน์ด้วย shadow table + trigger ใน `pg_temp` ว่า bypass cap/เบี่ยง history/ยกสิทธิ์ไม่ได้ แม้ database ที่ยังให้ TEMP กับ PUBLIC
- migration 0007 แก้คำอธิบาย permission `ai.autonomy.set` จาก "up to stage 3" เป็น 0–2 ใน Phase 1 (UPDATE แถว `permissions`; ไม่แก้ 0001) และ `packages/shared/src/rbac.ts` ให้ตรงกัน (review A-8)
- down migration คืน CHECK 0..4 และสิทธิ์เดิม ทิ้งประวัติ/สวิตช์ (lossy ตั้งใจ — เขียนไว้ในไฟล์)

### 4. สองสวิตช์ (po #23)
- `ai_stage_cap_pinned` ("จำกัดทุก intent ≤ stage 2"): คือ `min(stage, 2)` + **pin** — ขณะเปิด **ยก stage ไม่ได้** (409) แต่ลดได้ · **ไม่ยก 0/1 ขึ้นเป็น 2** · ใต้ ceiling ของ Phase 1 ไม่เปลี่ยนพฤติกรรมของ gate (stage ≤ 2 อยู่แล้ว) แต่เป็นสวิตช์ที่ยังใช้ได้หลังปลด ceiling
- `ai_kill_switch` ("หยุด AI ทั้งหมด"): `ai_internal` ถูกปฏิเสธ (classifier ใช้ rules แทน, ไม่มี investigation/draft) · auto-ack template ต่อได้ · UI banner ไม่ใช่สีแดง (UI spec §6.5)
- เปิดและปิด: **ต้องมี `reason` (3–500 ตัวอักษร) ทั้งสองทาง** + audit `autonomy.switch_set` ใน tx เดียวกับการเปลี่ยน · ขอค่าเดิม = `changed: false` ไม่เขียน audit ซ้ำของ domain (request audit ปกติยังบันทึกคำขอ)
- **สิทธิ์: head เท่านั้น** — `POST /v1/autonomy/switches` ต้องมีทั้ง `ai.emergency_switch` และ `ai.autonomy.set.any` เพราะ matrix `[ASSUMED]` ของ T-123a ให้ `ai.emergency_switch` แก่ lead ด้วย (ทิศปลอดภัย) แต่ UI spec §6.5 และ po #23 ระบุ head · การใช้ `ai.autonomy.set.any` เป็นตัวแยก head คือการตีความ `[ASSUMED]` ที่ `po` ควรยืนยันตอน T-115 (ทางเลือก: ถอน `ai.emergency_switch` จาก lead ด้วย migration)

### 5. API (`apps/api/src/autonomy/`)
- `GET /v1/autonomy` (`ticket.read`) → `{ stageCeiling: 2, switches[], intents[{ stage, effectiveStage, pinned, … }] }`
- `POST /v1/autonomy/switches` (head) body `{ switch, on, reason }` → `{ changed, switches[] }`
- `POST /v1/intents/:id/autonomy` (`ai.autonomy.set` = lead, head) body `{ stage?, pinned?, reason }` · stage 0–2 · `pinned` ต้องมี `ai.autonomy.set.any` (head) · stage ≥ 3 → 403 `autonomy_stage_requires_owner` · pinned/cap → 409
- ทุก endpoint มี OpenAPI จาก Zod (`shared/features/autonomy.ts`) และอยู่ใน route-policy test · แก้ intent ผ่าน `PATCH /v1/intents/:id` ยังเปลี่ยน stage/pin ไม่ได้

## Options considered
- **A — เก็บ stage ใน `intent` อย่างเดียว แล้วให้ service เขียน history** — ง่าย / app role ที่มีบั๊กหรือ SQL ที่หลุดเปลี่ยน stage โดยไม่มีประวัติได้ · ตัดออก
- **B — trigger บน `intent` สร้าง history อัตโนมัติ** — ปิดช่องว่างได้ / trigger ไม่รู้ว่าใครและเพราะอะไร (ต้องส่งผ่าน GUC ของ session ซึ่งเปราะ) · ตัดออก
- **C (เลือก) — ฟังก์ชัน `SECURITY DEFINER` เป็นทางเดียว + ถอน UPDATE บนสองคอลัมน์** — ประวัติครบเสมอ, กฎ pin/cap อยู่ใน DB / ต้อง GRANT คอลัมน์เมื่อเพิ่มคอลัมน์ใหม่, ฟังก์ชัน PL/pgSQL เพิ่ม 1 ตัว
- **D — gate เป็น service ใน `apps/api` เรียกจาก worker ผ่าน HTTP** — ขัด ADR-009 (worker ต้องใช้ domain ตรง) · ตัดออก
- **E — cache สถานะสวิตช์ในหน่วยความจำ** — เร็วกว่า / kill switch ไม่มีผลทันที และสอง process เห็นไม่ตรงกัน · ตัดออก (query เล็ก 2 ตัวต่อการตัดสิน ยอมรับได้ที่ปริมาณ Phase 1)

## Consequences
- Phase 1: **ไม่มีเส้นทางใดให้ข้อความที่ AI เขียนถึงลูกค้าโดยไม่มีคนอนุมัติ** — พิสูจน์ด้วย test เชิงครบถ้วนบน `decide()` (ทุกชุด origin × actor × intent × สวิตช์ × template × approver, >10,000 ชุด) + integration test ที่ gate จริง · T-112b ต่อด้วย test พฤติกรรม stage 0/1/2 ใน flow จริง (drafter/dispatcher)
- ต้นทุน: gate อ่าน DB 2 query ต่อการตัดสิน และเขียน audit 1 แถวต่อ denial — ตอน kill switch เปิด ทุก AI action ที่ถูกปฏิเสธจะลงแถว audit (ปริมาณเท่า inbound) `[ASSUMED]` ยอมรับได้ · ถ้าเกินให้ sample/รวมแถวใน ADR ถัดไป
- ต้องทำต่อ: T-122d เรียก `gate.check({ origin, templateKey, approvedBy, … })` ตอน schedule **และ** claim · T-102/T-103 ใช้ key ใน `SAFE_AUTO_ACK_TEMPLATES` หรือเพิ่มพร้อมรีวิว · T-106 เรียก `requireAiAction` ก่อนทุก AI run และบันทึก `ai_run` · T-109d ต่อ UI (banner, stage badge, ปุ่มสวิตช์) · realtime event เมื่อสวิตช์เปลี่ยนยังไม่มี (UI poll `GET /v1/autonomy`) `[ASSUMED]`
- **เงื่อนไขของงานถัดไป (จาก security review T-112a):**
  - **A-2 / T-122d, T-108c:** `ai_approved` ต้องผูกกับ **ระเบียนการอนุมัติ draft จริง** (`ai_draft` + `approved_by` + hash ของเนื้อหาที่ถูกส่ง) — ตอนนี้ gate เช็กแค่ `approvedBy = actor` ซึ่งผู้เรียกที่เป็นโค้ดอ้างเองได้ · dispatcher ต้องเทียบ hash ของ `message` ตอน claim กับที่อนุมัติ
  - **A-3 / T-122d, T-102, T-103:** `system_template` — dispatcher **render เนื้อความจาก key ฝั่งเซิร์ฟเวอร์** ห้ามรับเนื้อความจากผู้เรียก (allow-list ตรวจแค่ key)
  - **A-4 / T-108c:** drafter ต้องเรียก `requireAiAction` และตรวจ stage ≥ 1 ก่อนสร้าง draft ทุกครั้ง (gate ของ `ai_internal` อนุญาตทุก stage โดยตั้งใจ ไม่ใช่ใบอนุญาตให้สร้าง draft ที่ stage 0)
  - **A-6 / T-106:** denial audit ตอน kill switch เปิดต้อง dedupe/sample และ gate ควรใช้ pool แยก (ไม่แย่ง connection กับ tx ของ request ที่เรียกมันอยู่)
- ตรวจซ้ำเมื่อ: เจ้าของตัดสินใจเปิด stage 3 (Phase 3) · po เปลี่ยนความหมายของ kill switch กับ auto-ack · permission matrix ของ `ai.emergency_switch` ถูกยืนยัน (T-115)

## Links
- PRD §5.1 (ข้อ 7), §6.4, §6.6 · BACKLOG T-112, T-122d, T-102, T-103, T-106, T-304 · UI spec §6.4–6.5 · HANDOFF po #19, #23 · ADR-009, ADR-010 (§5)
