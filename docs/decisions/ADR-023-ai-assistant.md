# ADR-023 — AI assistant: ทำงานด้วยสิทธิ์ของผู้ใช้เท่านั้น, tool allow-list ต่อ role, write = proposal card ที่ต้องกด 1 ครั้ง (T-134/T-135)

- **Status:** Proposed 2026-11-02 (เลขเดิม 017 ชนกับ claude-cli-dev-provider จึงย้ายมา 023 เมื่อ merge กับ main 2026-11-04) · ผู้ผลิต `ai-engineer` · รอ `architect` + `security-reviewer` ตรวจ (N7) · mock provider เท่านั้น (ไม่มี key, ไม่มี network)
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
- `POST /v1/assistant/proposals/:id/confirm` ใน transaction เดียว: (1) อ่านแถวด้วย `FOR UPDATE` (กดซ้อนกันสองครั้งไม่ได้) · ผู้เรียก ≠ เจ้าของ → 404 (ไม่บอกว่ามี) · ไม่ใช่ `pending` → 409 (2) หมดอายุเทียบด้วย **นาฬิกา DB** (`clock_timestamp()` ทั้งตอนสร้างและตอนกด) → ปิดเป็น `expired` แล้ว 409 (3) ตรวจสิทธิ์ซ้ำจาก principal ปัจจุบัน (permission ของ route เดิม) และ `TicketReader.viewRow` (เสียสิทธิ์ → 403/404 และการ์ดถูกปิดเป็น `failed`) (4) ล็อก ticket แล้วเทียบ `updated_at` กับตอนสร้างการ์ด: เปลี่ยนไปแล้ว → **ไม่รัน** ปิดเป็น `expired` (`fail_code=stale`) และตอบ 200 `outcome: "stale"` พร้อมการ์ดที่ `from` เป็นค่าปัจจุบัน (5) เรียก service เดียวกับ controller เดิม (`TicketsService.assign` …) ด้วย `actorOf(principal)` ใน `UnitOfWork` เดียว จึงผ่าน RBAC, workflow, SLA, outbox, realtime เหมือนกด · error ใดระหว่างรัน = rollback ทั้งหมด แล้วปิดการ์ดเป็น `failed` (`fail_code=http_<status>`) กดซ้ำไม่ได้ · เมื่อตัดสินแล้ว (confirmed/rejected/expired/failed) `params` ถูกล้างเป็น `{}` และ `card.text` ถูกลบ (ไม่เก็บข้อความ note/KB ค้างในตาราง)
- **audit**: confirm ลง 2 แถวใน transaction เดียวกับการเปลี่ยนแปลง (actor = ผู้กด ทั้งคู่): แถวของ domain เอง (`ticket.assign`, `ticket.status_change`, … ซึ่ง domain เขียนในตัว) และแถว `assistant.proposal.confirm` ที่มี `metadata.via = "assistant"`, `proposalId`, `conversationId`, `kind` · ทั้งสองแถวใช้ `requestId` เดียวกัน · กดแล้วพัง/ถูกปฏิเสธ route เขียนแถว failure ของ `assistant.proposal.confirm` · reject ลง `assistant.proposal.reject` · ทุกข้อความของ assistant ลง `assistant.message` (ชื่อ tool, จำนวน run, ชนิด proposal; ไม่มีข้อความ) · การกดไม่ใช่ "AI ทำเอง" จึงไม่ใช่ actor `ai`
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
- retention `ASSISTANT_RETENTION_DAYS` (30, `[ASSUMED]`) นับจาก `updated_at` · งาน `cleanup` รายวันที่มีอยู่ (`purgeExpired`, T-117) ลบ `assistant_conversation` (cascade message + proposal) และ `ai_summary` ที่เก่ากว่านั้น · ผู้ใช้ลบสนทนาของตัวเองได้ (`DELETE /v1/assistant/conversations/:id`) · audit log ของ confirm/reject คงอยู่ตาม retention ของ audit (ไม่มีข้อความสนทนา)
- ผู้ใช้อื่น (รวม head) อ่านสนทนาของคนอื่นไม่ได้ผ่าน API นี้ (ไม่มี endpoint list/read ข้ามผู้ใช้)

