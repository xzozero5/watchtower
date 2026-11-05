# ADR-029 — Watchtower Assistant ("Jarvis") stage 1: AI ทุกจุดของผลิตภัณฑ์, รู้ทุก module ภายในสิทธิ์ของผู้ใช้, read-only, AI ฝังในทุก element (§9)

- **Status:** **Accepted 2026-11-05** (main thread หลัง security review T-400 + ตรวจซ้ำ ไม่มี P0/P1, po รับแบบมีเงื่อนไขและแก้ครบ, คำตอบเจ้าของครบ) · DoD เพิ่มจากตรวจซ้ำ: C-24…C-27 (BACKLOG)
- **Date:** 2026-11-05 (เวลากรุงเทพ) · **ผู้ตัดสิน:** เจ้าของ (scope) + main thread (การออกแบบ) · ผู้ร่าง `architect` · แก้รอบ 1 ตาม `security-reviewer` (`docs/decisions/T-400-security-review.md` C-1…C-23) + `po` (2026-11-05) · main thread mark Accepted หลังยืนยันว่า C-1…C-11 ปิดใน ADR นี้ (N7)
- **Supersedes:** ADR-023 §1 บางข้อ (ดู §11) · **ไม่ supersede** ADR-023 §7 (kill switch — ADR นี้ทำตาม)
- **Context:**
  - **เจ้าของ `[CONFIRMED 2026-11-05]`:** ทำแค่ stage 1 คือไม่มี write action และไม่มี proactive alert (เป็น stage ถัดไป) · AI ต้องเรียกใช้ได้จากทุกจุดของผลิตภัณฑ์ · **staff ทุก role ได้ assistant ยกเว้นลูกค้า** — customer portal และหน้าที่ลูกค้าเห็นอยู่นอก scope (ตัดสินแล้ว)
  - **main thread ตัดสิน:** แต่ละ role ใช้ได้ภายใน RBAC ของตัวเอง · provider คง `claude -p` ผ่าน `claude-bridge` (ADR-019/021) ~5–10 s ต่อ call `[UNVERIFIED]`, bridge concurrency 4, api max 2 · stage 1 เป็น text อย่างเดียว ไม่มี voice
  - **ของที่มีอยู่แล้ว `[TESTED: อ่านโค้ด 2026-11-05]`:** ADR-023 assistant (`POST /v1/assistant/messages`) รันด้วย principal ของผู้ใช้ มี tool 7 ตัวครอบแค่ ticket/KB/team/investigate (`apps/api/src/assistant/assistant-access.ts`) · `holds()` ถือว่า `ticket.read.masked` ผ่าน `ticket.read` (ตั้งใจไว้สำหรับ ticket เท่านั้น) · แต่ละ turn เรียก model 2 ครั้ง (plan + answer, `packages/ai/src/agents/assistant.ts`) · citation ใช้ fact id `e1..eN` ที่ server ออก · context รับแค่ `page` + `ticket` (`assistantContextSchema`) · route ต้องมี `ticket.read`/`ticket.read.masked` · limiter ของ api สงวน 1 slot ให้ summary ทำให้ assistant ทั้ง instance ใช้ได้ครั้งละ 1 call · bridge ตอบ JSON ก้อนเดียว ยังไม่มี streaming · WebSocket realtime มีแล้ว (กรองตาม audience) · ยังไม่มี MCP endpoint (PRD §6.3)
  - **permission ของ route ที่ ADR นี้อ้าง `[TESTED: อ่านโค้ด 2026-11-05]`:** `GET /v1/incidents[/:id]` = `ticket.read` แท้ · GET ของ `status-admin.controller` = `ticket.read` แท้ · `GET /v1/shifts/overview` = `RequireAnyPermission('roster.manage','performance.read.all')` + `@AuditPiiRead('shift_overview')` · section รายคนของ dashboard = `performance.read.all` (`dashboard.service`)
  - **เจ้าของ `[CONFIRMED 2026-11-05]` (เพิ่ม):** ทุก element ต้องมี AI ในตัว (daily brief, stat report) ไม่ใช่แค่ bubble · latency ทาง ก. (claude -p, bridge 4, assistant 10–40 s รับได้) · element ไม่ realtime: cache แล้วคำนวณใหม่เบื้องหลังตาม event, ใช้ AI อย่างมีประสิทธิภาพ → §9
  - **เจ้าของ `[CONFIRMED 2026-11-05]` (ข้อ "ข."):** narration จาก LLM ได้ทุก element ที่เคยให้เป็น F อย่างเดียว ได้แก่ ผลงานรายคน (`dashboard.ops.team`), `shift.overview`, `home.my_work` **ยกเว้นหน้า admin** (`admin.intents`/`admin.intent.gate`, `statuspage.admin`, `admin.ai`/integrations/outbox/queues) ซึ่งเป็น F อย่างเดียว · ข้อนี้มีผลเหนือข้อเสนอ "F only" ใน C-10 ความเสี่ยงของ C-10 รับมือด้วย §9.9
  - ของเดิมที่ §9 ใช้ต่อ: `ai_summary` (brief/handoff ต่อผู้ใช้, fingerprint, 12 ครั้ง/คน/ชม.), `weekly_brief` (CEO), `ai_ticket_insight` + investigation/draft/grade, `AiBrief` ของ conversation, agent `roster_planner` · reader ที่ api กับ worker ใช้ร่วมใน `packages/domain` (`figureFacts`, `openTicketCounts`)
  - inventory ต่อหน้าจอ + **AC-J1…J14** (assistant) และ **AC-J15…J22** (embedded insights; J17 = ป้ายสถานะ 6 แบบใน §9.3) ของ `po` (2026-11-05) อยู่ใน `docs/BACKLOG.md` §Jarvis stage 1
  - PRD §6.1, §6.2 (Personal Assistant), §6.6 · N2, N3, N4, N5 · ADR-002, 008, 011, 013, 016, 023

## Decision

### 1. "สมอง" ตัวเดียว: agent `personal_assistant` ตัวเดิม + tool catalogue เดียวที่ครอบทุก module
- **ไม่สร้าง agent ต่อหน้า** ใช้ `runAssistantTurn` เดิมใน `packages/ai` แล้วขยาย catalogue ใน api (§2) · สิ่งที่ต่างกันระหว่างหน้าคือ **context และ prefetch** ตัว agent เป็นตัวเดียวกัน
- **ทุกจุดของผลิตภัณฑ์:** `AssistantBubble` ใน `ConsoleLayout` มีอยู่ทุกหน้า console แล้ว สิ่งที่เพิ่มคือ (ก) page registry ใน web (`apps/web/src/lib/assistant/page-registry.ts`) ที่ map ทุก route ของ `(console)` → `page` + วิธีอ่าน entity จาก URL/selection (ข) จุด "ถาม AI เรื่องนี้ / Ask AI about this" บน row/card ของ entity (ticket, conversation, incident, alert, KB article, shift item, intent) ที่เปิด bubble พร้อม chip ของ entity นั้นผ่าน endpoint เดียวกัน (ค) palette "Ask AI" (Ctrl/⌘ K) ที่มีอยู่ (ง) insight ในตัว element (§9) ที่มีปุ่ม "ถาม AI เรื่องนี้" ทุก element ที่ไม่ใช่ X (§9.6) — context เพิ่ม `element?: {key, scope, period?}` ตรวจตาม §9.3 · portal, `/status`, `/csat`, `/start`, `/login` ไม่มี bubble และ layout สาธารณะไม่ import assistant
- **Context จาก client เป็นแค่ hint ไม่ได้ให้สิทธิ์:** ขยาย `assistantContextSchema` (รองรับรูปเดิม)
  ```ts
  context: {
    page?: AssistantPage            // queue|ticket|conversations|incident|alert|statuspage|kb|shift|brief|handoff|roster|dashboard|reports|autonomy|admin|other
    entity?: { kind: AssistantEntityKind; ref: string }  // ticket|conversation|incident|alert|kb_article|handoff|intent|org|service
    selection?: { kind: AssistantEntityKind; refs: string[] /* ≤ 20 */ }
    element?: { key: ElementKey; scope: string; period?: string }   // §9.3
    ticket?: string                 // เดิม, = entity{kind:'ticket'}
  }
  ```
  server resolve ทุก ref **ด้วย reader ของ module นั้นภายใต้ principal ของผู้เรียก** · ref ที่ไม่มีจริงกับ ref ที่ไม่มีสิทธิ์ถูกทิ้งแบบเดียวกันทุกประการ (ไม่บอกว่ามีอยู่) แล้วบันทึกเป็น `context_dropped` **เฉพาะจำนวนและ kind ไม่เก็บ ref ดิบ** (C-20) · ไม่ส่งสิ่งที่ไม่ปรากฏเป็น chip (ไม่มี hidden context ตาม ADR-023) · `page` ใช้แค่เลือก prefetch/starter ไม่เกี่ยวกับสิทธิ์
- **Prefetch ด้วยโค้ด:** ถ้ามี entity บน chip server จะเรียก tool "สรุป entity" ของ kind นั้นก่อนถึง model (เช่น `summarize_ticket`, `incident_get`) ใส่เป็น fact → ส่วนใหญ่ **ตอบได้ใน call เดียว** (§4)
- **ตัวตน (C-9):** ใช้ principal ของ session เท่านั้น · route เปลี่ยนจาก `ticket.read|ticket.read.masked` เป็น permission ใหม่ **`assistant.use`** seed ให้ `agent`, `lead`, `head`, `dev` · ก่อนตรวจ permission โค้ดตรวจแบบ **allowlist**: `principal.role ∈ WORKSPACE_ROLES` **และ** `principal.orgScope.kind === 'all'` ไม่ผ่าน = 403 (ไม่ใช้ denylist `client`/`system`) → แม้มีคนให้ `assistant.use` แก่ role ลูกค้าผ่าน `rbac.manage` ก็ใช้ไม่ได้ · staff ที่ไม่มี `ticket.read` (เช่นถือแค่ `ceo.view`) ใช้ได้ แต่ได้เฉพาะ tool ที่ตัวเองถือ permission

