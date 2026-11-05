# ADR-029 — Watchtower Assistant ("Jarvis") stage 1: AI ทุกจุดของผลิตภัณฑ์, รู้ทุก module ภายในสิทธิ์ของผู้ใช้, read-only

- **Status:** Proposed
- **Date:** 2026-11-05 (เวลากรุงเทพ) · **ผู้ตัดสิน:** เจ้าของ (scope) + main thread (การออกแบบ) · ผู้ร่าง `architect` · รอ `security-reviewer` + `po` ตรวจ (N7) ก่อน Accepted
- **Context:**
  - **เจ้าของ `[CONFIRMED 2026-11-05]`:** ทำแค่ stage 1 คือไม่มี write action และไม่มี proactive alert (เป็น stage ถัดไป) · AI ต้องเรียกใช้ได้จากทุกจุดของผลิตภัณฑ์ · **staff ทุก role ได้ assistant ยกเว้นลูกค้า** — customer portal และหน้าที่ลูกค้าเห็นอยู่นอก scope (ตัดสินแล้ว)
  - **main thread ตัดสิน:** แต่ละ role ใช้ได้ภายใน RBAC ของตัวเอง · provider คง `claude -p` ผ่าน `claude-bridge` (ADR-019/021) ~5–10 s ต่อ call `[UNVERIFIED]`, bridge concurrency 4, api max 2 · stage 1 เป็น text อย่างเดียว ไม่มี voice
  - **ของที่มีอยู่แล้ว `[TESTED: อ่านโค้ด 2026-11-05]`:** ADR-023 assistant (`POST /v1/assistant/messages`) รันด้วย principal ของผู้ใช้ มี tool 7 ตัวครอบแค่ ticket/KB/team/investigate (`apps/api/src/assistant/assistant-access.ts`) · แต่ละ turn เรียก model 2 ครั้ง (plan + answer, `packages/ai/src/agents/assistant.ts`) · citation ใช้ fact id `e1..eN` ที่ server ออก · context รับแค่ `page` + `ticket` (`assistantContextSchema`) · route ต้องมี `ticket.read`/`ticket.read.masked` · limiter ของ api สงวน 1 slot ให้ summary → assistant ทั้ง instance ใช้ได้ครั้งละ 1 call · bridge ตอบ JSON ก้อนเดียว ยังไม่มี streaming · WebSocket realtime มีแล้ว (กรองตาม audience) · ยังไม่มี MCP endpoint (PRD §6.3)
  - inventory ต่อหน้าจอ + AC-J1…J14 ของ `po` (2026-11-05) อยู่ใน `docs/BACKLOG.md` §Jarvis stage 1
  - PRD §6.1, §6.2 (Personal Assistant), §6.6 · N2, N3, N4, N5 · ADR-002, 008, 011, 013, 016, 023

## Decision