### 9. รูปแบบ claim เดียวกันทั้งระบบ (T-135, N5)
- `{ text, evidence: [{kind, label, href?, mock?}] }` (`claimSchema` ใน `packages/shared/src/features/assistant.ts`) ใช้ทั้งคำตอบ assistant, `aiSummary` ของ daily brief, handoff prefill, และ `claims` ของ investigation report
- **`href` เป็นหน้าจริงที่ผู้ดูเปิดได้เท่านั้น**: server ประกอบ evidence จากข้อเท็จจริงที่ query ด้วย principal ของผู้ดู แล้วค่อยให้ model "เขียน claim โดยอ้าง fact id" — model เขียน URL ไม่ได้ · fact ที่ผู้ดูไม่มีสิทธิ์เปิด (เช่น KB เมื่อไม่มี `kb.read`) ถูกตัดออกก่อนเข้า prompt
- claim ที่ไม่มี evidence ที่ valid: server ใส่ `uncited: true` · UI ต้องแสดงป้าย `Uncited` ไม่ใช่ข้อเท็จจริง · claim ที่ model ไม่ได้อ้างอะไรเลยในสรุป daily brief ถูกตัดทิ้งถ้ามี claim ที่อ้างได้เพียงพอ (ไม่ให้สรุปลอย)
- `mock: true` ติดบน evidence ที่ได้คะแนนจาก mock embeddings หรือ tool ที่เป็น fixture · UI ห้ามแสดง `1.00` เป็นความมั่นใจ · `intent` ส่ง `name` คู่ `key`

### 10. ภาษา
- ผู้ใช้ส่ง `locale` (`th|en`) ทุกข้อความ (fallback: ภาษาของข้อความผู้ใช้) · prompt บอก model ให้ตอบภาษานั้น · mock provider ตามภาษานั้นด้วย (แก้ English ปนใน brief) · draft ถึงลูกค้ายังคงภาษาลูกค้า (ไม่เกี่ยวกับ assistant)

## แก้ไขหลัง security review (2026-11-02)

- **N4 / ประวัติสนทนา:** เก็บและส่งกลับให้ model เฉพาะข้อความที่ model เขียน **ขณะที่ placeholder ยังอยู่** (`redactedText`) ข้อความที่ restore แล้ว (ชื่อ, subject) ใช้แสดงผลเท่านั้น · ประวัติที่ส่งกลับเข้า prompt ผ่าน `redactToolOutput` ซึ่ง escape ทุก token-shaped text (เดิมใช้ `fromModel` ที่คง token ที่ session นี้ออกให้ ทำให้ `[EMAIL_1]` ของเทิร์นเก่าไปผูกกับคนใหม่) · redactor ทุกตัวของข้อความรู้ชื่อพนักงานทั้ง instance (`StaffNames`, แคช 1 นาที) + ชื่อใน fact (assignee, requester, ผู้ติดต่อของ org) · สรุป brief/handoff รู้ชื่อลูกค้าของ org ของ ticket ที่เกี่ยวข้อง + ชื่อพนักงาน
- **N2 / `investigate_run`:** เป็น **การรันของ AI** ไม่ใช่ของคน: ใช้ budget และส่วนแบ่ง rate ของ AI (`createDbToolLedger`, agent `personal_assistant`), audit actor `ai` (`assistant.tool_run`, `onBehalfOf` = ผู้ใช้) และ **ไม่เขียน `evidence_card`** — คนที่อยากปักผลกดปุ่มเดิม · รันได้เฉพาะ template ของ intent ที่ staff ตั้ง/แก้ (ไม่ใช่ intent ที่ classifier เดาเอง), `run_by_ai`, ใช้ `{{org_id}}`, ไม่ต้องให้คนกรอกค่า และระบบเชื่อมต่อแล้ว (กติกาเดียวกับ worker, SR106-R8)
- **Audit การอ่าน:** ticket ที่ tool อ่านเพื่อผู้ใช้ลง `pii.read` ต่อ ticket (`metadata.via=assistant`) และ `assistant.message` มี `ticketIds`
- **งบต่อคน:** อยู่ในตาราง `assistant_usage` (user, วัน UTC) แยกจากสนทนา — ลบสนทนาไม่คืนงบ · สรุป brief/handoff: cache แยกตามภาษา (`ai_summary` PK `kind, user, locale`) และการเรียก model ใหม่ (facts เปลี่ยน หรือภาษาที่ยังไม่มี) จำกัด 12 ครั้ง/คน/ชม.
- **อายุสนทนา:** นับจาก `created_at` (สูงสุด 30 วัน) สนทนาที่ใช้ต่อเนื่องก็หมดอายุ และ API ปฏิเสธการต่อสนทนาที่เกินอายุ (404) · proposal ที่หมดอายุ/ตัดสินแล้วถูกลบหลัง 1 วัน (มี params/card ที่เป็นค่าจริงเพราะการกดต้องใช้) · `ai_summary` หลัง 2 วัน
- **`dev` (T-137):** decorator ของ route คือ `ticket.read` หรือ `auth.session.self` (ทุกคนที่ล็อกอิน) แล้ว handler ตรวจจริงว่าถือ `ticket.read` หรือ `ticket.read.masked` (client ไม่มีทั้งสอง = 403) เพราะ `routes-policy.test` ไม่ยอมให้ decorator อ้าง permission ที่ยังไม่มีบน branch นี้ · เข้าได้ด้วย `ticket.read.masked` (ไม่ต้องมี `ticket.read`), การเปลี่ยนสถานะ/note ตรวจ `ticket.dev.work` · masked = role `dev` หรือถือ masked-read โดยไม่มี `ticket.read` · ชื่อ permission ทั้งสองมาจาก `origin/wip/t-137` ยัง `[ASSUMED]` จนกว่าจะ merge (โค้ดใช้ cast ชั่วคราว) และการเรียก `TicketsService` สำหรับ dev ยังไม่ได้ทดสอบกับกฎ dev ของ T-137
- **P3:** URL ในประโยคที่ model เขียนถูกตัดเป็น `[link removed]` · ก่อน call ที่ 2 ถาม guard ซ้ำ (kill switch/งบเปลี่ยนระหว่างรัน tool)