### 2. Tool design
- **ที่อยู่:** `apps/api/src/assistant/tools/<module>.tools.ts` ห่อ reader/service ที่ GET route ของ module นั้นใช้อยู่ · **ห้ามเขียน SQL ใหม่ใน tool** ถ้าไม่มี reader ให้เพิ่มใน module เจ้าของก่อน (N6 — หน้าจอกับ AI อ่านข้อมูลชุดเดียวกัน) · `packages/ai` ไม่รู้จัก DB/HTTP รับแค่ `AssistantToolHost`
- **รูปของ permission (C-1):** `TOOL_PERMISSION[name]: { route: 'GET /v1/…'; rule: {all: Permission[]} | {anyOf: Permission[]} }` ใช้รูปเดียวกับ decorator (`RequirePermission` = `all`, `RequireAnyPermission` = `anyOf`) และตรวจด้วย **evaluator ตัวเดียวกับ guard ของ route** (`evaluatePermissionRule(principal, rule)` ย้ายมาจาก guard แล้วใช้ร่วมกัน) · **ลบ shortcut masked ออกจาก `holds()`** — `ticket.read.masked` ผ่านได้เฉพาะ tool ที่ route ประกาศ `anyOf(ticket.read, ticket.read.masked)` (ticket tools เดิม) · tool ของ incident/status page ที่ route เป็น `ticket.read` แท้ **ปิดสำหรับ `dev`** เหมือนหน้าจอ
- **Catalogue stage 1** (ทุกตัว `readOnly: true`; rule = rule ของ GET route ที่ให้ข้อมูลเดียวกัน):

  | module | tools | rule (ต้องตรงกับ decorator ของ route) |
  |---|---|---|
  | tickets | `search_tickets`, `summarize_ticket`, `explain_sla` (เดิม), `ticket_timeline` | `anyOf(ticket.read, ticket.read.masked)` |
  | conversations | `conversation_search`, `conversation_get` (inbound/other-mail) | `inbound.read` |
  | incidents/alerts | `incident_search`, `incident_get` (timeline, deploy) | `all(ticket.read)` `[TESTED: อ่าน decorator]` |
  | | `alert_search`, `alert_get` | ตาม GET ของ alerts `[UNVERIFIED 60%]` — parity test บังคับ |
  | status page | `statuspage_status`, `statuspage_drafts` | `all(ticket.read)` `[TESTED]` / ตาม decorator ของ GET drafts `[UNVERIFIED]` |
  | KB | `kb_search` (เดิม), `kb_get` | `kb.read` |
  | shifts | `team_status`, `team_load` (เดิม), `shift_context` (กะปัจจุบัน, handoff item, shift notes), `roster_view` | `ticket.handle` / `anyOf(handoff.write, handoff.ack)` / `roster.manage` |
  | reports | `ops_metrics`, `ceo_metrics`, `performance_view` | `dashboard.ops.read` / `ceo.view` / `anyOf(performance.read.own, performance.read.all)` |
  | autonomy | `autonomy_status` (stage ต่อ intent, ผล gate แบบ pass/fail, kill switch เปิด/ปิด) | ตาม GET ใน `autonomy.controller` — supersede ADR-023 §1 (§11) |
  | admin config | `config_lookup` (SLA policy, queue, intent, workflow, integration แบบ `{kind, connected}`) | `*.manage` ของหน้านั้น — supersede ADR-023 §1 (§11) |
  | investigate | `investigate_run` (เดิม) | `investigate.run` |

  - **`config_lookup` output (C-6):** output schema เป็น **allow-list ของ field ต่อชนิด** (Zod `strict()`) ห้าม pass-through object · ห้ามมี field ที่เป็น URL/endpoint/webhook/host/secret ref/token/credential id · integration คืนได้แค่ `{kind, connected: boolean, lastOkAt?: string}` · มี test ว่า output ไม่มี key ใดของ credential store และไม่มีค่าที่ match `https?://`
  - **arg ที่เป็น id (C-16):** tool ที่รับ `userId`/`orgId` (เช่น `performance_view`) ถ้าผู้เรียกถือแค่ `.own` จะ **ไม่สนใจ arg** แล้วใช้ `principal.userId` · ให้ arg ของคนอื่นได้เฉพาะเมื่อ rule ของ route สำหรับ "ของคนอื่น" ผ่าน
  - **ไม่มี tool (คงตาม ADR-023 §1 ยกเว้นข้อที่ supersede ใน §11):** credential/secret/API key (แม้เป็น metadata), `investigate.adhoc`, audit log, เนื้อหา `ai_run`, user/role/permission, การสั่ง emergency switch · ถ้าผู้ใช้ถาม assistant ตอบเป็นลิงก์ไปหน้านั้น · ไม่เปิด audit เพราะเป็นบันทึกของ assistant เอง, metadata เป็นทาง injection และคุ้มน้อย — ทบทวนใน stage ถัดไป (main thread ตัดสิน 2026-11-05)
- **RBAC สองชั้น ตรวจที่ server ทุกครั้ง:** (1) `toolsFor(principal)` สร้าง registry ต่อ request แบบ deny-by-default ด้วย evaluator ของ route (2) handler ตรวจซ้ำ และ reader กรอง org/masking เอง · **parity test บังคับ (C-1):** สำหรับทุก tool × ทุก role จริง (รวม `dev` masked และ role custom) ต้องได้ `toolsFor` ผ่าน ⇔ guard ของ `route` ผ่าน (**เทียบผลการตรวจสิทธิ์ ไม่ได้เทียบ string**) และ output ⊆ สิ่งที่ route คืนให้ principal เดียวกัน · `rule` ต้องเท่ากับ metadata ของ decorator ที่อ่านจาก Nest reflector · ไม่ตรง = test ตก
- **Read-only ที่ DB (C-2):** handler ทุกตัวรันผ่าน `runReadOnly(fn)` ซึ่ง (ก) ใช้ **pool แยก** `readOnlyPool` ที่ต่อด้วย connection option `-c default_transaction_read_only=on -c statement_timeout=3000` `[ASSUMED 3 s]` (role `watchtower_app` เดิม ไม่ต้องเพิ่ม role) และ (ข) เปิด `BEGIN READ ONLY` · reader ที่ tool ใช้ต้อง**รับ executor** — แก้ `TicketReader` เมธอดที่ใช้ `this.database.db` ตรง (~497, ~543) · มี lint/test ว่า `apps/api/src/assistant/tools/**` ห้าม import `DatabaseService` · integration test: tool ที่พยายาม INSERT ต้องได้ `25006 read_only_sql_transaction` · `investigate_run` ใช้ `watchtower_ai_ro` ของ ADR-013/016 เหมือนเดิม · บน GCP เปลี่ยน `readOnlyPool` ไปชี้ read replica ได้ผ่าน env (`DATABASE_RO_URL`, default = `DATABASE_URL`) (N2)
- **Zod in/out:** ทุก tool มี schema `input`/`output` + unit test (valid + reject) · input `limit` ≤ 20 · validate output ก่อนสร้าง fact
- **ขนาดผล:** รายการ ≤ 20 แถว, `text` ของ fact ≤ 1 200 ตัวอักษรหลัง redact (`clipRedacted` redact ก่อนแล้วจึงตัด) · fact ต่อ turn ≤ 30 · บริบทที่ส่ง model ≤ 24 000 ตัวอักษร ถ้าเกินให้ตัด fact อันดับต่ำ `[ASSUMED]`
- **Citation id:** tool คืน `facts[]` ที่มี `ref: {kind, id}` (id จริง) host เป็นผู้ประกอบ ส่วน fact id `eN` ออกใหม่ทุก turn (§5)
- **Budget (N2):** `ASSISTANT_MAX_TOOL_CALLS` 4 ต่อ turn (ไม่นับ prefetch ที่โค้ดเรียก ซึ่งจำกัด 2) · `investigate_run` ≤ 1 (และมีเงื่อนไขของ §6) · rate ต่อผู้ใช้ต่อ tool ผ่าน `RateLimiter` Redis (60 call/ชม./tool `[ASSUMED]`) · งบ token/ข้อความต่อผู้ใช้คงตาม ADR-023 §7 · ทุก tool ประกาศ `piiKinds` (C-17: `ticket`, `conversation`, `contact`, `timeline`, `shift_overview`, `performance`) → `pii.read` ต่อ entity ที่อ่าน (`metadata.via=assistant`)

### 3. Memory
- **Conversation turns:** ใช้ตาราง `assistant_conversation`/`assistant_message` เดิม เก็บ **เฉพาะข้อความที่ redact แล้ว** อายุ 30 วัน · เพิ่ม `evidence jsonb` เก็บแค่ `[{kind,id}]` (ไม่เก็บ label/href) · ตอนแสดงประวัติ server ประกอบ label/href ใหม่ด้วยสิทธิ์ ณ ตอนนั้น (เสียสิทธิ์แล้วจะเห็น chip "ไม่มีสิทธิ์เข้าถึง") · เพิ่ม `path text` (`facts_only|llm1|llm2`) และ `context jsonb` ตาม §1
- **User-pinned facts (ใหม่):** ตาราง `assistant_memory`
  ```
  assistant_memory(id uuid pk, user_id uuid fk users on delete cascade,
                   body text,             -- redacted (N4), ≤ 300 chars, มาจาก redactedText ของ turn
                   refs jsonb,            -- [{kind,id}] ≤ 5, resolve ใหม่ด้วยสิทธิ์ทุกครั้ง
                   source_message_id uuid fk assistant_message on delete set null,
                   created_at, last_used_at, expires_at)  -- expires_at = created_at + 90 วัน (เพดานแข็ง)
  index (user_id, created_at desc) · index (expires_at)
  ```
  - **สร้างได้ทางเดียวใน stage 1 (C-7):** ปุ่ม "จำไว้" บนคำตอบ ซึ่ง server คัด claim จาก **`redactedText` ของ turn นั้น** (ไม่ใช้ข้อความที่ restore แล้วบนจอ) พร้อม `refs` ของ evidence · **memory ที่พิมพ์เองใน settings เลื่อนออกจาก stage 1** เพราะยังไม่มี dictionary/NER ที่ fail closed สำหรับข้อความลอย · model สร้างเองไม่ได้ (เป็น write ของ AI)
  - ≤ 20 แถวต่อคน · **อายุ 90 วันนับจาก `created_at`** (ใช้บ่อยก็ไม่ต่ออายุ) `[ASSUMED]` · ใส่ prompt ≤ 10 แถว (เรียงตาม `last_used_at`) ห่อ `<user_notes>` ในฐานะข้อมูล ไม่ใช่คำสั่ง
- **Per-shift context: ไม่เก็บเป็น memory ของ AI** — tool `shift_context` อ่าน shift/handoff/notes ด้วยสิทธิ์ผู้เรียก · **ไม่มี memory ของ assistant ที่แชร์ข้ามผู้ใช้**
- **การเข้ารหัส:** ไม่เข้ารหัสระดับคอลัมน์ (เก็บเฉพาะที่ redact แล้ว ส่วน disk/backup encryption เป็นของ infra ตาม ADR-014) · ความเสี่ยงที่ชื่อนอก dictionary หลุด `[UNVERIFIED 70%]` เหมือน ADR-023 จึงมีอายุและเพดาน · ใช้ envelope ของ ADR-012 ได้ภายหลังโดยไม่เปลี่ยน API
- **ผู้ใช้ดูและล้างได้:** `GET/DELETE /v1/assistant/memory[/:id]`, `DELETE /v1/assistant/memory`, `GET /v1/assistant/conversations` (ของตัวเอง) · ไม่มี endpoint อ่านข้ามผู้ใช้ (head ก็อ่านไม่ได้) · `purgeExpired` รายวัน · ตาราง PII stores ของ ADR-023 เพิ่ม `assistant_memory`, `ai_element_insight` (claims อ้าง ref ของ staff) และ `ai_summary` kind `my_work`