### 1. "สมอง" ตัวเดียว: agent `personal_assistant` ตัวเดิม + tool catalogue เดียวที่ครอบทุก module
- **ไม่สร้าง agent ต่อหน้า** ใช้ `runAssistantTurn` เดิมใน `packages/ai` แล้วขยาย catalogue ใน api (§2) · สิ่งที่ต่างระหว่างหน้าคือ **context และ prefetch** ไม่ใช่ตัว agent
- **ทุกจุดของผลิตภัณฑ์:** `AssistantBubble` ใน `ConsoleLayout` มีทุกหน้า console แล้ว ที่เพิ่มคือ (ก) page registry ใน web (`apps/web/src/lib/assistant/page-registry.ts`) map ทุก route ของ `(console)` → `page` + วิธีอ่าน entity จาก URL/selection (ข) จุด "Ask AI about this" บน row/card ของ entity (ticket, conversation, incident, alert, KB article, shift item, intent) เปิด bubble พร้อม chip ของ entity นั้น ผ่าน endpoint เดียวกัน (ค) palette "Ask AI" (Ctrl/⌘ K) ที่มีอยู่ · portal, `/status`, `/csat`, `/start`, `/login` ไม่มี bubble และ layout สาธารณะไม่ import assistant
- **Context จาก client เป็น hint ไม่ใช่สิทธิ์:** ขยาย `assistantContextSchema` (รองรับรูปเดิม)
  ```ts
  context: {
    page?: AssistantPage            // queue|ticket|conversations|incident|alert|statuspage|kb|shift|brief|handoff|roster|dashboard|reports|autonomy|admin|other
    entity?: { kind: AssistantEntityKind; ref: string }  // ticket|conversation|incident|alert|kb_article|handoff|intent|org|service
    selection?: { kind: AssistantEntityKind; refs: string[] /* ≤ 20 */ }
    ticket?: string                 // เดิม, = entity{kind:'ticket'}
  }
  ```
  server resolve ทุก ref **ด้วย reader ของ module นั้นภายใต้ principal ของผู้เรียก** · ref ที่ไม่มีจริงกับ ref ที่ไม่มีสิทธิ์ถูกทิ้งเหมือนกันทุกประการ (ไม่บอกว่ามีอยู่) บันทึกเป็น `context_dropped` · ไม่ส่งสิ่งที่ไม่ปรากฏเป็น chip (ไม่มี hidden context, ADR-023) · `page` ใช้แค่เลือก prefetch/starter ไม่ใช่สิทธิ์
- **Prefetch ด้วยโค้ด:** ถ้ามี entity บน chip server เรียก tool "สรุป entity" ของ kind นั้นก่อน model (เช่น `summarize_ticket`, `incident_get`) ใส่เป็น fact → ส่วนใหญ่ **ตอบได้ใน call เดียว** (§4)
- **ตัวตน:** principal ของ session เท่านั้น · route เปลี่ยนจาก `ticket.read|ticket.read.masked` เป็น permission ใหม่ **`assistant.use`** seed ให้ `agent`, `lead`, `head`, `dev` · `client` และ `system` ถูกปฏิเสธด้วยโค้ด **ก่อน** ตรวจ permission (แม้มีคนให้ `assistant.use` แก่ role ลูกค้าผ่าน `rbac.manage` ก็ใช้ไม่ได้) · staff ที่ไม่มี `ticket.read` (เช่นถือแค่ `ceo.view`) ใช้ได้ แต่ได้เฉพาะ tool ที่ตัวเองถือ permission

### 2. Tool design
- **ที่อยู่:** `apps/api/src/assistant/tools/<module>.tools.ts` ห่อ reader/service ที่ GET route ของ module นั้นใช้อยู่ · **ห้ามเขียน SQL ใหม่ใน tool** ถ้าไม่มี reader ให้เพิ่มใน module เจ้าของก่อน (N6, หน้าจอกับ AI อ่านข้อมูลชุดเดียวกัน) · `packages/ai` ไม่รู้จัก DB/HTTP รับแค่ `AssistantToolHost`
- **Catalogue stage 1** (ทุกตัว `readOnly: true`; permission = permission ของ GET route ที่ให้ข้อมูลเดียวกัน):

  | module | tools | permission (ต้องตรงกับ GET route) |
  |---|---|---|
  | tickets | `search_tickets`, `summarize_ticket`, `explain_sla` (เดิม), `ticket_timeline` | `ticket.read` / masked |
  | conversations | `conversation_search`, `conversation_get` (inbound/other-mail) | `inbound.read` |
  | incidents/alerts | `incident_search`, `incident_get` (timeline, deploy), `alert_search`, `alert_get` | ตาม GET ใน `incidents.controller`/`alerts` `[UNVERIFIED 60%]` — บังคับด้วย parity test |
  | status page | `statuspage_status`, `statuspage_drafts` | `ticket.read` (ข้อมูลสาธารณะ) / `incident.manage` |
  | KB | `kb_search` (เดิม), `kb_get` | `kb.read` |
  | shifts | `team_status`, `team_load` (เดิม), `shift_context` (กะปัจจุบัน, handoff item, shift notes), `roster_view` | `ticket.handle` / `handoff.write` หรือ `handoff.ack` / `roster.manage` |
  | reports | `ops_metrics`, `ceo_metrics`, `performance_view` | `dashboard.ops.read` / `ceo.view` / `performance.read.own\|all` |
  | autonomy | `autonomy_status` (stage ต่อ intent, gate report, kill switch) | ตาม GET ใน `autonomy.controller` |
  | admin config | `config_lookup` (SLA policy, queue, intent, workflow, สถานะ integration แบบ connected/not) | `*.manage` ของหน้านั้น |
  | investigate | `investigate_run` (เดิม) | `investigate.run` |

  - **ไม่มี tool (คงตาม ADR-023 §1):** credential/secret/API key (แม้เป็น metadata), `investigate.adhoc`, audit log, เนื้อหา `ai_run`, user/role/permission, emergency switch · ผู้ใช้ถาม → ตอบเป็นลิงก์ไปหน้านั้น · ไม่เปิด audit เพราะเป็นบันทึกของ assistant เอง, metadata เป็นทาง injection, คุ้มน้อย — ทบทวนใน stage ถัดไป (main thread ตัดสิน 2026-11-05)