## แก้ไขรอบที่ 2 หลัง re-review (T-137 อยู่บน main แล้ว)

- **N4:** dictionary ของ redactor ในข้อความหนึ่งมี (ก) พนักงานทั้ง instance (ข) **ทุกคนของ organization** ของ ticket ที่ผู้ใช้เปิดอยู่ หรือที่พิมพ์เลขในข้อความ (ใช้ `orgPeopleNames` ตัวเดียวกับหน้า ticket ของ dev) ทั้งขั้น plan, answer และตอนเก็บ (ค) ทุกคนของ org ของ ticket ที่ tool อ่าน (ชื่อใน subject ของ ticket อื่นใน org เดียวกันก็ถูกแทน) · ถ้ารายชื่อของ org เกินเพดาน (`complete: false`) จะ **ไม่ส่งอะไรไปหา model**: ข้อความผู้ใช้ → `state: unavailable, reason: names_incomplete`, ผล tool → ข้อความถูกแทนด้วยประกาศ, รันของ AI → excerpt เป็น `[text hidden…]`, สรุป brief/handoff → ไม่ทำ · ข้อความที่ model เขียนผ่าน `fromModel` ก่อนเก็บ
- **dev:** ใช้ permission จริง `ticket.read.masked` ที่ decorator (ตัด cast และ `auth.session.self`) · masked = ถือ `ticket.read.masked` โดยไม่มี `ticket.read` (กฎเดียวกับ `TicketReader`) · การ์ดของ dev ใช้ subject ที่ผ่าน masking ของหน้า ticket, สถานะเปลี่ยนได้เฉพาะ `open`↔`waiting_on_dev` และต้องมี note (`isDevStatusMove`, `statusChangeNeedsNote`), ตอนกดส่ง `asDev` เหมือน route · `report.claims` ผ่าน `maskInsight` ด้วย
- **Audit:** `pii.read` ครบทุก ticket ที่อ่าน (ไม่ตัดที่ 20) และ `assistant.message.metadata.ticketIds` ครบ

## แก้ไขรอบที่ 3 (re-review ที่ `872051a`)