### 4. Latency / concurrency กับ `claude -p`
- **ลดจำนวน call ต่อ turn:**
  1. **`facts_only` (ไม่ใช้ LLM, ไม่กิน slot):** starter และคำถามที่มีโครง ("งานของฉัน", "อะไรเสี่ยง SLA", "ใครงานล้น", "สถานะทีม", "incident ที่เปิดอยู่", "กะนี้มีใคร") map ด้วยโค้ด (`starter.id` หรือ regex allow-list) ไปยัง tool แล้วแสดง fact เป็น claim ด้วย template TH/EN (มี citation ทุก claim) ≤ 1 s · **allow-list ของ `facts_only` = reader ภายในเท่านั้น ห้าม `investigate_run` หรือ tool ที่มีต้นทุนภายนอก (C-5)** · ไม่มี `ai_run` มีแค่ audit `assistant.message` `path=facts_only`
  2. **`llm1`:** prefetch แล้ว call เดียวด้วย prompt `assistant_turn.v1` ที่คืน `{claims}` หรือ `{calls}`
  3. **`llm2`:** ได้ `{calls}` → รัน tool แล้ว answer อีก 1 call · **≤ 2 call ต่อ turn** ห้ามวน tool
  - ภายใต้ ADR-019 ทุก tier เป็น `sonnet` → tier ไม่ช่วยเรื่องเวลาบน claude-cli · path ที่ประหยัดจริงคือ `facts_only` · resolver ยังเรียก tier `light` ตามปกติ (ไม่ hardcode model)
- **Streaming = phase ไม่ใช่ token:** `POST /v1/assistant/messages` + `Accept: text/event-stream` ตอบเป็น SSE: `queued{position}` → `context{chips resolved}` → `tool{name,status}` → `answering` → `reply{AssistantReply}` | `error{state,reason}` · ไม่ขอ SSE = JSON เดิม · **ไม่ stream token** เพราะต้องผ่านการตรวจ citation, `stripLinks`, restore placeholder และ masking ก่อน (N4/N5) · ไม่ใช้ WebSocket เพราะ event เป็นของ request เดียว SSE ผูกกับ abort/CSRF/คิวได้ตรงกว่า · Caddy/Cloud Run ต้องไม่ buffer `text/event-stream` `[VERIFY]` · event แรก ≤ 300 ms · ปุ่ม Stop ยกเลิกถึง bridge
- **Audit ก่อนส่งคำตอบ (C-4):** `AuditInterceptor` เขียนหลัง handler คืนค่าซึ่งสายเกินไปสำหรับ SSE → service เขียน `audit_log` `assistant.message` + `pii.read` (persisted, ใน transaction ของ audit) **ก่อน emit `reply`** · เขียนไม่ได้ = emit `error{state:'unavailable', reason:'audit_failed'}` และไม่ส่ง `reply` · ใช้กับ path JSON ด้วย (interceptor ข้าม route นี้ด้วย marker เพื่อไม่ให้เขียนซ้ำ) · test: audit ล้ม → ไม่มี `reply`
- **Concurrency:** คง bridge 4 และ `AI_API_MAX_CONCURRENCY=2` (สงวน 1 ให้ summary) → assistant ได้ 1 slot ต่อ process · คิว ≤ 8 รอ ≤ 60 s แสดงตำแหน่งผ่าน SSE · คิวเต็ม = `unavailable` + `reason: assistant_queue_full` · 1 turn ต่อคน (`assistant_busy`) · abort ผูกกับ request
- **อยู่ร่วมกับ worker:** เพิ่ม `WORKER_AI_MAX_CONCURRENCY` (default 2) ใช้ limiter ตัวเดียวกัน (ย้าย `concurrency-limit.ts` ไป `packages/ai/src/live/`) → api 2 + worker 2 = bridge 4 ปิดช่องว่าง "worker ไม่มีเพดาน" ของ ADR-023 · job ที่ได้ 429 `busy` retry ตามเดิม
- **Cache (C-12):** ไม่ cache ข้ามผู้ใช้ · cache ต่อผู้ใช้เฉพาะ `facts_only` และ starter ที่ใช้ LLM key `(user, permissionSetHash, starter.id, locale, prompt version, fingerprint ของ fact)` ใน Redis 10 นาที · เก็บข้อความที่ redact แล้ว + `ref` เท่านั้น **ไม่เก็บ token map** แล้ว restore จาก `ref` ทุกครั้ง · cache hit เขียน `assistant.message` + `pii.read` เหมือน miss · ต้องมี test ว่า token ออกตามลำดับ deterministic `[UNVERIFIED 60%]` ถ้าไม่ผ่านให้ cache เฉพาะ `facts_only`
- **12-factor / GCP (C-19):** ค่าทั้งหมดมาจาก env · limiter และ `assistant_busy` เป็นของแต่ละ process **เงื่อนไขของ stage 1 คือ api 1 replica และ worker 1 process** `[ASSUMED]` · ก่อนเพิ่ม replica/process ต้องย้าย `ConcurrencyLimit` และ `assistant_busy` ไป Redis ก่อน (worker log warning ตอน boot ถ้า `WORKER_REPLICA_INDEX`/process count > 1)

### 5. Citations
- **รูปแบบ:** `claimSchema` เดิม `{text, evidence:[{kind,label,href?,mock?}], uncited?}` · เพิ่ม `ref?: {kind,id}` ใน evidence · ขยาย `CLAIM_EVIDENCE_KINDS`: `conversation`, `statuspage`, `shift`, `metric`, `intent`, `config`, `user`
- **การตรวจ:** model อ้างได้แค่ `eN` ที่ออกใน **turn นี้** id นอกตารางถูกทิ้ง claim ที่ไม่เหลือ evidence ได้ `uncited: true` · ประวัติ turn เก่าเข้า prompt เป็นข้อความอย่างเดียว ไม่มี fact id · href ประกอบโดย server จาก `ref` (`assistant-hrefs.ts`) เฉพาะหน้าที่ผู้ใช้เปิดได้ · URL ในข้อความของ model → `[link removed]`
- **UI contract:** ใช้ `ClaimLine` เดิม · uncited = ตัวเอียงจาง + ป้าย "ไม่มีหลักฐาน / Uncited" · คำถามเชิงข้อเท็จจริงที่ทุก claim uncited → แถบ "คำตอบนี้ไม่มีหลักฐานจากระบบ / This answer has no system evidence" · `mock` = ป้าย "ตัวอย่าง / Sample" · ไม่แสดงตัวเลขความมั่นใจ · ปุ่ม 👍/👎 + reason code (metric)

### 6. Security
- **Prompt injection (content คือ data):** fact มี `trust: 'system' | 'staff' | 'customer'` · **free text ทุกชนิดที่ไม่ใช่ system** (ข้อความลูกค้า, handoff/shift note, KB, ข้อความ alert) ห่อ `<untrusted_content>` ผ่าน `neutralizeTags` (C-14; note/KB ใช้ `trust:'staff'` ในการแสดงผล แต่ห่อเหมือนกัน) · ด่านที่ไม่พึ่ง prompt: (ก) tool อยู่ใน allow-list ของผู้ใช้ ผลแย่สุดคืออ่านสิ่งที่ผู้ใช้อ่านได้อยู่แล้วมาให้คนเดิม (ข) ไม่มี write tool / outbound / URL จาก model และ UI เรนเดอร์ plain text → ไม่มีช่อง exfiltration (ค) ≤ 2 call, ≤ 4 tool ต่อ turn (ง) argument ผ่าน Zod และ ref resolve ด้วยสิทธิ์
- **ด่าน cost/ทิศทางของ `llm1` (C-3):** call ใดที่ prompt มี fact ห่อ untrusted จะ **ไม่ถูกเสนอ `investigate_run`** (ตัดออกจาก tool list ของ call นั้น และถ้าขอมาก็ถูกทิ้ง) · `investigate_run` ใช้ได้เฉพาะเมื่อ request ที่ผู้ใช้พิมพ์เองหรือ starter ขอ และ call นั้นไม่มี untrusted content · argument ของ `{calls}` restore placeholder ได้เฉพาะ token ใน **typed namespace** (จากข้อความที่ผู้ใช้พิมพ์และ chip) ไม่ใช่ token ที่มาจากผล tool · ความเสียหายที่เหลือคือคำตอบผิด ซึ่ง citation/uncited ทำให้เห็นได้
- **RBAC:** ตาม §1–§2 · masked `dev` ตาม ADR-023 (`maskInsight`) · tool ใหม่ที่คืนข้อมูลลูกค้าต้องผ่าน masking ตัวเดียวกับ route (parity test ครอบ) · route ที่ใช้ `ticket.read` แท้ ปิดสำหรับ dev ทั้ง tool และ insight (C-1)
- **Audit (N4):** ทุก model call → `ai_run` ผ่าน `createAuditedLlm` (agent `personal_assistant`, prompt id/version/hash, model, tier, tools, tokens, cost, latency, HMAC ของ input) · ทุก turn → `audit_log` `assistant.message` (`path`, tool, `aiRunIds`, entity ids ที่อ่าน, ไม่มีข้อความ) เขียนก่อน `reply` (§4) · `pii.read` ต่อ entity ตาม `piiKinds` · `assistant.memory.create/delete`
- **Redaction (C-8):** ทุก byte ผ่าน `RedactedText` (ADR-008/023) · dictionary = staff + people ของ org ของ **ทุก ref ใน `context` ของ turn ปัจจุบันและทุก turn ก่อนหน้าในสนทนา** (อ่านจาก `assistant_message.context jsonb` ทั้งหมด ไม่ใช่แค่ `context->>'ticket'`) + **ชื่อ/อีเมล/display name ของผู้ส่งของทุก conversation ที่ tool อ่าน** (รวม other-mail ที่ org unidentified) · รายชื่อไม่ครบ (`complete:false`) = ไม่ส่งอะไรไป model (fail closed) · test ต่อ entity kind
- **Kill switch / budget / offline (C-5 — ทำตาม ADR-023 §7):** `createAiGuard` ก่อนทุก call · **kill switch เปิด หรือ policy ปิด agent `personal_assistant` → ไม่มี model call และไม่มี tool รัน รวมถึง `facts_only`** ช่องพิมพ์และ starter ปิด ข้อความ "AI หยุดทำงาน — แสดงข้อมูลตรงจากระบบ / AI paused — showing system data" (J10) · ส่วนหน้าจอเองและ element แบบ F ยังแสดงข้อมูลตามปกติเพราะเป็น GET route ของหน้า ไม่ใช่ assistant · **งบหมด / provider offline:** ช่องพิมพ์ปิดพร้อมเหตุผล (J10) แต่ starter `facts_only` ยังกดได้ (ไม่ใช้ LLM, reader ภายในเท่านั้น) · ไม่ fallback mock · ถ้าเจ้าของต้องการให้ `facts_only` ทำงานระหว่าง kill switch ต้องเขียน ADR ใหม่ `[ASK-HUMAN]` (ไม่ได้เปิดใน ADR นี้)
- **ลูกค้า (เจ้าของตัดสินแล้ว):** ไม่มี assistant บน portal หรือหน้าที่ลูกค้าเห็น · ใช้ allowlist ตาม §1 · ทุก endpoint `/v1/assistant/**` (รวม SSE, memory, conversations) และ `/v1/insights` ได้ 403 สำหรับ client และ session portal/magic-link — **เพิ่ม walk ของ `client` ใน `routes-policy.test`** (แบบเดียวกับ walk ของ dev ใน T-137) ที่ตกทันทีถ้า endpoint ใหม่เปิดให้ client + integration test ที่ grant `assistant.use` ให้ role client ใน DB แล้วยัง 403 (C-9) · ผลของ assistant ไม่ถูกส่งออกทาง outbound/portal/status page · **`reply_draft` (proposal card ของ ADR-023)** ไปถึงลูกค้าได้เฉพาะหลังคนตรวจและอนุมัติผ่าน draft flow เดิม (N3) ซึ่งไม่ขัดกับคำตัดสิน "ลูกค้าไม่ได้ assistant" เพราะคำตัดสินนั้นหมายถึงลูกค้าไม่ได้ใช้ assistant ส่วนข้อความที่ staff อนุมัติแล้วเป็นการตอบของ staff (C-23) · seam ในอนาคตคือ agent/route/ADR ใหม่ที่ผ่าน policy gate ของ N3 ไม่ใช่การเพิ่ม role