- **RBAC สองชั้น ตรวจที่ server ทุกครั้ง:** (1) `toolsFor(principal)` สร้าง registry ต่อ request แบบ deny-by-default (2) handler ตรวจ permission ซ้ำ และ reader กรอง org/masking เอง · **parity test บังคับ:** ทุก tool × ทุก role output ⊆ สิ่งที่ GET route คืนให้ principal เดียวกัน และ permission ใน `TOOL_PERMISSION` ต้องตรงกับ decorator ของ route ที่ประกาศ (`toolRoute: 'GET /v1/…'`) ไม่ตรง = test ตก
- **Read-only ที่ DB:** handler ทุกตัวรันใน `BEGIN READ ONLY` + `statement_timeout` 3 s `[ASSUMED]` (wrapper `runReadOnly()` ใน api) (N2) · `investigate_run` ใช้ `watchtower_ai_ro` ของ ADR-013/016 เหมือนเดิม
- **Zod in/out:** ทุก tool มี `input`/`output` schema + unit test (valid + reject) · input `limit` ≤ 20 · output validate ก่อนสร้าง fact
- **ขนาดผล:** รายการ ≤ 20 แถว, `text` ของ fact ≤ 1 200 ตัวอักษรหลัง redact (`clipRedacted` redact ก่อนตัด) · fact ต่อ turn ≤ 30 · บริบทส่ง model ≤ 24 000 ตัวอักษร เกินให้ตัด fact อันดับต่ำ `[ASSUMED]`
- **Citation id:** tool คืน `facts[]` ที่มี `ref: {kind, id}` (id จริง) host ประกอบ ส่วน fact id `eN` ออกต่อ turn (§5)
- **Budget (N2):** `ASSISTANT_MAX_TOOL_CALLS` 4 ต่อ turn (ไม่นับ prefetch ที่โค้ดเรียก จำกัด 2) · `investigate_run` ≤ 1 · rate ต่อผู้ใช้ต่อ tool ผ่าน `RateLimiter` Redis (60 call/ชม./tool `[ASSUMED]`) · งบ token/ข้อความต่อผู้ใช้คงตาม ADR-023 §7 · `pii.read` ทุก entity ที่มี PII ที่ tool อ่าน (`metadata.via=assistant`)

