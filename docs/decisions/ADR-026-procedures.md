# ADR-026 — Procedures ต่อ intent: steps แบบ Zod, NL→steps (AI ร่าง คนยืนยัน), version + simulation ก่อน publish (T-303a)

- **Status:** **Accepted 2026-11-05** (security review T-306a: C-7 simulation stage 2+3 แก้ใน T-306f, ตรวจซ้ำ T-306j ปิด) · ร่างโดย `architect` 2026-11-04
- **Date:** 2026-11-04 (เวลากรุงเทพ) · **ผู้ตัดสิน:** main thread
- **Context:** PRD §6.3 procedure ต่อ intent เขียน NL โดย lead/head → compile เป็น step list มี version (investigation, disclosure, reply guideline, escalate, AI ทำอะไรได้ต่อ stage) และ simulate กับ ticket เก่าก่อน publish · §6.5 replay eval เมื่อ procedure เปลี่ยน · ADR-013 §2 runbook = `planRunbook()` ที่โค้ดสร้าง model ไม่เลือก tool ไม่มี tool loop · ADR-016 template logs/data ค่า literal/bind · schema: `intent.procedure_version_id uuid` (0002, ไม่มี FK), `ai_run` ไม่มี procedure version `[TESTED: อ่าน migration]` · boundary: `packages/ai` ไม่รู้จัก DB/HTTP, `packages/shared` pure

## Decision
### 1. ขยาย runbook ของ ADR-013 ไม่ใช่แทน
`planRunbook(context, granted, procedure?)` ไม่มี procedure = ลำดับ default เดิมทุกตัว (test ยืนยัน) · มี procedure = step `tool` ตามลำดับ ∩ `granted` (`intent.allowed_tools` ∩ allow-list ต่อ stage) · procedure **จำกัดหรือเรียงใหม่ได้เท่านั้น**: เพิ่ม tool ไม่ได้, ใส่ข้อความอิสระใน input ไม่ได้, ผ่อน disclosure ไม่ได้, ยก stage ไม่ได้ · model ยังไม่เลือก tool

### 2. Schema (`packages/shared/src/procedure.ts`, Zod, `schemaVersion: 1`)
`ProcedureSteps = { schemaVersion: 1, autosend: 'allowed'|'never', steps: Step[] }` ≤ 20 step, tool ≤ 8, ข้อความรวม ≤ 8 KB, `strictObject`, step id เป็น slug ไม่ซ้ำ · `Step` union ตาม `kind`:
- `tool` `{ id, tool: enum(TOOL_NAMES), template?, params?: { limit 1..20, windowMinutes 5..1440, windowHours 1..72 }, when?, stages? }` ไม่มีช่อง query/ข้อความ
- `check` `{ id, question ≤300, evidenceFrom: stepId[] }` → คำตอบใน report (internal)
- `reply_guideline` `{ id, text ≤1000, lang? }` → drafter block แยก ลำดับต่ำกว่ากฎความปลอดภัยของระบบ
- `disclosure` `{ id, rule: 'never_mention'|'verified_only', topic ≤200 }` เข้มขึ้นได้อย่างเดียว ทำงานหลังกฎโค้ด
- `escalate` `{ id, when, to: { queueKey } | { role: 'lead'|'head' }, priority?, note ≤300 }`
- `require_human` `{ id, when, reason ≤200 }` → draft ของ ticket นั้น auto-send ไม่ได้ (ADR-025 เงื่อนไข 11)
- `Condition = { all?: Clause[], any?: Clause[] }`, `Clause = { field: enum(classifier.confidence, ticket.priority, ticket.channel, org.tier, contact.verified, evidence.count, investigation.hasLikelyCause, ticket.reopenCount), op: eq|neq|gte|lte|in, value }` ประเมินด้วยโค้ด pure (ไม่มี expression string)

### 3. NL → steps (AI ร่าง คนยืนยัน)
`source_md` (≤ 8 KB) **redact ก่อนส่ง LLM** (N4) → agent `procedure_compiler` (tier standard ผ่าน `createAuditedLlm`) → Zod · kill switch เปิด = compile ไม่ได้ แต่เขียน steps เองได้ · semantic validation (pure ใน `packages/domain`): tool ⊆ allowed, template/queue มีจริง, `evidenceFrom` อ้าง step ก่อนหน้า, ไม่มี step ตาย · UI: NL ข้าง steps + diff กับ version ที่ publish · คนกดยืนยัน (`confirmed_by`) · **steps คือสิ่งที่รัน NL เป็นเอกสาร**