### 7. Boundaries, packages, migrations, scope
- **ADR-002 matrix ไม่เปลี่ยน:** tool host และ reader อยู่ `apps/api` · `packages/ai` ได้แค่ prompt/agent/limiter (ไม่มี DB/HTTP) · `packages/shared` มี contract (context, SSE event, memory, claim kinds, permission rule) · `apps/web` มี page registry + SSE client + memory UI · `apps/worker` มี `WORKER_AI_MAX_CONCURRENCY` · ไม่แตะ `packages/channels`/`connectors`
- **ไฟล์หลัก:** `apps/api/src/assistant/{assistant-access,assistant.service,assistant.controller}.ts`, `apps/api/src/assistant/tools/*` (ใหม่), `apps/api/src/auth/permission-rule.ts` (evaluator ร่วมกับ guard, ใหม่), `apps/api/src/database/read-only.ts` (`readOnlyPool`, `runReadOnly`), `packages/ai/src/agents/assistant.ts` (path llm1/llm2, `neutralize` tag ใหม่), `packages/ai/prompts/assistant_turn.v1.md` (ใหม่; `assistant_plan/answer.v1` คงไว้ให้ llm2), `packages/ai/src/live/concurrency-limit.ts` (ย้าย), `packages/shared/src/features/{assistant,claims}.ts`, `packages/shared/src/rbac.ts` (`assistant.use`, `WORKSPACE_ROLES`), `apps/web/src/lib/assistant/*`, `apps/web/src/components/assistant/*`, `config/budgets.yaml` (`assistant.tool_rate_per_hour`, `memory_max`) · reader ที่ยังขาดให้เพิ่มใน module เจ้าของ
- **Migration `0112_assistant_stage1`** (+ `.down.sql`): `assistant_memory` · `assistant_message.evidence jsonb not null default '[]'`, `assistant_message.path text` · seed `assistant.use` ให้ agent/lead/head/dev · ไม่แก้ `ai_run`
- **Migration `0113_element_insights`** (§9.2) แยกจาก 0112 · รวมการขยาย CHECK ของ `ai_summary.kind` เป็น `('brief','handoff','my_work')`
- **นอก scope stage 1:** write ใด ๆ ที่ AI ทำเอง, memory ที่ model เขียน, memory ที่พิมพ์เองใน settings (C-7), proactive (AI ส่ง push/notification/alert เอง — insight ที่แสดงในหน้าตอนคนเปิดอยู่ใน scope ตาม §9), narration ต่อผู้ใช้ **ยกเว้น `home.my_work` (§9.3, เจ้าของ 2026-11-05)**, voice, portal/ลูกค้า, MCP endpoint สำหรับ client ภายนอก, audit/ai_run tool, ad-hoc query, การแชร์สนทนา
- **ADR-023 proposal cards (main thread ตัดสิน 2026-11-05 ตามคำแนะนำ po):** ไม่เพิ่มชนิดใหม่ · 7 ชนิดเดิม (คนกดเอง ผ่าน service เดิม — ไม่ใช่ AI write ตาม N2) คงอยู่หลัง flag `ASSISTANT_PROPOSALS=on|off` default `on` · การ์ดที่เกิดใน turn ที่มี fact `trust:'customer'` แสดงป้าย "สร้างจากบทสนทนาที่มีข้อความลูกค้า — ตรวจก่อนกด / Created from a conversation with customer text — review before confirming" (C-22)
- **Seam stage 2 (proactive):** `buildAssistantHost(principal)` เป็น pure function ของ principal ให้ worker ประกอบ principal จาก DB แล้วรัน turn เมื่อมี trigger · ส่งออกผ่าน notification/realtime เดิม · ต้องมี ADR ใหม่ (principal ไม่มี session, งบ, opt-out) · (การสร้าง facts ของ `home.my_work` ใน worker ตาม §9.3 ไม่ใช่ turn และไม่ส่งอะไรออก จึงไม่ถือเป็น stage 2)
- **Seam stage 3 (actions):** tool ที่เขียนได้ต้องผ่าน `decide()`/policy gate (ADR-011) + proposal/confirm ของ ADR-023 · registry ปฏิเสธ `readOnly:false` จนกว่าจะมี ADR · MCP surface (PRD §6.3) ใช้ catalogue เดียวกัน

### 8. Testing / eval
- **Unit:** Zod in/out ทุก tool, router `facts_only` (allow-list ไม่มี `investigate_run`), การตัด context, การตรวจ fact id ข้าม turn, `stripLinks`, SSE event schema, `neutralize` ปิด tag ใหม่, `evaluatePermissionRule`
- **RBAC leak (integration `apps/api`):** ตาราง tool × role (`agent`, `lead`, `head`, `dev` masked, staff custom ที่ไม่มี permission, `client`, `system`) · parity แบบเทียบผลของ guard + output ⊆ GET route · `dev` ไม่ได้ `incident_*`/`statuspage_status` · ref ไม่มีสิทธิ์ = ref ไม่มีจริง · arg `userId` ของคนอื่นเมื่อถือแค่ `.own` ถูกเมิน · memory/conversation ของคนอื่น 404 · cache ไม่ข้ามผู้ใช้และไม่รอดการถอนสิทธิ์ · เสียสิทธิ์หลังคุย = chip "ไม่มีสิทธิ์" · `client` ที่ได้ `assistant.use` ยัง 403 · "ถามสิ่งที่หน้าจอปฏิเสธ → AI ปฏิเสธเหมือนกัน" · tool INSERT → `25006` · audit ล้ม → ไม่มี `reply` · kill switch → ไม่มี tool รัน (รวม `facts_only`)
- **Injection:** fixture ที่ ticket/conversation/KB/handoff note/alert มีคำสั่ง (เรียก tool อื่น, ใส่ URL, ขอข้อมูล org อื่น, ปลอม `<tool_results>`/`<untrusted_content>`/`<user_notes>`) → ≤ 2 call, ไม่มี URL, ไม่มี fact นอกสิทธิ์, tag ถูก neutralize, **ไม่มี tool ที่ request ไม่ได้ขอ และไม่มี `investigate_run` เมื่อ call เห็น untrusted content** · mock ใน CI ส่วน live provider ทดสอบด้วยมือ `[ASK-HUMAN]`
- **Eval set:** `evals/golden/assistant.json` (agent ผู้ผลิตแก้ไม่ได้ — agent เสนอใน `evals/proposals/` แล้ว main thread/เจ้าของเพิ่มพร้อม `evals/GOLDEN-REVIEW.md`) · เคส `{role, page, entity?, question(th|en), seed fixture, expect: {mustCiteRefs[], mustNotMention[], path?, maxUncited}}` · ทุก module ≥ 3 เคส + masked dev + เคส "ไม่มีข้อมูล/ไม่มีสิทธิ์" · เกณฑ์เบื้องต้น citation recall ≥ 90%, leak = 0, uncited ≤ 1 ต่อคำตอบ `[ASSUMED]`
- **Latency/คิว:** fake bridge หน่วง 5–10 s ตรวจ `queued.position`, timeout 60 s, abort แล้ว slot คืน, worker + api ≤ 4

### 9. AI ฝังในทุก element (embedded insights)
> เจ้าของ `[CONFIRMED 2026-11-05]`: "ทุก element ควรมี AI อยู่ในตัว (daily brief, stat report) ไม่ใช่แค่ bubble ที่รอคนถาม" และ "ไม่ realtime: cache insight แล้วคำนวณใหม่เบื้องหลังเมื่อมี event ที่เกี่ยวข้อง, ออกแบบให้ใช้ AI อย่างมีประสิทธิภาพ" · ยังเป็น stage 1 คือ read-only ไม่มี action · **AI ไม่ส่ง push/notification/alert เอง** (แสดงเฉพาะตอนคนเปิด element) · staff ทุก role ภายใน RBAC ไม่มีลูกค้า · **ห้ามเรียก LLM ต่อการเปิดดู**
> เจ้าของ `[CONFIRMED 2026-11-05]` ("ข."): element รายคน/ต่อผู้ใช้ (`dashboard.ops.team`, `shift.overview`, `home.my_work`) ได้โหมด N ภายใต้กฎ §9.9 · **หน้า admin (intent/gate/autonomy, status page admin, admin ai/integrations/outbox/queues) เป็น F อย่างเดียว** — ไม่ให้ LLM ชักจูงการเลื่อน stage (N3) หรือบรรยาย config · งบ `insights.*` ใช้ค่าใน 9.4 `[ASSUMED]` ปรับได้ใน `config/budgets.yaml`

#### 9.1 Inventory และโหมดต่อ element
โหมด: **R** = มี AI อยู่แล้ว ใช้ของเดิม (N6) · **F** = facts deterministic + template TH/EN ไม่มี LLM · **N** = F + narration จาก LLM ที่ worker ทำล่วงหน้า · **X** = ไม่ทำใน stage 1 · wave **9a** = ทำก่อน (pilot), **9b** = ทีหลัง · คอลัมน์ "คน" = facts มี ref kind `user` (ใช้กฎ §9.9)