### 3. Memory
- **Conversation turns:** ตาราง `assistant_conversation`/`assistant_message` เดิม เก็บ **ข้อความที่ redact แล้วเท่านั้น** อายุ 30 วัน · เพิ่ม `evidence jsonb` เก็บแค่ `[{kind,id}]` (ไม่เก็บ label/href) · ตอนแสดงประวัติ server ประกอบ label/href ใหม่ด้วยสิทธิ์ ณ ตอนนั้น (เสียสิทธิ์ = chip "ไม่มีสิทธิ์เข้าถึง") · เพิ่ม `path text` (`facts_only|llm1|llm2`) และ `context jsonb` ตาม §1
- **User-pinned facts (ใหม่):** ตาราง `assistant_memory`
  ```
  assistant_memory(id uuid pk, user_id uuid fk users on delete cascade, body text  -- redacted (N4), ≤ 300 chars
                   , refs jsonb  -- [{kind,id}] ≤ 5, resolve ใหม่ด้วยสิทธิ์ทุกครั้ง
                   , created_at, last_used_at, expires_at)
  index (user_id, last_used_at desc) · index (expires_at)
  ```
  ผู้ใช้สร้างเองเท่านั้น (ปุ่ม "จำไว้" บนคำตอบ หรือพิมพ์ใน settings) · model สร้างเองไม่ได้ (เป็น write ของ AI) · ≤ 20 แถวต่อคน · อายุ 90 วันจาก `last_used_at` (main thread ตัดสิน `[ASSUMED]`) · ใส่ prompt ≤ 10 แถว ห่อ `<user_notes>` เป็นข้อมูล ไม่ใช่คำสั่ง
- **Per-shift context: ไม่เก็บเป็น memory ของ AI** — tool `shift_context` อ่าน shift/handoff/notes ด้วยสิทธิ์ผู้เรียก · **ไม่มี memory ของ assistant ที่แชร์ข้ามผู้ใช้**
- **การเข้ารหัส:** ไม่เข้ารหัสระดับคอลัมน์ (เก็บเฉพาะที่ redact แล้ว, disk/backup encryption เป็นของ infra ADR-014) · ความเสี่ยงชื่อนอก dictionary หลุด `[UNVERIFIED 70%]` เหมือน ADR-023 จึงมีอายุและเพดาน · ใช้ envelope ADR-012 ได้ภายหลังโดยไม่เปลี่ยน API
- **ผู้ใช้ดูและล้างได้:** `GET/DELETE /v1/assistant/memory[/:id]`, `DELETE /v1/assistant/memory`, `GET /v1/assistant/conversations` (ของตัวเอง) · ไม่มี endpoint อ่านข้ามผู้ใช้ (head ก็ไม่ได้) · `purgeExpired` รายวัน · ตาราง PII stores ของ ADR-023 เพิ่ม `assistant_memory`

### 4. Latency / concurrency กับ `claude -p`
- **ลดจำนวน call ต่อ turn:**
  1. **`facts_only` (ไม่ใช้ LLM, ไม่กิน slot):** starter และคำถามที่มีโครง ("งานของฉัน", "อะไรเสี่ยง SLA", "ใครงานล้น", "สถานะทีม", "incident ที่เปิดอยู่", "กะนี้มีใคร") map ด้วยโค้ด (`starter.id` หรือ regex allow-list) ไป tool แล้วแสดง fact เป็น claim ด้วย template TH/EN (มี citation ทุก claim) ≤ 1 s · ไม่มี `ai_run` มีแค่ audit `assistant.message` `path=facts_only`
  2. **`llm1`:** prefetch แล้ว call เดียวด้วย prompt `assistant_turn.v1` คืน `{claims}` หรือ `{calls}`
  3. **`llm2`:** ได้ `{calls}` → รัน tool แล้ว answer อีก 1 call · **≤ 2 call ต่อ turn** ห้ามวน tool
  - ภายใต้ ADR-019 ทุก tier เป็น `sonnet` → tier ไม่ช่วยเรื่องเวลาบน claude-cli · path ที่ประหยัดจริงคือ `facts_only` · resolver ยังเรียก tier `light` ตามปกติ (ไม่ hardcode model)