- **P1 เดาค่าที่ถูก mask ไม่ได้ (PRD บรรทัด 103):** สำหรับผู้อ่านแบบ masked ข้อความที่พิมพ์กับผลของ tool ใช้ **คนละ namespace**: ค่าที่พิมพ์ถูกออก token ตั้งแต่ `[X_1001]` ใน session ของตัวเอง ผลของ tool ใช้ `[X_1]` เป็นต้นไป เดาถูกหรือผิด model จึงอ่าน prompt เดียวกันและคำตอบเหมือนกัน (test เทียบ prompt ทั้งสองแบบต้องเท่ากันทุกไบต์) พนักงานที่เห็นข้อมูลเต็มใช้ session เดียวตามเดิม
- **ตัดหลัง redact:** fact ยาวถูก redact ทั้งก้อนก่อนแล้วค่อยตัด (`clipRedacted`) เดิมตัดก่อนทำให้อีเมล/เบอร์ที่ถูกตัดครึ่งไม่ถูกจับ (`victim.person@exa`) · tool ไม่ตัดข้อความที่ส่งเข้า model อีก
- **fail closed ครบ:** รายชื่อพนักงานมี `complete` เหมือนรายชื่อ org (ไม่ครบ = ไม่ส่งอะไรให้ model, ไม่เก็บข้อความที่พิมพ์, สรุป brief/handoff ไม่ทำ) · ข้อความผู้ใช้เก็บ **หลัง** เทิร์นและ redact ด้วยชื่อที่ tool พบ · เทิร์นถัดไปที่ไม่มีเลข ticket ยังได้รายชื่อของ org ของ ticket ที่สนทนาเคยพูดถึง · dictionary ของ brief ครอบทุก org ที่ปรากฏ (รวม handoff item ของเพื่อนร่วมงาน, incident, alert, deploy)
- **Audit:** การ์ดที่แสดง subject ของ ticket นับเป็นการอ่าน ลง `pii.read` แม้ไม่มี tool อ่านก่อน
- **ส่วนที่เหลือ `[TESTED]` (residual) `[ASK-HUMAN]`:** ชื่อลูกค้าที่ผู้ใช้พิมพ์โดย **ไม่มีเลข ticket ในข้อความ ไม่มี chip และสนทนานี้ยังไม่เคยพูดถึง ticket ใดเลย** ไปถึง model ในขั้น plan ก่อนที่ tool จะรู้ว่าเป็น org ไหน (ผลทดสอบ: ชื่อไม่ถูกเก็บ แต่ขั้น plan เห็น) เจ้าของต้องยอมรับความเสี่ยงนี้ก่อนเปิด live provider · T-137 redact คีย์ยาวเกินจำเป็น (over-redaction) ไม่แก้ในงานนี้ → T-125

## PII stores ของ assistant (ให้ ADR เรื่อง erasure/PDPA นับ)

| ที่เก็บ | ข้อมูล | อายุ | ลบเมื่อผู้ใช้ถูกลบ |
|---|---|---|---|
| `assistant_conversation`, `assistant_message` | ข้อความที่ผ่าน redactor แล้ว (ชื่อนอก dictionary หลุดได้ `[UNVERIFIED 70%]`) | 30 วันจากวันเริ่ม; ผู้ใช้ลบเองได้ | ใช่ (FK CASCADE) |
| `assistant_proposal` | `params`/`card` ค่าจริง (note, อีเมลผู้แจ้ง, subject) จนกว่าจะถูกตัดสิน แล้วล้างทันที | ลบหลังหมดอายุ 1 วัน | ใช่ |
| `assistant_usage` | ตัวเลขเท่านั้น | 30 วัน | ใช่ |
| `ai_summary` | claim ที่ restore แล้ว (ชื่อ/subject ที่ผู้ใช้เห็น) | 2 วัน | ใช่ |
| `ai_run` | `output` ที่ redact แล้ว + HMAC ของ input | ตาม retention ของ `ai_run` (append-only) | ไม่ (ไม่มีข้อมูลดิบ) |
| `audit_log` | id, ชื่อ tool, จำนวน; ไม่มีข้อความ | ตาม audit | ไม่ (บันทึกการกระทำ) |