| element key | ที่อยู่ (`apps/web/src/components/…`) | rule (= GET route) · scope | AI ที่มีอยู่แล้ว | โหมด | คน | wave |
|---|---|---|---|---|---|---|
| `home.my_work` | `home/home-sections` (OpenTickets, SlaRisk) | `anyOf(ticket.read, ticket.read.masked)` · user | — | F ตอนอ่าน (9a) → N ผ่าน `ai_summary` kind `my_work` (9b) | ตัวเอง | 9a/9b |
| `home.volume` | `home/home-volume` | `ticket.read` · instance `[UNVERIFIED 60%]` | — | N | — | 9b |
| `home.team` | `home/home-team` (= `GET /v1/shifts/overview`) | ใช้ `shift.overview` | — | ใช้ `shift.overview` | ✓ | 9a |
| `home.status` | `home/home-status` | `dashboard.ops.read` `[UNVERIFIED]` · instance | — | F | — | 9b |
| `dashboard.ops.{now,volume,sla,reliability,services}` | `dashboard/sections` | `dashboard.ops.read` · instance · period `d{days}` | — | N (`sla`, `volume` ใน 9a) | — | 9a/9b |
| `dashboard.ops.quality` | `dashboard/sections` | `csat.read` | — | N | — | 9b |
| `dashboard.ops.ai` / `dashboard.ops.grades` | `sections`, `grades-section` | `ai.run.read` | grades เป็นตัวเลขอย่างเดียว | F | — | 9b |
| `dashboard.ops.team` | `dashboard/sections` | `performance.read.all` · instance | — | **N (กฎ §9.9)** | ✓ | 9b |
| `dashboard.ops.usage` | `dashboard/sections` | `metric.read` | — | N | — | 9b |
| `reports.ai_cost` | `reports/ai-cost-page` | `ai.run.read` · instance | — | N | — | 9b |
| `reports.ceo.*` | `reports/ceo-page` | `ceo.view` | **weekly brief** | F ต่อ figure + R weekly brief | — | 9b |
| `shift.brief` | `shift/brief-page` | `shift.clock` · user | **`ai_summary` kind `brief`** | R | — | — |
| `shift.handoff` | `shift/handoff-page` | `handoff.write` · user | **prefill (`ai_summary` kind `handoff`)** | R | — | — |
| `shift.overview` | `shift/overview-page` | `anyOf(roster.manage, performance.read.all)` `[TESTED]` · instance | — | **N (กฎ §9.9)** | ✓ | 9a |
| `shift.notes` | `shift/notes-page` | `shift.note.write` | — | X (free text ของ staff) | — | — |
| `queue.list` | `queue/queue-pane` | rule ของ queue route · user (filter/view ของผู้ดู) | — | **F คำนวณตอนอ่าน** บน filter/view ปัจจุบัน (เช่น "{n} รายการในมุมมองนี้ใกล้ผิด SLA") | — | 9b |
| ticket workspace | `ticket/*`, `ai/*` | ตาม ADR-023 | **`ai_ticket_insight`, investigation, draft, grade, priority** | R | — | — |
| conversation / other-mail | `conversation/conversation-pane` | `inbound.read` | **`AiBrief`** | R (list = X) | — | — |
| `incidents.open` | `ops/incidents` (list) | `all(ticket.read)` `[TESTED]` · instance | — | N | — | **9a** |
| `incident.detail` | `ops/incidents` (detail) | `all(ticket.read)` · `incident:<id>` | comms-panel มี AI ไหม `[UNVERIFIED]` | N (สร้างเมื่อมีคนดู) | — | 9b |
| `alerts.noise` | `ops/alerts` | `alert.read` · instance | — | N | — | 9a |
| `alerts.services` | `ops/alerts/services-sections` | `alert.read` | — | F | — | 9b |
| `statuspage.admin` | `ops/status/*` | ตาม GET ของหน้านั้น | — | **F เท่านั้น (admin)** ห้ามไหลไปหน้าสาธารณะ | — | 9b |
| `org.health` | `ops/org-health-card` | `org.health.read` · `org:<id>` | — | N (สร้างเมื่อมีคนดู) | — | 9b |
| `admin.intents` / `admin.intent.gate` | `admin/intents/*` | `intent.manage` · `intent:<id>` | gate report `[UNVERIFIED]` | **F เท่านั้น (admin, N3)** | — | 9b |
| `admin.ai` / `admin.integrations` / `admin.outbox` / `admin.queues` | `admin/*` | `*.manage` ของหน้า | — | **F เท่านั้น (admin)** | — | 9b |
| roster planner | `admin/shifts/roster-planner` | `roster.manage` | **`roster_planner` agent** | R | — | — |
| KB | ไม่มีหน้าใน `(console)` `[TESTED]` | — | `kb_search` ใน ticket | X | — | — |
| admin users/audit/golden/sla/rbac | `admin/*` | — | — | X (§2 ไม่เปิด audit/user/rbac) | — | — |

**Wave 9a (pilot):** `home.my_work` (F), `home.team`/`shift.overview` (N, กฎ §9.9), `dashboard.ops.sla`, `dashboard.ops.volume`, `incidents.open` (N — ให้ role `agent` ได้ AI ในตัวตั้งแต่ pilot), `alerts.noise` · ที่เหลือเป็น 9b

#### 9.2 primitive: element registry + facts + narration
- **Registry** (`packages/shared/src/features/insights.ts`): `INSIGHT_ELEMENTS: Record<ElementKey, {route: 'GET /v1/…', rule: {all}|{anyOf}, scope: 'instance'|'org'|'intent'|'incident'|'service'|'user', periods: PeriodSpec, mode: 'F'|'N', personRefs: 'none'|'others'|'self', piiKind?: string, triggers: EventKind[], cadenceMinutes, materiality: MaterialityRule}>` · ตรวจ `rule` ด้วย evaluator เดียวกับ route (§2, C-1) · parity test: `rule` = metadata ของ decorator ของ `route` และผลการตรวจต่อ role จริงตรงกัน · `PeriodSpec` = รูปแบบ + ช่วงที่ route รองรับ (เช่น `d{1..90}`, `now`, `shift:<uuid ที่มีจริง>`, `w{ISO week ≤ 26 สัปดาห์ย้อนหลัง}`) (C-11)
- **Facts builder** (`packages/domain/src/insights/<element>.ts`): pure reader ที่รับ `{executor, scope, period, view: 'full'|'masked', subjectUserId?}` (ไม่รับ principal) คืน `{facts: InsightFact[], asOf}` โดย `InsightFact = {id, kind:'metric'|'delta'|'driver'|'state', value: number|enum, display:{th,en}, ref?:{kind,id}}` · **allow-list เท่านั้น**: ตัวเลข, enum, ref, ชื่อที่ staff ตั้ง (intent, service, queue, org) · **ไม่มีข้อความอิสระ** (subject, body, note, ข้อความ alert) · ref kind `user` มีได้เฉพาะ element ที่ `personRefs ≠ 'none'` (C-10) · `view:'masked'` ตัด fact ที่มี ref kind `org`/`contact` ออกตามกฎของ `maskInsight` · GET route กับ worker ใช้ builder เดียวกัน (ย้าย reader มาไว้ที่นี่ แบบ `figureFacts` ของ T-305c) ทำให้หน้าจอกับ insight มาจากข้อมูลชุดเดียวกัน
- **Deterministic ก่อน:** `delta(current, baseline7d)`, `share`, `topDrivers(groupBy, n≤3)` ในโค้ด · **groupBy ใช้เฉพาะ entity ใน catalog ที่ staff สร้าง** (intent, service, queue, org) ไม่ใช้ค่าที่มาจาก webhook/ลูกค้า (C-14) → claim แบบ F ประกอบจาก template `{templateId, params}` ตอนอ่านด้วย locale ของผู้ดู เช่น "backlog +18% จากค่าเฉลี่ย 7 วัน ส่วนใหญ่มาจาก intent X" · ทุก claim มี evidence ref
- **Narration (โหมด N):** LLM อ่าน facts (redact แล้ว) แล้วเขียน ≤ 3 claim ที่อ้าง fact id · เป็นชั้นบนของ F ไม่ได้แทน F
- **ตาราง (migration `0113_element_insights`):**
  ```
  ai_element_insight(
    id uuid pk default gen_random_uuid(),
    element text not null,              -- registry key
    scope_key text not null,            -- 'instance' | 'org:<uuid>' | 'intent:<uuid>' | 'incident:<uuid>' | 'service:<uuid>'
    period text not null,               -- 'd7' | 'now' | 'shift:<id>' | 'w2026-45'
    locale text not null check (locale in ('th','en')),
    org_id uuid null references organization on delete cascade,
    facts jsonb not null,               -- snapshot (allow-list, view 'full')
    facts_fingerprint text not null,    -- hash หลัง bucket (9.4)
    claims jsonb not null,              -- claimSchema; redacted + placeholder ผูก ref, evidence [{kind,id,factId}]
    prompt_id text not null, prompt_version text not null, model text not null,
    ai_run_id uuid null references ai_run on delete set null,
    mock boolean not null default false,
    generated_at timestamptz not null, expires_at timestamptz not null,
    unique (element, scope_key, period, locale))
  index (expires_at) · index (org_id) where org_id is not null · index (ai_run_id)
  ```
  ไม่ partition (แถวมีเพดานระดับหลักร้อยถึงหลักพัน) · `purgeExpired` รายวัน · **ไม่มี DB role แยก** (api/worker ใช้ `watchtower_app` เดียว): ผู้เขียนคือ worker โดย convention ซึ่งบังคับด้วย boundary lint (`apps/api` ห้าม import writer ของ insight) ไม่ได้บังคับด้วย grant (C-15) · scope ต่อผู้ใช้ไม่อยู่ในตารางนี้ (`home.my_work` ใช้ `ai_summary` kind `my_work`; `queue.list` เป็น F ตอนอ่าน ไม่เก็บ)
- **คนดูและ dirty mark อยู่ใน Redis:** `insight:viewed:{element}:{scope}:{period}` → sorted set ของ `(userId, locale)` TTL 24 ชม. (นับผู้ดูต่างคนได้) · `insight:dirty:{…}` → `{firstAt,lastAt}` · ต่อผู้ใช้: `insight:dirty:user:{userId}:{element}`