- **Streaming = phase ไม่ใช่ token:** `POST /v1/assistant/messages` + `Accept: text/event-stream` ตอบ SSE: `queued{position}` → `context{chips resolved}` → `tool{name,status}` → `answering` → `reply{AssistantReply}` | `error{state,reason}` · ไม่ขอ SSE = JSON เดิม · **ไม่ stream token** เพราะต้องผ่านการตรวจ citation, `stripLinks`, restore placeholder, masking ก่อน (N4/N5) · ไม่ใช้ WebSocket เพราะ event เป็นของ request เดียว SSE ผูก abort/CSRF/คิวได้ตรงกว่า · Caddy/Cloud Run ต้องไม่ buffer `text/event-stream` `[VERIFY]` · event แรก ≤ 300 ms · ปุ่ม Stop ยกเลิกถึง bridge
- **Concurrency:** คง bridge 4 และ `AI_API_MAX_CONCURRENCY=2` (reserved 1 ให้ summary) → assistant 1 slot ต่อ process · คิว ≤ 8 รอ ≤ 60 s แสดงตำแหน่งผ่าน SSE · คิวเต็ม = `unavailable` + `reason: assistant_queue_full` · 1 turn ต่อคน (`assistant_busy`) · abort ผูกกับ request
- **อยู่ร่วมกับ worker:** เพิ่ม `WORKER_AI_MAX_CONCURRENCY` (default 2) ใช้ limiter ตัวเดียวกัน (`concurrency-limit.ts` ย้ายไป `packages/ai/src/live/`) → api 2 + worker 2 = bridge 4 ปิดช่องว่าง "worker ไม่มีเพดาน" ของ ADR-023 · job ที่ได้ 429 `busy` retry ตามเดิม
- **Cache:** ไม่ cache ข้ามผู้ใช้ · cache ต่อผู้ใช้เฉพาะ `facts_only` และ starter ที่ใช้ LLM key `(user, starter.id, locale, prompt version, fingerprint ของ fact)` ใน Redis 10 นาที เก็บข้อความที่ redact + `ref` แล้ว restore ใหม่ทุกครั้ง · ต้องมี test ว่า token ออกตามลำดับ deterministic `[UNVERIFIED 60%]` ไม่ผ่าน = cache เฉพาะ `facts_only`
- **12-factor / GCP:** ค่าจาก env · limiter และ `assistant_busy` ต่อ process `[ASSUMED]` · api > 1 replica ต้องทำ `ConcurrencyLimit` บน Redis ก่อน

### 5. Citations
- **รูปแบบ:** `claimSchema` เดิม `{text, evidence:[{kind,label,href?,mock?}], uncited?}` · เพิ่ม `ref?: {kind,id}` ใน evidence · ขยาย `CLAIM_EVIDENCE_KINDS`: `conversation`, `statuspage`, `shift`, `metric`, `intent`, `config`
- **การตรวจ:** model อ้างได้แค่ `eN` ที่ออกใน **turn นี้** id นอกตารางถูกทิ้ง claim ที่ไม่เหลือ evidence ได้ `uncited: true` · ประวัติ turn เก่าเข้า prompt เป็นข้อความเท่านั้น ไม่มี fact id · href ประกอบโดย server จาก `ref` (`assistant-hrefs.ts`) เฉพาะหน้าที่ผู้ใช้เปิดได้ · URL ในข้อความ model → `[link removed]`
- **UI contract:** `ClaimLine` เดิม · uncited = ตัวเอียงจาง + ป้าย "ไม่มีหลักฐาน" · คำถามเชิงข้อเท็จจริงที่ทุก claim uncited → แถบ "คำตอบนี้ไม่มีหลักฐานจากระบบ" · `mock` = ป้าย "ตัวอย่าง" · ไม่แสดงตัวเลขความมั่นใจ · ปุ่ม 👍/👎 + reason code (metric)