### 4. Version + publish
- `procedure (id, intent_id UNIQUE, created_by, created_at, archived_at)` · `procedure_version (id, procedure_id, version, status draft|confirmed|simulated|published|retired, source_md, steps jsonb, schema_version, steps_hash (DB คำนวณ), compiled_by_ai_run_id, authored_by, confirmed_by/at, simulation_id, published_by/at, retired_at)` · `UNIQUE(procedure_id, version)` + partial unique published
- ออกจาก draft แล้วแก้ไม่ได้ (trigger) · app role ไม่มี DELETE
- publish ผ่าน `publish_procedure_version()` SECURITY DEFINER เท่านั้น: ต้อง `simulated` + ผ่าน, simulation ของ `steps_hash` เดียวกันอายุ ≤ 30 วัน `[ASSUMED]`, retire version เดิม, ตั้ง `intent.procedure_version_id` (เพิ่ม FK), audit · intent stage 3: ผู้ publish ≠ ผู้ยืนยัน `[ASSUMED]` · rollback = publish version เก่า (simulation ต้องยังไม่หมดอายุ)
- สิทธิ์ `procedure.author`, `procedure.publish` (lead, head) `[ASSUMED]`

### 5. ผูก intent/stage
step มี `stages` · stage 0 ไม่ส่ง guideline · **`autosend: 'never'` เป็นค่าเริ่มต้น** · `ai_run.procedure_version_id` (T-303c) · draft จาก version ที่ไม่ได้ publish อยู่ = auto-send ไม่ได้ (`procedure_stale`)

### 6. Simulation ก่อน publish (runner T-302c)
ชุดข้อมูล `eval_case` ของ intent + ticket resolve N ล่าสุด (30 `[ASSUMED]`) ที่ `seed_batch_id IS NULL` (ไม่พอใช้ seed ได้แต่ติดป้ายและใช้ publish intent stage 3 ไม่ได้) · CI ใช้ fixture · instance ใช้ tool read-only จริงผ่าน budget bucket `simulation` + เพดานต่อรัน · เทียบคำตอบคน (edit distance), version ปัจจุบัน, grader · ผ่าน = violation 0, disclosure leak 0, uncited ≤ ปัจจุบัน, edit distance แย่ลง ≤ 5 จุด `[ASSUMED]`, ทุก step ทำงานได้ · ผลใน `eval_result` (+ `procedure_version_id`, `simulation_id`) และ `procedure_simulation` append-only

### 7. Write action (N2)
`escalate` = proposal card กด 1 ครั้ง (แบบ ADR-023) รันผ่าน service + RBAC ด้วยตัวตนคนกด audit `via=procedure` · AI ทำเองได้แค่ `ai_internal` ตาม ADR-011 · tool ใน procedure read-only + budget ADR-013 §4

### 8. Audit
`procedure.created|compiled|confirmed|simulated|published|retired` (metadata id/hash/version เท่านั้น) · ticket_event `procedure.escalation_proposed`, `procedure.require_human` · publish → replay eval อัตโนมัติ (T-302d) regression บล็อก auto-send ของ intent stage 3 โดยไม่ rollback

### 9. Boundary
shared: Zod + `evaluateCondition()` · ai: `procedure_compiler`, `planRunbook(…, procedure)`, guideline เข้า drafter · domain: validation, CRUD, publish · api: `/v1/intents/:id/procedure/versions…` · worker: queue `procedure-simulate`

### 10. ความหมายของ `escalate` (main thread ตัดสิน 2026-11-04 หลัง T-303c)
- `to: { queueKey }` → proposal "ย้ายไปคิว X" (+ priority ถ้าระบุ) · กดแล้วเรียก service update ticket เดิม เปลี่ยนคิว **คง assignee เดิม** (คนในคิวใหม่ re-assign เอง) · audit `via=procedure`
- `to: { role: 'lead'|'head' }` → proposal "ขอ lead/head ดู" · กดแล้วส่ง notification severity high ถึงผู้มี role นั้นที่อยู่กะ (ไม่มีใครอยู่กะ = ทุกคนใน role) + internal note ที่มี `note` ของ step · **ไม่ assign อัตโนมัติ** · ใส่ priority ถ้าระบุ
- ผู้กดต้องมี `ticket.handle` · proposal หมดอายุเมื่อ version ของ procedure เปลี่ยนหรือ ticket ปิด
- `check` ที่ไม่มี tool step ที่รันจริงจะไม่ถูกถาม · procedure ที่ไม่มี tool step ใช้ default runbook (ตามที่ T-303c ทำ)

## Options considered
A procedure แทน runbook — intent ที่ไม่มี procedure ไม่มี investigation · ตัด · B agentic tool loop — ทำลายการกัน injection ของ ADR-013, ขัด N2 · ตัด · C DSL expression string (CEL/JSONLogic) — dependency + parser attack surface · ตัด · **D (เลือก)**

## Consequences
intent ไม่มี procedure ทำงานเหมือนเดิม · stage 3 ต้องมี procedure · simulation มีต้นทุน → bucket แยก · งานตามมา T-303b–e (`examples/procedures/` เป็นตัวอย่างกลาง N1) · ตรวจซ้ำเมื่อเพิ่ม tool ที่เขียนได้, stage 4, procedure ร่วมหลาย intent, schemaVersion 2

## Links
PRD §6.3–6.5 · BACKLOG T-302c/d, T-303a–e, T-304 · ADR-008, ADR-011, ADR-013 §2/§6, ADR-016, ADR-023, ADR-025 · `packages/ai/src/agents/investigate.ts`, migration 0002, 0010