#### 9.3 การอ่าน, scope และสถานะ (กัน RBAC รั่ว)
- `GET /v1/insights?elements=a,b&scope=…&period=…` (≤ 12 element ต่อ call) · ผ่าน allowlist ของ §1 ก่อน แล้วจึง `assistant.use` · แต่ละ element ตรวจว่าผู้ดูผ่าน `rule` (evaluator ของ route) **และ** ผ่าน scope resolver (`org:<id>` → org reader ด้วย principal ของผู้ดู ฯลฯ) **และ** `period` ผ่าน `PeriodSpec` · ไม่ผ่าน = ไม่ส่ง element นั้น (ไม่บอกว่าไม่มีข้อมูลหรือไม่มีสิทธิ์)
- **กันการ flood (C-11):** rate limit ต่อผู้ใช้ของ `/v1/insights` (60 request/นาที `[ASSUMED]`) และ viewed mark (≤ 30 คู่ `(element,scope,period)` ต่างกันต่อผู้ใช้ต่อชั่วโมง เกินแล้วอ่านได้แต่ไม่ mark) · facts สดใช้ cache ต่อ `(element, scope, period, view)` 30 s แบบ **single-flight (บังคับ)** · builder ต่อ request ≤ 12 ตัวและรันขนานกันไม่เกิน 4
- **กฎกันรั่ว:** insight ของ scope S แสดงให้ P ได้ก็ต่อเมื่อ GET route ของ element คืน scope S เดียวกันให้ P · **invariance test**: ผลของ builder (`view:'full'`) = ข้อมูลที่ route คืนให้ principal ที่ผ่าน `rule` พอดี = ผลของ head · `view:'masked'` = ข้อมูลที่ route คืนให้ dev · element ที่ผลขึ้นกับตัวผู้ใช้ (filter/view ส่วนตัว, ทีมที่สังกัด `[UNVERIFIED]`, งานของฉัน) ใช้ scope `user` → F ตอนอ่าน (`queue.list`, `home.my_work` 9a) หรือ `ai_summary` kind `my_work` (`home.my_work` N, 9b) · **ไม่มี narration ต่อผู้ใช้อื่นนอกจาก `home.my_work`**
- **masked `dev` (PO P0 + C-1):** dev ได้ element เฉพาะที่ `rule` ผ่านจริง (route ที่ใช้ `ticket.read` แท้ เช่น `incidents.open`, `incident.detail`, `home.volume` ไม่ผ่าน ไม่มีข้อยกเว้น) · ใน element ที่ผ่าน dev ได้ **F เสมอ** จาก `view:'masked'` (allow-list ไม่มีข้อความลูกค้า) · narration ที่เก็บไว้ (สร้างจาก `view:'full'`) แสดงให้ dev **เฉพาะ claim ที่ evidence ไม่มี ref kind `org`/`contact`** และตัวเลขทุกตัวของ claim ยังเป็น subset ของ facts แบบ masked (ตรวจซ้ำด้วย `numbersSubsetOfFacts`) · ไม่เหลือ claim = แสดง F พร้อมป้าย "จากระบบ" · `home.my_work` ของ dev สร้าง facts ด้วย `view:'masked'` ตั้งแต่ต้น (ไม่มี org fact) จึงมี narration ได้
- **คำนวณ facts สดตอนอ่าน** (builder เดียวกับหน้าจอ) แล้วแนบ narration ที่เก็บไว้ · **การอ่านไม่มี LLM call** มีแค่ viewed mark (+ dirty mark ถ้า fingerprint ไม่ตรง) · element ที่ `piiKind` มีค่า (`shift.overview` = `shift_overview`, `dashboard.ops.team` = `performance`) เขียน `pii.read` เหมือน route (`@AuditPiiRead`) · ไม่มี subject ของ ticket → element อื่นไม่นับเป็น `pii.read`
- **สถานะและป้าย (AC-J17) — `InsightState` แยก 6 แบบ ห้ามรวมกัน ห้ามผสม TH/EN ในประโยคเดียว:**

  | state | เงื่อนไข (ตรวจตามลำดับ) | แสดง | ป้าย TH | ป้าย EN |
  |---|---|---|---|---|
  | `system` | element โหมด F (หรือ dev ที่ไม่เหลือ claim) | F | จากระบบ | From system |
  | `paused` | โหมด N และ kill switch เปิด / policy ปิด `insight_narrator` / provider offline | F (ซ่อน narration) | AI หยุดทำงาน — แสดงข้อมูลตรงจากระบบ | AI paused — showing system data |
  | `fresh` | มี narration ยังไม่หมดอายุ และ fingerprint ตรง | narration + F | AI · {n} นาทีที่แล้ว / AI · {n} ชม.ที่แล้ว | AI · {n}m ago / AI · {n}h ago |
  | `stale` | มี narration ยังไม่หมดอายุ แต่ fingerprint ไม่ตรง | F สดด้านบน + narration เดิมใต้ป้าย | สรุปก่อนข้อมูลล่าสุด | Summary predates latest data |
  | `budget` | ไม่มี narration ที่ใช้ได้ และ gate งบของ insights ปิดอยู่ (9.4) | F | สรุป AI พักชั่วคราว (ครบงบวันนี้) | AI summaries paused (daily budget reached) |
  | `none` | ไม่มี narration / หมดอายุแล้ว (งบยังเหลือ) | F | ยังไม่มีสรุป AI ล่าสุด — แสดงข้อมูลจากระบบ | No current AI summary — showing system data |

  API คืน `state` + `generatedAt` แล้ว web เลือกข้อความตาม locale จาก i18n key `insights.state.<state>` (ไม่ประกอบประโยคข้ามภาษา) · narration ที่ยัง fresh แสดงต่อได้แม้งบเพิ่งเต็ม (state = `fresh`)
- **Restore ตอนอ่าน:** placeholder ประกอบ label/href ใหม่จาก `ref` ด้วยสิทธิ์ของผู้ดู · ref ที่เปิดไม่ได้ = chip "ไม่มีสิทธิ์เข้าถึง / No access"
- **`home.my_work` (scope `user`, เก็บใน `ai_summary` kind `my_work`):** แถว `(my_work, user_id, locale)` ใช้ PK/fingerprint/`data_as_of` เดิม (ไม่ต้องมีตารางใหม่) · ตอนอ่าน: คำนวณ F สดจาก builder (`subjectUserId = principal.userId`, `view` ตามผู้ดู) · fingerprint ไม่ตรงหรือไม่มีแถว → ตั้ง `insight:dirty:user:{userId}:home.my_work` · **สร้างเฉพาะเมื่อเจ้าของแถวเปิดดูแล้วข้อมูลเปลี่ยนอย่างมีนัยสำคัญ (lazy)** · worker ประกอบ principal ของ user จาก DB ตอนสร้าง ถ้าไม่ผ่าน `rule` แล้ว = ไม่สร้างและลบแถว · ตอนอ่านตรวจ `rule` ซ้ำ · ไม่ batch ข้ามผู้ใช้ (กลุ่มผู้ดู = 1 คน) · งบใน 9.4 (`user_scoped_*`) · ไม่มี endpoint อ่านแถวของคนอื่น (head ก็อ่านไม่ได้)
- **`queue.list` (F, 9b):** คำนวณตอนอ่านบน filter/view ปัจจุบันของผู้ดู โดยใช้ query schema และ reader เดียวกับ queue route ภายใต้ principal ของผู้ดู · ไม่เก็บ ไม่ mark dirty ไม่มี LLM

#### 9.4 การสร้าง: event-driven + debounce + ประหยัด call
- **Trigger:** processor เดิมใน worker (ticket, alert, incident, shift/handoff, grade, autonomy) และ api ตอนอ่าน เรียก `markInsightDirty(eventKind, scope?)` → ตั้ง dirty mark ใน Redis (O(1)) · cadence สำรองต่อ element (เช่น 60 นาที) สำหรับสิ่งที่เปลี่ยนตามเวลา (SLA aging)
- **Tick** (`AI_JOBS.insightTick` ทุก 2 นาที, idempotent): เลือก dirty ที่ (1) `lastAt` ≥ debounce 3 นาที **หรือ** `firstAt` ≥ max wait 15 นาที (2) **มีคนดูใน 24 ชม.** (ไม่มี = ล้าง dirty แล้วข้าม) (3) narration ล่าสุดเก่ากว่า 30 นาที → builder → bucket → fingerprint · **เรียงตามจำนวนผู้ดูต่างคน** (มากก่อน) และ **cap builder ≤ 20 ตัวต่อ tick** (C-11) · shared scope มาก่อน user scope
- **Materiality:** fingerprint คำนวณจาก facts หลัง bucket (จำนวนเปลี่ยน ≥ 10% และ ≥ 3 หน่วย, % ปัดเป็นขั้น 5 pp, เซต top-3 driver, state enum) · เท่าเดิม = ไม่เรียก LLM (แค่ต่ออายุ) · เปลี่ยนและเป็นโหมด N = ส่งเข้าคิว narrate
- **Batch:** ≤ 4 element ที่มี **กลุ่มผู้ดูเดียวกัน** (`rule` + `scope_key` เท่ากัน) ต่อ call (prompt `element_insight.v1` คืน `{[elementKey]: {th?: claims, en?: claims}}`) · สร้างเฉพาะ locale ที่มีคนดู ทั้งสองภาษาใน call เดียว · ต่างกลุ่มผู้ดูห้าม batch ด้วยกัน · element ที่ `personRefs ≠ 'none'` batch ได้เฉพาะกับ element ที่มี `rule` เท่ากันพอดี · `home.my_work` batch ได้เฉพาะของ user คนเดียวกัน
- **Priority / slot:** queue `insights` concurrency 1 ต่ำสุด · `tryAcquire` จาก limiter ของ worker (§4) แบบไม่รอ และเฉพาะเมื่อ queue `ai` ไม่มีงานรอ → ใช้ ≤ 1 ใน 2 slot ของ worker ไม่แย่ง api · ไม่ได้ slot = รอ tick ถัดไป
- **Audit:** `createAuditedLlm` agent `insight_narrator` (ผ่าน CHECK regex เดิม) reuse การตรวจ claim/fact id ของ `summarizeClaims` · 1 call = 1 `ai_run` · `audit_log` `insight.generated` (element, scope, fingerprint, aiRunId; ไม่มีข้อความ)
- **งบ (`config/budgets.yaml` → env)** `[ASSUMED]`:
  ```yaml
  insights:                 # ทับด้วย INSIGHT_* · ใช้ร่วมกับ app_ai_daily
    calls_per_hour: 6
    calls_per_day: 60
    daily_tokens: 150000    # ≤ 30% ของ app_ai_daily.tokens
    stop_at_daily_percent: 60   # app_ai_daily ใช้ ≥ 60% → หยุด narration, F ยังทำงาน (state budget)
    max_batch_elements: 4
    min_interval_minutes: 30
    debounce_minutes: 3
    max_wait_minutes: 15
    viewed_within_hours: 24
    narration_ttl_hours: 6
    builders_per_tick: 20
    user_scoped_calls_per_day: 30       # home.my_work ทั้ง instance, อยู่ภายใน calls_per_day
    user_scoped_per_user_per_day: 4
    user_scoped_min_interval_minutes: 60
  ```
  ถึงเพดาน = ไม่มี narration ใหม่ (state `budget`) ส่วน F ยังทำงาน · `createAiGuard` ก่อนทุก call