### 6. Security
- **Prompt injection (content คือ data):** fact มี `trust: 'system' | 'staff' | 'customer'` · ข้อความลูกค้าห่อ `<untrusted_content>` ผ่าน `neutralizeTags` · ด่านที่ไม่พึ่ง prompt: (ก) tool อยู่ใน allow-list ของผู้ใช้ ผลแย่สุดคืออ่านสิ่งที่ผู้ใช้อ่านได้อยู่แล้วให้คนเดิม (ข) ไม่มี write tool / outbound / URL จาก model และ UI เรนเดอร์ plain text → ไม่มีช่อง exfiltration (ค) ≤ 2 call, ≤ 4 tool ต่อ turn (ง) argument ผ่าน Zod, ref resolve ด้วยสิทธิ์ · ความเสียหายที่เหลือคือคำตอบผิด ซึ่ง citation/uncited ทำให้เห็น
- **RBAC:** §1–§2 · masked `dev` ตาม ADR-023 (`maskInsight`) และ tool ใหม่ที่คืนข้อมูลลูกค้าต้องผ่าน masking ตัวเดียวกับ route (parity test ครอบ)
- **Audit (N4):** ทุก model call → `ai_run` ผ่าน `createAuditedLlm` (agent `personal_assistant`, prompt id/version/hash, model, tier, tools, tokens, cost, latency, HMAC ของ input) · ทุก turn → `audit_log` `assistant.message` (`path`, tool, `aiRunIds`, entity ids ที่อ่าน, ไม่มีข้อความ) · `pii.read` ต่อ entity · `assistant.memory.create/delete`
- **Redaction:** ทุก byte ผ่าน `RedactedText` (ADR-008/023) · dictionary ครอบชื่อ org ของ **ทุก entity บน chip/selection** · รายชื่อไม่ครบ (`complete:false`) = ไม่ส่งอะไรไป model (fail closed)
- **Kill switch / budget:** `createAiGuard` ก่อนทุก call · ระหว่าง kill switch `facts_only` ยังทำงาน (ไม่ใช่ AI call) UI บอก "AI paused — แสดงข้อมูลตรงจากระบบ" `[ASSUMED]` po ยืนยัน
- **ลูกค้า (เจ้าของตัดสินแล้ว):** ไม่มี assistant บน portal หรือหน้าที่ลูกค้าเห็น · `client`/`system` ถูกปฏิเสธด้วยโค้ด · ทุก endpoint `/v1/assistant/**` (รวม SSE, memory, conversations) ได้ 403 สำหรับ client และ session portal/magic-link — `routes-policy.test` ตกทันทีถ้า endpoint ใหม่เปิดให้ client · ผลของ assistant ไม่ถูกส่งออก outbound/portal/status page (`reply_draft` ยังผ่าน draft → คนอนุมัติ N3) · seam ในอนาคต: agent/route/ADR ใหม่ที่ผ่าน policy gate ของ N3 ไม่ใช่การเพิ่ม role

