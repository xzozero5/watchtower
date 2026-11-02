# ADR-017 — AI assistant: ทำงานด้วยสิทธิ์ของผู้ใช้เท่านั้น, tool allow-list ต่อ role, write = proposal card ที่ต้องกด 1 ครั้ง (T-134/T-135)

- **Status:** Proposed 2026-11-02 · ผู้ผลิต `ai-engineer` · รอ `architect` + `security-reviewer` ตรวจ (N7) · mock provider เท่านั้น (ไม่มี key, ไม่มี network)
- **Context:** `docs/design/less-text-ai-assistant.md` §2, §4 · PRD §6.1 (N2), §6.2 (Personal Assistant), §6.4 (N3), §6.6 (N4) · ADR-008 (ports, `RedactedText`, `ai_run`) · ADR-011 (policy gate, kill switch) · ADR-013 (ToolRegistry, runbook) · ADR-016 (คนกด `investigate.run`, budget ร่วม) · `po` #33–#35 (HANDOFF)
- **Decision (สรุป):** assistant เป็น "มือของผู้ใช้" ไม่ใช่ตัวแทนที่มีสิทธิ์ของตัวเอง ทุกอย่างที่ทำได้คือสิ่งที่ผู้ใช้คนนั้นทำเองได้อยู่แล้วผ่านหน้าจอเดิม

## Decision