#### 9.5 ความถูกต้องของ narration (N5)
- **ตัวเลขต้องมาจาก facts (ตรวจในโค้ด):** ดึงตัวเลขทุกตัว (อารบิก, ไทย ๐–๙, ทศนิยม, %, คอมมา, หน่วยเวลา) → normalize → ต้องอยู่ใน `value`/`display` ของ facts ที่ claim อ้าง · ไม่ผ่าน = ทิ้ง claim · ทิ้งหมด = ไม่เก็บ + metric `insight.narration_rejected{reason}`
- claim ต้องอ้าง fact id ของ call นี้ ≥ 1 · **ไม่ยอมให้มี uncited** · URL → `[link removed]` · ภาษาต้องตรง locale · element ที่มีคนต้องผ่าน §9.9 ด้วย
- UI: narration มี chip "AI" + เวลาสร้าง + citation (`ClaimLine`) · F มีป้าย "จากระบบ / From system" · ไม่แสดงตัวเลขความมั่นใจ

#### 9.6 UI
- `apps/web/src/components/insights/element-insight.tsx` (`<ElementInsight element scope period />`) วางที่หัวของ card/section · TanStack Query (`staleTime` 5 นาที, refetch เมื่อ focus, query key มี userId) · ไม่มี WebSocket/push · โหลดไม่ได้/ไม่มีสิทธิ์ = ไม่แสดง (card เดิมครบ) · ป้ายสถานะตาม §9.3
- **กฎ (PO P1): ทุก element ที่ไม่ใช่ X มีปุ่ม "ถาม AI เรื่องนี้ / Ask AI about this" เสมอ** รวม element ที่เป็น F อย่างเดียว (admin) · ปุ่มเปิด bubble พร้อม chip ของ element: `context.element = {key, scope, period}` (§1) → server ตรวจตาม 9.3 แล้ว prefetch facts สดเป็น `eN` → ส่วนใหญ่เป็น `llm1` (หรือ `facts_only` สำหรับ "อธิบายตัวเลขนี้") · ถ้า assistant ใช้ไม่ได้ (kill switch/งบ/offline) ปุ่มยังแสดงแต่ disabled พร้อมเหตุผลตาม §6 · element admin ที่ถามผ่าน bubble ยังอยู่ภายใต้ §2 (ไม่มี tool ของ credential, `autonomy_status` อ่านอย่างเดียว)
- 👍/👎 + reason (`wrong_number|not_useful|misleading|judges_person|other`) ผ่าน feedback ของ §5 (target `{kind:'insight', id}`) · **server ตรวจสิทธิ์ตาม 9.3 ก่อนรับ feedback** (ผู้ส่งต้องเห็น element/scope นั้นได้ ถ้าไม่ได้ = 404) (C-18)
- i18n: F ใช้ template ตอนอ่าน · narration แยกต่อ locale · locale ที่ยังไม่มี → F + state `none` + viewed mark ให้ tick ถัดไปสร้าง

#### 9.7 Security
- **N4:** facts มาจาก allow-list ไม่มีข้อความลูกค้า · ยังผ่าน `RedactedText` เสมอ (`complete:false` → ไม่เรียก model) · ชื่อ staff ใน facts ที่มีคนเข้า dictionary → model เห็นแค่ placeholder · claims เก็บแบบ redacted
- **Injection:** ไม่มีข้อความอิสระใน facts (บังคับที่โครงสร้าง) · ชื่อที่ staff ตั้งผ่าน `neutralizeTags` (รวม tag ของ `element_insight.v1`, C-13) · model ไม่มี tool/URL · ผลแย่สุดคือข้อความผิดซึ่ง 9.5/9.9 กรอง
- **N2:** builder ผ่าน `runReadOnly()` (pool RO, §2) · narrate job เขียนได้แค่แถว insight / `ai_summary` kind `my_work`
- **ไม่รั่ว:** 9.3 + batch เฉพาะกลุ่มผู้ดูเดียวกัน + query key ของ client มี userId · ห้ามผสม scope `org` ข้าม org
- **ลูกค้า:** `/v1/insights` อยู่ใน walk ของ client ใน `routes-policy.test` (client/portal/magic-link = 403) · layout portal/`/status`/`/csat` ไม่ import `insights/*` · `statuspage.admin` เป็น F และไม่ไหลไปหน้าสาธารณะ/outbound
- **ไม่ push:** ไม่มี notification/Discord/email/realtime จาก insight (proactive = stage 2)

#### 9.8 Packages, migration, testing
- **Packages (ADR-002 matrix ไม่เปลี่ยน):** `shared` (registry, schemas, template, `numbersSubsetOfFacts`, `personToneCheck`, `InsightState`) · `domain` (facts builder, delta/drivers/bucket) · `ai` (`insight-narrate.ts`, `element_insight.v1.md`) · `db` (0113) · `worker` (tick, dirty/viewed, narrate, queue `insights`) · `api` (`InsightsController`, scope resolver, `context.element`) · `web` (`<ElementInsight>`) · `config/budgets.yaml` · แก้ comment ของ `packages/domain` ใน `tools/eslint/boundaries.mjs` เป็น "write logic + read-only fact builders ที่ api/worker ใช้ร่วมกัน (ADR-029 §9)"
- **Migration แยก `0113_element_insights`** (+ down = drop table + คืน CHECK ของ `ai_summary.kind` หลังลบแถว `my_work`) ไม่รวมกับ 0112 เพื่อให้ T-401 ไม่ต้องรอ และ rollback แยกกันได้
- **Unit:** bucket/materiality, debounce + max wait, gating ของ tick (ไม่มีคนดู/งบ/queue `ai` มีงาน/kill switch), เรียงตามผู้ดู + cap, batch grouping, `numbersSubsetOfFacts` (เลขไทย, %, คอมมา, ทศนิยม), `personToneCheck`, `PeriodSpec`, ลำดับการเลือก `InsightState` (6 แบบ), template TH/EN, Zod
- **Integration (api):** element × role (+ dev masked, custom, `client`, `system`), parity ของ `rule` = decorator และผลของ guard, invariance (full และ masked), dev ไม่เห็น claim ที่อ้าง org, scope `org` ที่ไม่มีสิทธิ์ไม่อยู่ใน response, period นอก spec = ไม่มีใน response, rate limit, การอ่านไม่สร้าง `ai_run`, `pii.read` ของ element ที่มีคน, `home.my_work` ของคนอื่นอ่านไม่ได้
- **Worker:** fake bridge 5–10 s: insight ไม่ทำให้ job `ai` รอ, api+worker ≤ 4 slot, fingerprint เดิม = 0 call, ไม่มีคนดู = 0 call, `my_work` ไม่เกิน per-user cap, user ที่เสียสิทธิ์ = ไม่สร้าง
- **Eval:** เสนอใน `evals/proposals/insights.json` (เจ้าของ/main thread อนุมัติเข้า golden, N7) · ตรวจ: hallucinated number = 0, พูดถึง driver ที่กำหนด, uncited = 0, ภาษาตรง, ไม่มีข้อมูลลูกค้า · ≥ 3 เคสต่อ element โหมด N + เคส "ไม่มีอะไรเปลี่ยน" + **เคสของ §9.9** (ข้อมูลรายคนที่ชวนให้จัดอันดับ เช่นคนหนึ่งถือ 3 เท่าของอีกคน → ต้องไม่มีอันดับ/คำตัดสิน/คำแนะนำรายคน)

#### 9.9 Narration ที่มีข้อมูลรายคน (`personRefs ≠ 'none'`; เจ้าของ 2026-11-05 ใช้แทน C-10 "F only")
ใช้กับ `shift.overview`/`home.team` และ `dashboard.ops.team` (`others`) และ `home.my_work` (`self`)
- **คนที่เห็นได้:** แสดงเฉพาะ principal ที่ GET route ของ element แสดงข้อมูลของคนนั้นอยู่แล้ว — `shift.overview` = `anyOf(roster.manage, performance.read.all)` · `dashboard.ops.team` = `performance.read.all` · `home.my_work` = เจ้าของแถวเท่านั้น · ตรวจด้วย evaluator ของ route ทุกการอ่าน · batch เฉพาะกลุ่มผู้ดูที่ `rule` เท่ากันพอดี (`shift.overview` กับ `dashboard.ops.team` ห้าม batch ด้วยกัน) · ผู้ถือ `performance.read.own` อย่างเดียวไม่เห็น narration ของคนอื่น
- **สิ่งที่ส่งให้ model:** facts allow-list (ตัวเลขต่อคน: ticket ที่ถือ, ใกล้ SLA, อยู่กะ/ไม่อยู่, ผลงานตามที่ route แสดง) โดยชื่อ staff เป็น placeholder ผ่าน dictionary (`complete:false` → ไม่เรียก) · ไม่มีข้อความอิสระ ไม่มีอีเมล/เบอร์ · `shift.overview` และ `dashboard.ops.team` เขียน `pii.read` ตอนอ่าน (เหมือน `@AuditPiiRead`) · residual: ตัวเลขรายคนแบบ pseudonymized ไปถึง provider — เจ้าของยอมรับตามคำตัดสิน "ข." `[CONFIRMED 2026-11-05]` · ADR-023 PII stores นับ `ai_element_insight` ด้วย
- **กฎของ prompt (`element_insight.v1` ส่วน person):** เขียนเป็นข้อเท็จจริงที่เป็นกลาง (ใคร/กี่รายการ/สถานะ) · **ห้ามจัดอันดับคน ห้ามเปรียบเทียบเชิงตัดสิน (ดี/แย่/ช้า/ขี้เกียจ/เก่งที่สุด) ห้ามแนะนำหรือสั่งการเกี่ยวกับบุคคล** (เช่น "ควรย้ายงานจาก A ไป B", "ควรคุยกับ A") · การบรรยายระดับทีม (รวม/สัดส่วน/จำนวนคนที่ถือเกินเกณฑ์) ทำได้ · `home.my_work` พูดถึงงาน ไม่ประเมินตัวผู้ใช้
- **กฎของ output (โค้ด, `personToneCheck`):** claim ที่ evidence มี ref kind `user` จะถูกทิ้งถ้า (ก) มีคำใน lexicon TH/EN ของการจัดอันดับ/ตัดสิน/แนะนำ (`ที่สุด`, `อันดับ`, `แย่`, `ดีกว่า`, `ช้ากว่า`, `ควร`, `ต้อง`, `แนะนำ`, `best`, `worst`, `top`, `rank`, `better`, `slower`, `should`, `must`, `recommend`, `underperform` ฯลฯ — list อยู่ใน `packages/shared`, ขยายได้) (ข) มีลำดับเลข/ตัวบ่งบอกอันดับ (`#1`, `ที่ 1`, `1st`) (ค) อ้าง ref `user` ≥ 2 ตัวในประโยคเชิงเปรียบเทียบ (`มากกว่า`/`น้อยกว่า`/`more than`/`less than` ระหว่างคน) · ทิ้งแล้ว metric `insight.narration_rejected{reason:'person_tone'}` · ทิ้งหมด = state `none`/F
- **Eval:** เคสบังคับใน `evals/proposals/insights.json` (§9.8) + 👎 reason `judges_person` · ตรวจซ้ำ (ลด element กลับเป็น F) เมื่อ `person_tone` rejected > 10% หรือ `judges_person` > 5% ของ feedback `[ASSUMED]`