### 7. Boundaries, packages, migrations, scope
- **ADR-002 matrix ไม่เปลี่ยน:** tool host และ reader อยู่ `apps/api` · `packages/ai` ได้แค่ prompt/agent/limiter (ไม่มี DB/HTTP) · `packages/shared` มี contract (context, SSE event, memory, claim kinds) · `apps/web` page registry + SSE client + memory UI · `apps/worker` `WORKER_AI_MAX_CONCURRENCY` · ไม่แตะ `packages/channels`/`connectors`
- **ไฟล์หลัก:** `apps/api/src/assistant/{assistant-access,assistant.service,assistant.controller}.ts`, `apps/api/src/assistant/tools/*` (ใหม่), `packages/ai/src/agents/assistant.ts` (path llm1/llm2), `packages/ai/prompts/assistant_turn.v1.md` (ใหม่; `assistant_plan/answer.v1` คงไว้ให้ llm2), `packages/ai/src/live/concurrency-limit.ts` (ย้าย), `packages/shared/src/features/{assistant,claims}.ts`, `packages/shared/src/rbac.ts` (`assistant.use`), `apps/web/src/lib/assistant/*`, `apps/web/src/components/assistant/*`, `config/budgets.yaml` (`assistant.tool_rate_per_hour`, `memory_max`) · reader ที่ขาดเพิ่มใน module เจ้าของ
- **Migration `0112_assistant_stage1`** (+ `.down.sql`): `assistant_memory` · `assistant_message.evidence jsonb not null default '[]'`, `assistant_message.path text` · seed `assistant.use` ให้ agent/lead/head/dev · ไม่แก้ `ai_run`
- **นอก scope stage 1:** write ใด ๆ ที่ AI ทำเอง, memory ที่ model เขียน, proactive, voice, portal/ลูกค้า, MCP endpoint สำหรับ client ภายนอก, audit/ai_run tool, ad-hoc query, การแชร์สนทนา
- **ADR-023 proposal cards (main thread ตัดสิน 2026-11-05 ตามคำแนะนำ po):** ไม่เพิ่มชนิดใหม่ · 7 ชนิดเดิม (คนกดเอง ผ่าน service เดิม — ไม่ใช่ AI write ตาม N2) คงอยู่หลัง flag `ASSISTANT_PROPOSALS=on|off` default `on`
- **Seam stage 2 (proactive):** `buildAssistantHost(principal)` เป็น pure function ของ principal ให้ worker ประกอบ principal จาก DB แล้วรัน turn เมื่อมี trigger · ส่งออกผ่าน notification/realtime เดิม · ต้องมี ADR ใหม่ (principal ไม่มี session, งบ, opt-out)
- **Seam stage 3 (actions):** tool ที่เขียนได้ผ่าน `decide()`/policy gate (ADR-011) + proposal/confirm ของ ADR-023 · `readOnly:false` ถูก registry ปฏิเสธจนกว่าจะมี ADR · MCP surface (PRD §6.3) ใช้ catalogue เดียวกัน

### 8. Testing / eval
- **Unit:** Zod in/out ทุก tool, router `facts_only`, การตัด context, การตรวจ fact id ข้าม turn, `stripLinks`, SSE event schema
- **RBAC leak (integration `apps/api`):** ตาราง tool × role (`agent`, `lead`, `head`, `dev` masked, staff custom ไม่มี permission, `client`, `system`) · parity output ⊆ GET route · ref ไม่มีสิทธิ์ = ref ไม่มีจริง · memory/conversation ของคนอื่น 404 · cache ไม่ข้ามผู้ใช้ · เสียสิทธิ์หลังคุย = chip "ไม่มีสิทธิ์" · `client` ที่ได้ `assistant.use` ยัง 403 · "ถามสิ่งที่หน้าจอปฏิเสธ → AI ปฏิเสธเหมือนกัน"
- **Injection:** fixture ที่ ticket/conversation/KB/handoff note มีคำสั่ง (เรียก tool อื่น, ใส่ URL, ขอข้อมูล org อื่น, ปลอม `<tool_results>`) → ≤ 2 call, ไม่มี URL, ไม่มี fact นอกสิทธิ์, tag ถูก neutralize · mock ใน CI, live provider ด้วยมือ `[ASK-HUMAN]`
- **Eval set:** `evals/golden/assistant.json` (agent ผู้ผลิตแก้ไม่ได้ — agent เสนอใน `evals/proposals/`, main thread/เจ้าของเพิ่มพร้อม `evals/GOLDEN-REVIEW.md`) · เคส `{role, page, entity?, question(th|en), seed fixture, expect: {mustCiteRefs[], mustNotMention[], path?, maxUncited}}` · ทุก module ≥ 3 เคส, masked dev, เคส "ไม่มีข้อมูล/ไม่มีสิทธิ์" · เกณฑ์เบื้องต้น citation recall ≥ 90%, leak = 0, uncited ≤ 1 ต่อคำตอบ `[ASSUMED]`
- **Latency/คิว:** fake bridge หน่วง 5–10 s ตรวจ `queued.position`, timeout 60 s, abort แล้ว slot คืน, worker + api ≤ 4