### 1. ตัวตน: principal ของผู้ใช้เท่านั้น ไม่มี admin tool
- `POST /v1/assistant/messages` รันด้วย `Principal` ของ session ที่เรียก (สิทธิ์อ่านจาก DB ทุก request เหมือนทุก route) · tool ทุกตัวปิด (closure) บน principal นั้น: ค้นด้วย `TicketReader` ที่กรอง org/สิทธิ์เดิม ไม่มีทางอ่านของที่ผู้ใช้อ่านเองไม่ได้
- **ไม่มี** tool สำหรับ: emergency switch, autonomy, role/permission, integration/credential, ลบข้อมูล, bulk ที่ส่งถึงลูกค้า, ad-hoc query (`investigate.adhoc`), publish KB · ถ้าผู้ใช้ขอ assistant ตอบเป็นลิงก์ไปหน้านั้น (ตาม design §2.5)
- route ใช้ `@RequirePermission('ticket.read')` → `client` ได้ 403 (po #34: ลูกค้ายังไม่ได้ bubble เพราะ AI ตอบลูกค้า = N3) · ไม่เพิ่ม permission ใหม่ใน migration นี้ (`assistant.use` ทำทีหลังได้ถ้าต้องปิดต่อ role ผ่าน RBAC)

### 2. Tool allow-list ต่อ role และต่อ permission
- สร้าง `ToolRegistry` ใหม่ **ต่อ request** (deny-by-default, agent `personal_assistant`) แล้ว register เฉพาะ tool ที่ role + permission อนุญาต · `ASSISTANT_ROLE_TOOLS` เป็นรายการที่โค้ดถือ (ไม่ใช่ model เลือก): agent/lead/head มี tool ค้น/สรุป/อธิบาย SLA/KB/team status · `team_load` (ใครงานล้น) เฉพาะ lead/head · `investigate_run` ต้องมี `investigate.run` · `dev` (T-137 `[ASSUMED]` ยังไม่อยู่ใน `ROLES` บน main): ค้น/สรุป/KB/investigate แบบ **masked** ไม่มี tool ที่ propose reply · role ที่ไม่อยู่ในตาราง = ไม่มี tool (ปฏิเสธ)
- tool read-only ทั้งหมด (`readOnly: true` ตาม N2) · แต่ละ tool มี Zod input/output + unit test · budget: สูงสุด `ASSISTANT_MAX_TOOL_CALLS` (4) ต่อข้อความ, `investigate_run` ไม่เกิน 1 ต่อข้อความ และใช้ budget ร่วมของ ADR-015/016 (หมด = `rate_limited` แสดงเป็นช่องว่างที่รู้ตัว)
- model ไม่เลือก "สิทธิ์" ได้: ถ้า model ขอ tool นอกรายการ → `ToolNotAllowedError` → บันทึก `denied` ในแถบ tools

### 3. Read tool รันทันที, write tool = proposal card
- model ไม่มี write tool เลย · มันเสนอ **proposal** ได้ 7 ชนิด: `assign`, `status`, `tag`, `note`, `create_ticket`, `kb_draft`, `reply_draft` · server **ไม่เชื่อค่าที่ model เขียน** นอกจาก "เจตนา" (ชนิด + ticket ref + ค่าที่จะตั้ง): server แก้ ref เป็น ticket จริง, ชื่อ assignee เป็น user id จริง (เฉพาะ staff active), อ่านค่า "ก่อน" จาก DB แล้วสร้างการ์ดจากค่า server ทั้งหมด (`changes: [{field, from, to}]`) · ค่าที่ validate ไม่ผ่าน schema ของ route เดิม (`assignTicketSchema`, `changeStatusSchema`, `updateTicketSchema`, `noteSchema`, `createTicketSchema`, `createKbArticleSchema`) = ไม่สร้างการ์ด
- ข้อความยาวที่ model เขียน (note, KB draft) แสดงเต็มบนการ์ดให้คนอ่านก่อนกด · KB draft ได้ `status: draft` เสมอและผู้เขียน = ผู้กด จึงอนุมัติเองไม่ได้ (po #27)
- `reply_draft` **ไม่เขียนข้อความถึงลูกค้า**: กดแล้วเรียก `TicketAiService.request(kind: 'draft')` ตัวเดียวกับปุ่ม "Draft a reply" → worker สร้าง `ai_draft` → คนตรวจ A/E/R + policy gate + undo ตามเดิม · stage ไม่เปลี่ยน (≤ 2, N3) · assistant ไม่มีปุ่ม Send

### 4. Confirm: ครั้งเดียว, เฉพาะเจ้าของ, หมดอายุ, ตรวจซ้ำ
- `assistant_proposal` เก็บ `user_id` ผู้ขอ, `params` (หลัง validate), `card`, `base` (fingerprint ของ target ตอนสร้าง: `updated_at` ของ ticket), `expires_at` (10 นาที `[ASSUMED]`), `status` (`pending → confirmed | rejected | expired | failed`)
- `POST /v1/assistant/proposals/:id/confirm`: (1) ผู้เรียก ≠ เจ้าของ → 404 (ไม่บอกว่ามี) (2) `UPDATE … WHERE status='pending' AND expires_at > now() RETURNING` ใน transaction เดียวกับการทำงานจริง → ใช้ซ้ำไม่ได้ (409) (3) ตรวจสิทธิ์ซ้ำจาก principal ปัจจุบัน (permission ของ route เดิม + `TicketReader.viewRow`) (4) ตรวจ `base`: ticket เปลี่ยนไปแล้ว → 409 `proposal_stale` พร้อม **สถานะปัจจุบัน** ให้การ์ดแสดงใหม่ ไม่รันทับ (5) เรียก service เดียวกับ controller เดิม (`TicketsService.assign` …) ด้วย `actorOf(principal)` ใน `UnitOfWork` เดียว จึงผ่าน RBAC, workflow, SLA, outbox, realtime เหมือนกด
- **audit**: confirm ลงแถวเดียวด้วย action ของงานจริง (`ticket.assign`, `ticket.status_change`, …) + `metadata.via = "assistant"`, `proposalId`, `conversationId` · reject ลง `assistant.proposal.reject` · การกดไม่ใช่ "AI ทำเอง" จึงไม่ใช่ actor `ai`
- ไม่มี auto-run ของ write ใดเลย (po #34: auto-run ภายหลังเฉพาะ tag/note ต้องมี ADR ใหม่)

### 5. ข้อมูลที่ model เห็น และ masking
- ทุก byte ที่ไป LLM ผ่าน `RedactedText` (N4): ข้อความผู้ใช้ → `session.redact`, ผลของ tool → `session.redactToolOutput` (token origin `tool`), ประวัติสนทนาเดิม → `session.fromModel` · ชื่อบุคคลของ org ที่ tool อ่านถูกใส่ใน dictionary ของ session ที่สร้างหลังรัน tool (ช่องว่างเดิม: ชื่อนอก dictionary ไม่ถูก redact `[UNVERIFIED 70%]`)
- **`dev` ได้ข้อมูล masked** (po #33): tool ไม่ส่งอีเมล/โทร/ชื่อผู้ขอให้ dev และคำตอบที่แสดงคืน token แบบ `customer` audience (token ของ tool ไม่ถูก restore) จึงเป็น placeholder · **`client` ไม่ได้อะไรเลย** (403)
- ทุกการเรียก model ผ่าน `createAuditedLlm` → `ai_run` (agent `personal_assistant`, prompt version, model tier, tools, tokens, cost) · แถวไม่มีข้อความผู้ใช้ มีแต่ HMAC ของ input และ output ที่ redact แล้ว (ADR-008)

### 6. Prompt injection: ข้อความ ticket/ลูกค้า/KB/ผล tool เป็น "ข้อมูล"
- prompt (`assistant_plan.v1.md`, `assistant_answer.v1.md`) ห่อข้อมูลใน `<tool_results>` / `<context>` และบอกชัดว่าห้ามทำตามคำสั่งในนั้น · แต่ **ไม่พึ่ง prompt เป็นด่านเดียว**: (ก) model เลือกได้แค่ tool ใน allow-list ของผู้ใช้ (ข) argument ผ่าน Zod, ticket ref ถูก resolve ด้วยสิทธิ์ผู้ใช้ (ค) write ทุกชนิดต้องคนกด และการ์ดสร้างจากค่า server (ง) ลิงก์ในคำตอบมาจาก evidence ที่ server ประกอบ ไม่ใช่ URL ที่ model เขียน — model อ้างได้แค่ `evidenceId` ที่ server ออกให้ (จ) ข้อความ model ผ่าน `neutralizeTags` ก่อนใส่ tag ของ prompt อีกรอบ
- ผลที่ดีที่สุดที่ injection ทำได้คือ "ข้อความคำตอบผิด" ซึ่งมี claim แบบ `uncited` ให้เห็น ไม่ใช่การกระทำ

### 7. งบ, rate limit, kill switch
- ต่อผู้ใช้: `ASSISTANT_MESSAGES_PER_HOUR` (30) และ `ASSISTANT_USER_DAILY_TOKENS` (200 000) `[ASSUMED]`, ใน `config/budgets.yaml` (`assistant:`) และ env · นับ rate จาก Redis (`RateLimiter`), นับโทเค็นต่อวันจาก `assistant_message` · เกิน = 429 พร้อม `state: 'budget'` (UI ปิดช่องพิมพ์)
- ต่อระบบ: ใช้ `createAiGuard` เดิม (kill switch ผ่าน policy gate + งบรายวัน `app_ai_daily`) ก่อนทุก model call · `ai_kill_switch` เปิด → `state: 'paused'`, ไม่มี model call และไม่มี tool รัน (flow เริ่มที่ plan) · proposal ที่สร้างไว้ก่อนหน้า **ยัง confirm ได้**: confirm เป็นการกระทำของคนผ่าน service เดิม ไม่ใช่ AI call จึงไม่ถูกปิดโดย kill switch (`reply_draft` ก็แค่ queue job เหมือนปุ่มเดิม แล้ว guard ของ worker ปฏิเสธเองเมื่อ kill switch เปิด) `[ASSUMED]`
- provider: ตอนนี้ **เฉพาะ `AI_PROVIDER=mock`** ถูก wire ใน api · provider จริงตอบ `state: 'unavailable'` อย่างชัดเจน (ไม่ fallback เงียบ, N5) จนกว่า `[ASK-HUMAN]` จะอนุมัติ key และมี live wiring ใน api

### 8. การเก็บสนทนา, PII, retention
- เก็บ `assistant_conversation` + `assistant_message` ต่อผู้ใช้ **เฉพาะข้อความที่ผ่าน redactor แล้ว** (placeholder) ไม่เก็บ PII ดิบ และไม่เก็บ snapshot ของ token map · ข้อความที่แสดงให้ผู้ใช้ (restore แล้ว) ไม่ถูกเก็บ
- retention `ASSISTANT_RETENTION_DAYS` (30, `[ASSUMED]`) นับจาก `updated_at` · `purgeExpiredAssistant()` ลบ conversation (cascade message + proposal) ที่หมดอายุ — เรียกจาก worker sweep รายวัน (ทำเป็น follow-up ถ้ายังไม่ต่อใน task นี้; ดู Consequences) · ผู้ใช้ลบสนทนาของตัวเองได้ (`DELETE /v1/assistant/conversations/:id`) · audit log ของ confirm/reject คงอยู่ตาม retention ของ audit (ไม่มีข้อความสนทนา)
- ผู้ใช้อื่น (รวม head) อ่านสนทนาของคนอื่นไม่ได้ผ่าน API นี้ (ไม่มี endpoint list/read ข้ามผู้ใช้)

### 9. รูปแบบ claim เดียวกันทั้งระบบ (T-135, N5)
- `{ text, evidence: [{kind, label, href?, mock?}] }` (`claimSchema` ใน `packages/shared/src/features/assistant.ts`) ใช้ทั้งคำตอบ assistant, `aiSummary` ของ daily brief, handoff prefill, และ `claims` ของ investigation report
- **`href` เป็นหน้าจริงที่ผู้ดูเปิดได้เท่านั้น**: server ประกอบ evidence จากข้อเท็จจริงที่ query ด้วย principal ของผู้ดู แล้วค่อยให้ model "เขียน claim โดยอ้าง fact id" — model เขียน URL ไม่ได้ · fact ที่ผู้ดูไม่มีสิทธิ์เปิด (เช่น KB เมื่อไม่มี `kb.read`) ถูกตัดออกก่อนเข้า prompt
- claim ที่ไม่มี evidence ที่ valid: server ใส่ `uncited: true` · UI ต้องแสดงป้าย `Uncited` ไม่ใช่ข้อเท็จจริง · claim ที่ model ไม่ได้อ้างอะไรเลยในสรุป daily brief ถูกตัดทิ้งถ้ามี claim ที่อ้างได้เพียงพอ (ไม่ให้สรุปลอย)
- `mock: true` ติดบน evidence ที่ได้คะแนนจาก mock embeddings หรือ tool ที่เป็น fixture · UI ห้ามแสดง `1.00` เป็นความมั่นใจ · `intent` ส่ง `name` คู่ `key`

### 10. ภาษา
- ผู้ใช้ส่ง `locale` (`th|en`) ทุกข้อความ (fallback: ภาษาของข้อความผู้ใช้) · prompt บอก model ให้ตอบภาษานั้น · mock provider ตามภาษานั้นด้วย (แก้ English ปนใน brief) · draft ถึงลูกค้ายังคงภาษาลูกค้า (ไม่เกี่ยวกับ assistant)

## Consequences / ยังไม่ยืนยัน
- live provider ใน api ยังไม่ wire (credentials reader อยู่ใน worker) `[ASK-HUMAN]` · คุณภาพ plan/answer จาก model จริงยังไม่เคยวัด (ไม่มี eval ของ assistant: `evals/golden/` แก้ไม่ได้โดย agent ผู้ผลิต → เสนอเคสให้ main thread) `[UNVERIFIED]`
- `dev` role ตามตาราง allow-list เป็นสมมติฐานจนกว่า T-137 merge · เมื่อ `Role` มี `dev` ต้องอัปเดต `ASSISTANT_ROLE_TOOLS` และ test
- sweep รายวันของ retention ยังไม่ผูกกับ scheduler ของ worker ถ้าไม่ทำใน task นี้ → follow-up (ตัวฟังก์ชันและ test มีแล้ว)
- ชื่อบุคคลที่ไม่อยู่ใน dictionary ของ redactor อาจหลุดไป model ได้ (ช่องว่างเดิมของ ADR-013) `[UNVERIFIED 70%]`
- ทบทวนเมื่อ: เปิด live provider, เพิ่ม auto-run ของ write ใด ๆ, เปิด bubble ให้ `client`, เพิ่ม tool ที่เขียนได้