### 10. DoD ที่มาจาก security review (C-12…C-23)
| C | งาน | DoD |
|---|---|---|
| C-12 | T-409 | cache key มี `permissionSetHash`, ไม่เก็บ token map, cache hit เขียน audit + `pii.read` + test ถอนสิทธิ์แล้ว cache ไม่ตอบ |
| C-13 | T-409, T-417 | `neutralize` ปิด `untrusted_content`, `user_notes` และ tag ของ `element_insight.v1` + test ปิด tag จากใน data |
| C-14 | T-403, T-405, T-415 | free text ที่ไม่ใช่ system ห่อ untrusted (note, KB, alert) · `topDrivers` groupBy เฉพาะ entity ใน catalog ของ staff + test |
| C-15 | T-414 | ไม่อ้าง grant แยก · lint ว่า api ไม่ import writer ของ insight |
| C-16 | T-404, T-410 | `performance_view` เมิน `userId` เมื่อถือแค่ `.own` + RBAC test "arg ของคนอื่น" |
| C-17 | T-401, T-411 | ตาราง tool → `piiKinds` ใน contract + test ว่าทุก tool ที่อ่าน PII เขียน `pii.read` |
| C-18 | T-408, T-416 | feedback ของ insight ตรวจสิทธิ์ตาม §9.3 ก่อนรับ (ไม่มีสิทธิ์ = 404) |
| C-19 | T-408, T-418 | ระบุเงื่อนไข api 1 replica / worker 1 process ใน README ops + warning ตอน boot · หรือย้าย limiter ไป Redis |
| C-20 | T-401 | `context_dropped` เก็บแค่จำนวนและ kind + test |
| C-21 | T-404 | `ceo_metrics` ส่งเฉพาะ aggregate ระดับ instance จนกว่าเจ้าของยอมรับตัวเลขรายองค์กร `[ASK-HUMAN]` |
| C-22 | T-407, T-409 | reply มี flag `hadCustomerContent` → การ์ด proposal แสดงป้ายเตือน + e2e |
| C-23 | T-411 | ตรวจว่า §6 ระบุแล้วว่า `reply_draft` หลังคนอนุมัติไม่ขัดคำตัดสิน "ลูกค้าไม่ได้ assistant" และไม่มีทางอื่นถึงลูกค้า (J14) |

### 11. Supersede ADR-023 (เฉพาะข้อที่ระบุ)
- **ADR-023 §1 "ไม่มี tool สำหรับ ... autonomy"** → superseded: เพิ่ม `autonomy_status` แบบ **อ่านอย่างเดียว** (stage ต่อ intent, ผล gate แบบ pass/fail, kill switch เปิด/ปิด) โดย rule = GET ของ `autonomy.controller` · เหตุผล: เจ้าของต้องการ "รู้ทุก module ภายในสิทธิ์" และข้อมูลชุดนี้ผู้ถือสิทธิ์เห็นบนหน้าจออยู่แล้ว · **การสั่ง** autonomy/emergency switch ยังไม่มี tool (คงตาม ADR-023) · insight ของ gate เป็น F (N3)
- **ADR-023 §1 "ไม่มี tool สำหรับ ... integration/credential"** → superseded **เฉพาะสถานะ** `{kind, connected, lastOkAt?}` ผ่าน `config_lookup` ที่ output เป็น allow-list (§2) · credential/metadata ของ credential/URL/endpoint ยังห้าม (คงตาม ADR-023 และ N1)
- **ADR-023 §1 route `@RequirePermission('ticket.read')`** → superseded ด้วย `assistant.use` + allowlist (§1) ซึ่ง ADR-023 เปิดทางไว้แล้ว ("`assistant.use` ทำทีหลังได้")
- **ADR-023 §7 ไม่ถูก supersede:** kill switch = ไม่มี model call และไม่มี tool รัน (รวม `facts_only`) ตาม §6

## Options considered
- **A — agent ต่อหน้า/ต่อ module** — prompt เฉพาะทาง / ของซ้ำ 10+ ชุด (N6), ถามข้าม module ไม่ได้, audit/eval กระจาย · ไม่เลือก
- **B — agent เดียว + catalogue เดียว + prefetch ต่อหน้า (เลือก)** — ตรง PRD §6.2 "one tool registry", ใช้ของ ADR-023 ได้หมด, RBAC อยู่ที่ tool จุดเดียว / รายการ tool ยาวขึ้น (ส่งเฉพาะที่ผู้ใช้มีสิทธิ์)
- **C — native tool-use loop ผ่าน `claude -p`** — ADR-017 ห้าม tool ใน bridge, จำนวน call ไม่แน่นอน, injection วนได้ · ไม่เลือก
- **Context:** เชื่อ client ถูกปฏิเสธ · server resolve ด้วยสิทธิ์ (เลือก)
- **Tool:** query ใหม่ใน tool ถูกปฏิเสธ · ห่อ reader ของ route + parity test แบบผลของ guard (เลือก) · parity แบบเทียบ string ถูกปฏิเสธ (C-1: ผ่านทั้งที่รั่ว)
- **Read-only:** `BEGIN READ ONLY` อย่างเดียว (reader ที่ใช้ `db` ตรงหลุดได้) ไม่เลือก · role DB ใหม่ (ต้องมี migration + secret ใหม่) ไม่เลือกตอนนี้ · pool RO + executor บังคับ (เลือก)
- **Memory:** memory อัตโนมัติจากสรุปสนทนา (write ของ AI + PII สะสม) ไม่เลือก · memory ที่พิมพ์เอง (redact ไม่ได้แบบ fail closed) เลื่อนไป · pinned fact จาก `redactedText` + บริบทกะเป็น tool (เลือก) · memory ร่วมของกะ (ข้ามคนไม่ผ่าน RBAC) ไม่เลือก
- **Streaming:** token streaming (ข้ามการตรวจ citation/redaction) ไม่เลือก · WebSocket ไม่เลือก · SSE แบบ phase (เลือก) · polling ไม่เลือก
- **Kill switch:** supersede ADR-023 §7 ให้ `facts_only` รันต่อ (ดีต่อ UX แต่ขยายความหมายของ kill switch) ไม่เลือก · ทำตาม ADR-023 §7 (เลือก) ซึ่งหน้าจอยังแสดงข้อมูลอยู่แล้ว
- **Element insights:** เรียก LLM ต่อการเปิดดู (5–10 s ต่อ card, slot ไม่พอ) ไม่เลือก · narration ต่อผู้ใช้ทุก element (call × จำนวนคน, RBAC กว้าง) ไม่เลือก ยกเว้น `home.my_work` แบบ lazy มีเพดาน · push/realtime เมื่อ insight เปลี่ยน (ขัด stage 1) ไม่เลือก · F อย่างเดียว (ไม่ตรงที่เจ้าของต้องการ) ไม่เลือก · ขยาย `ai_summary` ให้รองรับ shared scope (PK/lifecycle ต่างกัน) ไม่เลือก — แต่ใช้ `ai_summary` สำหรับ `my_work` ที่เป็นต่อผู้ใช้อยู่แล้ว (PK ตรง) · **เลือก:** facts สดตอนอ่าน + narration ที่ worker ทำตาม event/debounce/materiality ต่อกลุ่มผู้ดู
- **ข้อมูลรายคน:** F อย่างเดียว (C-10) — เจ้าของเลือก N · aggregate อย่างเดียว (ไม่มี user ref) — เสียสิ่งที่ lead ต้องการรู้ ("ใครถืออะไร") · **เลือก:** N ภายใต้กฎ §9.9 (คนเห็น = route, placeholder, prompt + `personToneCheck` + eval)
- **Concurrency:** เพิ่ม slot ของ api (แย่ง worker) ไม่เลือก · ส่งผ่าน queue worker (ADR-023 ปฏิเสธแล้ว) · `facts_only` + call เดียว + cap ฝั่ง worker (เลือก)

## Consequences
- งานที่ตามมา → `docs/BACKLOG.md` §Jarvis stage 1 (T-400…T-421) + DoD ใน §10
- ที่ยอมเสีย (§9): narration ช้ากว่าข้อมูลได้ ≤ 15–20 นาที (มีป้าย) · element admin ได้แค่ F · dev ได้ narration เฉพาะ claim ที่ไม่อ้าง org · `home.my_work` มี narration ≤ 4 ครั้ง/คน/วัน · narration ใช้งบ ≤ 30% ของ `app_ai_daily` · ตรวจซ้ำเมื่อ `narration_rejected` > 20%, 👎 > 30%, งบ insight เต็มบ่อย, `person_tone` > 10%
- ที่ยอมเสีย: assistant ที่ใช้ LLM ได้ครั้งละ 1 turn ทั้ง instance (มีคิวและตำแหน่ง) · ไม่ไหลเป็น token · audit/credential ถามไม่ได้ · kill switch ปิด assistant ทั้งหมดรวม `facts_only` · memory ที่พิมพ์เองยังไม่มี · api 1 replica / worker 1 process จนกว่าจะย้าย limiter ไป Redis
- ตรวจซ้ำเมื่อ: วัด latency จริงบน POC (เป้า p50 `facts_only` < 1 s, `llm1` < 12 s, รวม p95 ≤ 40 s `[ASSUMED]`) · api > 1 replica · เพิ่ม slot ของ bridge · เปิด stage 2/3 · `security-reviewer` ขอ encryption ของ `assistant_memory`
- `[ASK-HUMAN]` ที่ค้าง: เพิ่ม `CLAUDE_CLI_BRIDGE_MAX_CONCURRENCY` เกิน 4 (ขึ้นกับข้อจำกัดของ subscription `[VERIFY]`) · อนุมัติเคส eval ของ assistant/insights เข้า `evals/golden/` · ทดสอบ injection กับ live provider · `ceo_metrics` รายองค์กรไป provider (C-21) · จะให้ `facts_only` ทำงานระหว่าง kill switch หรือไม่ (ต้องเขียน ADR ใหม่)

## Links
- PRD §6.1, §6.2, §6.3, §6.6 · ADR-002, 008, 011, 012, 013, 014, 016, 017, 019, 021, 023 · `docs/decisions/T-400-security-review.md` · `apps/api/src/assistant/`, `apps/api/src/assistant/assistant-access.ts` (`holds()`), `apps/api/src/incidents/incidents.controller.ts`, `apps/api/src/statuspage/status-admin.controller.ts`, `apps/api/src/shifts/shifts.controller.ts`, `packages/db/migrations/0090_assistant.sql` (`ai_summary`), `packages/ai/src/agents/assistant.ts`, `apps/api/src/ai/concurrency-limit.ts`, `tools/claude-cli-bridge/bridge.mjs` (อ่าน 2026-11-05)
- `claude -p --output-format stream-json` — เอกสาร Claude Code CLI `[VERIFY]` · SSE ผ่าน Caddy `reverse_proxy` (flush) และ Cloud Run request timeout `[VERIFY]`