## Options considered
- **A — agent ต่อหน้า/ต่อ module** — prompt เฉพาะทาง / ของซ้ำ 10+ ชุด (N6), ถามข้าม module ไม่ได้, audit/eval กระจาย · ไม่เลือก
- **B — agent เดียว + catalogue เดียว + prefetch ต่อหน้า (เลือก)** — ตรง PRD §6.2 "one tool registry", ใช้ของ ADR-023 ได้หมด, RBAC อยู่ที่ tool จุดเดียว / รายการ tool ยาวขึ้น (ส่งเฉพาะที่ผู้ใช้มีสิทธิ์)
- **C — native tool-use loop ผ่าน `claude -p`** — ADR-017 ห้าม tool ใน bridge, จำนวน call ไม่แน่นอน, injection วนได้ · ไม่เลือก
- **Context:** เชื่อ client ถูกปฏิเสธ · server resolve ด้วยสิทธิ์ (เลือก)
- **Tool:** query ใหม่ใน tool ถูกปฏิเสธ · ห่อ reader ของ route + parity test (เลือก)
- **Memory:** memory อัตโนมัติจากสรุปสนทนา (write ของ AI + PII สะสม) ไม่เลือก · pinned fact ที่คนสร้าง + บริบทกะเป็น tool (เลือก) · memory ร่วมของกะ (ข้ามคนไม่ผ่าน RBAC) ไม่เลือก
- **Streaming:** token streaming (ข้ามการตรวจ citation/redaction) ไม่เลือก · WebSocket ไม่เลือก · SSE แบบ phase (เลือก) · polling ไม่เลือก
- **Concurrency:** เพิ่ม slot api (แย่ง worker) ไม่เลือก · ส่งผ่าน queue worker (ADR-023 ปฏิเสธแล้ว) · `facts_only` + call เดียว + cap ฝั่ง worker (เลือก)

## Consequences
- งานที่ตามมา → `docs/BACKLOG.md` §Jarvis stage 1 (T-400…T-412)
- ที่ยอมเสีย: assistant ที่ใช้ LLM ได้ครั้งละ 1 turn ทั้ง instance (มีคิวและตำแหน่ง) · ไม่ไหลเป็น token · audit/credential ถามไม่ได้
- ตรวจซ้ำเมื่อ: วัด latency จริงบน POC (เป้า p50 `facts_only` < 1 s, `llm1` < 12 s, รวม p95 ≤ 40 s `[ASSUMED]`) · api > 1 replica · เพิ่ม slot bridge · เปิด stage 2/3 · `security-reviewer` ขอ encryption ของ `assistant_memory`
- `[ASK-HUMAN]` ที่ค้าง: เพิ่ม `CLAUDE_CLI_BRIDGE_MAX_CONCURRENCY` เกิน 4 (ขึ้นกับข้อจำกัด subscription `[VERIFY]`) · อนุมัติเคส eval ของ assistant เข้า `evals/golden/` · ทดสอบ injection กับ live provider

## Links
- PRD §6.1, §6.2, §6.3, §6.6 · ADR-002, 008, 011, 013, 016, 017, 019, 021, 023 · `apps/api/src/assistant/`, `packages/ai/src/agents/assistant.ts`, `apps/api/src/ai/concurrency-limit.ts`, `tools/claude-cli-bridge/bridge.mjs` (อ่าน 2026-11-05)
- `claude -p --output-format stream-json` — เอกสาร Claude Code CLI `[VERIFY]` · SSE ผ่าน Caddy `reverse_proxy` (flush) และ Cloud Run request timeout `[VERIFY]`