## Consequences / ยังไม่ยืนยัน
- live provider ใน api ยังไม่ wire (credentials reader อยู่ใน worker) `[ASK-HUMAN]` · คุณภาพ plan/answer จาก model จริงยังไม่เคยวัด (ไม่มี eval ของ assistant: `evals/golden/` แก้ไม่ได้โดย agent ผู้ผลิต → เสนอเคสให้ main thread) `[UNVERIFIED]`
- `dev` role ตามตาราง allow-list เป็นสมมติฐานจนกว่า T-137 merge · เมื่อ `Role` มี `dev` ต้องอัปเดต `ASSISTANT_ROLE_TOOLS` และ test
- `ai_summary` (cache ของ brief/handoff) เก็บ claim ที่ restore แล้ว (มีชื่อ/หัวข้อ ticket ได้) ต่อผู้ใช้ 1 แถวต่อหน้าจอ · ถูกแทนเมื่อ facts เปลี่ยน, ลบตาม retention และเมื่อผู้ใช้ถูกลบ · ถ้าต้องการไม่เก็บ PII ที่ rest เลยต้องเก็บแบบ redacted + token map (ยังไม่ทำ) `[ASSUMED]`
- `GET /v1/tickets/stats` ที่ไม่มี filter เลยเคย 500 (SQL `WHERE` ว่าง) — พบตอนทำ `team_load` แก้ใน `sla-states.ts` พร้อม test
- ลิงก์: เว็บมีหน้า ticket เพียงทาง `/?ticket=KEY` · ยังไม่มีหน้า KB/incident/alert จึงไม่ออก `href` ให้ evidence ชนิดนั้น (ชิปบอกว่าไม่มีลิงก์) · worker เคยออก `/tickets/KEY` และ `/kb/slug` ซึ่งไม่มีหน้า — แก้ ticket เป็น `/?ticket=KEY` แล้ว, `/kb/slug` ยังอยู่ใน card เดิมแต่ claim ตัดทิ้ง
- ชื่อบุคคลที่ไม่อยู่ใน dictionary ของ redactor อาจหลุดไป model ได้ (ช่องว่างเดิมของ ADR-013) `[UNVERIFIED 70%]`
- ทบทวนเมื่อ: เปิด live provider, เพิ่ม auto-run ของ write ใด ๆ, เปิด bubble ให้ `client`, เพิ่ม tool ที่เขียนได้

## ฝั่งเว็บ (T-134 web, 2026-11-04)
- `AssistantBubble` mount ครั้งเดียวใน `ConsoleLayout` (ไม่อยู่ใน portal/status/csat) · เห็นเฉพาะผู้ถือ `ticket.read` หรือ `ticket.read.masked` (ตรงกับ guard ของ route) · `Ctrl/⌘ J` เปิด-ปิด, `Esc` พับแล้วคืน focus ที่ปุ่ม, ข้อความที่พิมพ์ค้างอยู่
- context chip = หน้า (`context.page`) + ticket ที่เปิดในคิว (`?ticket=`) · เอาออกแล้วไม่ส่ง · ไม่ส่งอะไรที่ไม่เห็นเป็นชิป
- คำตอบเรนเดอร์ด้วย `ClaimLine` (`components/claims/`) ตัวเดียวสำหรับทุก claim: ลิงก์เฉพาะ href ที่ผ่าน `evidenceHref/safeHref` (https เปิดแท็บใหม่ `noopener`), claim ไม่มีหลักฐาน = ไอคอน + คำว่า "ไม่มีหลักฐาน" และข้อความเป็นตัวเอียงจาง, `mock` = ป้าย "ตัวอย่าง"
- `proposal` เป็นการ์ดจากค่าของ server · ปุ่มยืนยันครั้งเดียว ไม่ย้าย focus มาที่ปุ่ม · `stale` บอกว่าไม่ได้ทำอะไร · `reply_draft` ไม่มีปุ่มส่ง
- สถานะ `paused/budget/unavailable` ปิดช่องพิมพ์พร้อมข้อความ · ไอคอนปุ่มเป็น `CirclePause` เมื่อ `ai_kill_switch` เปิด
- ยังไม่ทำ `[ASK-HUMAN]`: สวิตช์ซ่อน bubble ใน user menu, command ใน palette, sheet/ปรับตำแหน่งเมื่อมี sticky footer และการซ่อนเมื่อมี modal ตาม design §2.1, ปุ่ม Stop เป็นแค่ยกเลิก request ฝั่ง client (server อาจยังคิดต้นทุนของ call นั้น)
